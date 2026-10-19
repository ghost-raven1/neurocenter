// Реальный PostgreSQL вычисляет сводку только над CTE: рабочая таблица не читается и не меняется.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { Pool } = require('pg');
const { OperationRepository } = require(path.join(root, 'services/catalog-service/dist/operations/operation-repository.js'));
const pool = new Pool({ connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog' });
const fixture = `WITH operations AS (
    SELECT input.*, 'SYNC'::text AS type, 'bridge'::text AS resource_type,
           operation_id AS resource_id, 0::bigint AS bytes_done, 0::bigint AS bytes_total,
           '2026-10-18T05:00:00Z'::timestamptz AS created_at,
           NULL::timestamptz AS started_at, NULL::timestamptz AS finished_at,
           NULL::text AS error, '[]'::jsonb AS log, 0 AS retries
    FROM (VALUES
        ('a-running', 'prj-a', 'RUNNING', 20, 'owner@example.test'),
        ('a-queued', 'prj-a', 'QUEUED', 0, 'other@example.test'),
        ('a-done', 'prj-a', 'SUCCEEDED', 100, 'other@example.test'),
        ('b-running', 'prj-b', 'RUNNING', 80, 'other@example.test'),
        ('b-failed', 'prj-b', 'FAILED', 90, 'other@example.test'),
        ('c-running', 'prj-c', 'RUNNING', 140, 'foreign@example.test'),
        ('d-running', 'prj-d', 'RUNNING', -50, 'owner@example.test')
    ) AS input(operation_id, project_id, state, percent, actor)
) `;
const repository = new OperationRepository({ query: (sql, params) => pool.query(fixture + sql, params) });
const results = [];

async function check(name, run) {
    try {
        await run();
        results.push({ case: name, ok: true });
    } catch (error) {
        results.push({ case: name, ok: false, error: error.message });
    }
}

try {
    await check('Сводка учитывает все страницы и ограничивает некорректные проценты до усреднения', async () => {
        const page = await repository.list(1, 1);
        assert.equal(page.items.length, 1);
        assert.equal(page.total, 7);
        assert.equal(page.activeCount, 5);
        assert.deepEqual(page.activeProgress, { percent: 40, running: 4, queued: 1 });
        assert.deepEqual((await repository.list(3, 1)).activeProgress, page.activeProgress);
    });
    await check('Проектная область исключает чужую активность', async () => {
        const page = await repository.list(1, 20, ['prj-a']);
        assert.equal(page.total, 3);
        assert.deepEqual(page.activeProgress, { percent: 10, running: 1, queued: 1 });
    });
    await check('Личная история доступна без проектов и не расширяет область до чужих заданий', async () => {
        const page = await repository.list(1, 20, [], undefined, 'owner@example.test');
        assert.equal(page.total, 2);
        assert.deepEqual(page.activeProgress, { percent: 10, running: 2, queued: 0 });
    });
    await check('Фильтр состояния ограничивает сводку вместе со списком', async () => {
        const page = await repository.list(1, 1, ['prj-a', 'prj-b'], 'RUNNING');
        assert.equal(page.total, 2);
        assert.equal(page.activeCount, 2);
        assert.deepEqual(page.activeProgress, { percent: 50, running: 2, queued: 0 });
    });
    await check('Завершённое состояние возвращает нулевую активность', async () => {
        const page = await repository.list(1, 20, ['prj-b'], 'FAILED');
        assert.equal(page.total, 1);
        assert.equal(page.activeCount, 0);
        assert.deepEqual(page.activeProgress, { percent: 0, running: 0, queued: 0 });
    });
    await check('Пустая область возвращает числовые нули', async () => {
        const page = await repository.list(1, 20, []);
        assert.equal(page.total, 0);
        assert.deepEqual(page.activeProgress, { percent: 0, running: 0, queued: 0 });
    });
    await check('Дробный средний процент не округляется на сервере', async () => {
        const page = await repository.list(1, 20, ['prj-a', 'prj-b']);
        assert.equal(page.activeProgress.running, 2);
        assert.equal(page.activeProgress.queued, 1);
        assert.ok(Math.abs(page.activeProgress.percent - 100 / 3) < 0.000001);
    });
} finally {
    await pool.end();
}

const report = { results, passed: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length };
const reportPath = process.env.OPERATIONS_PROGRESS_REPORT || path.join(root, '.run/operations-progress/summary-database.json');
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
if (report.failed) { process.exitCode = 1; }
