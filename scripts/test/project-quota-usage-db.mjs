/**
 * Персистентный per-project used-bytes accounting (AD-D4) на одноразовой БД
 * каталога: миграция 53, идемпотентность, конкурентность, floor, каскад, bypass.
 * Только явно выделенный loopback PostgreSQL на нестандартном порту.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { ownedTestPostgresAdmin } from './owned-postgres.fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)),
    adminUrl = ownedTestPostgresAdmin(process.env.PROJECT_QUOTA_USAGE_TEST_PG_URL).href;
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata');
require('ts-node').register({
    transpileOnly: true,
    project: path.join(root, 'services/catalog-service/tsconfig.json'),
});
const { Pool } = require('pg'),
    load = (file) => require(path.join(root, 'services/catalog-service/src', file));
const { CATALOG_MIGRATIONS } = load('database/catalog-migrations.ts'),
    { assertCurrentCatalogSchema } = load('database/current-schema-verification.ts'),
    { CatalogDb } = load('catalog/catalog-db.ts'),
    { ModelsService } = load('models/models.service.ts'),
    { ProjectQuotaUsageService } = load('project-quota-usage/quota-usage.service.ts');

const MB = 1024 * 1024;
const admin = new Pool({ connectionString: adminUrl, max: 1, statement_timeout: 30000 });
const database = 'nc_quota_usage_test_' + randomUUID().replaceAll('-', '');
const receipt = {
    port: Number(new URL(adminUrl).port),
    databaseDropped: false,
    cases: [],
};
let adminDbPool,
    created = false,
    db,
    models;
const check = (name, value) => {
    receipt.cases.push({ name, value });
};
const dbPoolEnd = async (item) => {
    try {
        await item?.pool?.end?.();
    } catch {
        // Пул уже закрыт или не создан — DROP DATABASE не должен упасть.
    }
};

try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const url = new URL(adminUrl);
    url.pathname = '/' + database;
    process.env.CATALOG_PG_URL = url.href;
    process.env.NODE_ENV = 'production';

    adminDbPool = new Pool({ connectionString: url.href, max: 4, statement_timeout: 30000 });
    db = new CatalogDb(url.href);
    await db.setup();
    models = new ModelsService(null, null);
    const usage = new ProjectQuotaUsageService(models);

    // Миграция 53 в ledger, схема подтверждена assert'ом.
    const ledger = (
        await adminDbPool.query('SELECT version, name FROM catalog_schema_migrations WHERE version=53')
    ).rows;
    assert.equal(ledger.length, 1, 'migration53 в ledger');
    assert.equal(ledger[0].name, 'project-quota-usage-accounting');
    await assertCurrentCatalogSchema(adminDbPool);
    check('migration53 + assertCurrentCatalogSchema', 'ok');

    const project = await db.createProject({
        name: 'quota-case',
        quotas: { currentBytesLimit: 1000, retentionBytesLimit: 200 * MB },
    });

    // Пустой проект: счётчики нули, лимиты из settings.
    let detail = await db.getProject(project.id);
    assert.deepEqual(detail.quota.currentBytesUsed, 0);
    assert.deepEqual(detail.quota.retentionBytesUsed, 0);
    assert.deepEqual(detail.quota.stagingBytesUsed, 0);
    assert.equal(detail.quota.currentBytesLimit, 1000);
    assert.equal(detail.quota.retentionBytesLimit, 200 * MB);
    check('пустой проект: used=0, лимиты из settings', 'ok');

    // 50MB retention → GET показывает used.
    const FIFTY_MB = 50 * MB;
    assert.deepEqual(await usage.record(project.id, { dimension: 'retention', deltaBytes: FIFTY_MB, request_key: 'intent:t1' }), { used: FIFTY_MB });
    detail = await db.getProject(project.id);
    assert.equal(detail.quota.retentionBytesUsed, FIFTY_MB);
    check('50MB retention → GET quota.retentionBytesUsed', 'ok');

    // Replay тем же request_key: без дубля.
    assert.deepEqual(await usage.record(project.id, { dimension: 'retention', deltaBytes: FIFTY_MB, request_key: 'intent:t1' }), { used: FIFTY_MB });
    const receipts = (await adminDbPool.query('SELECT count(*)::int AS n FROM project_quota_usage_requests WHERE project_id=$1', [project.id])).rows[0].n;
    assert.equal(receipts, 1, 'одна квитанция на повтор');
    check('replay идемпотентен', 'ok');

    // Конкурентные дельты суммируются.
    await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
            usage.record(project.id, { dimension: 'current', deltaBytes: MB, request_key: `intent:concurrent-${index}` }),
        ),
    );
    detail = await db.getProject(project.id);
    assert.equal(detail.quota.currentBytesUsed, 10 * MB);
    check('10 конкурентных +1MB = 10MB', 'ok');

    // used > limit: accounting не ограничивает лимитом (лимит — политика writers).
    assert.deepEqual(await usage.record(project.id, { dimension: 'staging', deltaBytes: 5000, request_key: 'intent:over' }), { used: 5000 });
    detail = await db.getProject(project.id);
    assert.equal(detail.quota.stagingBytesUsed, 5000);
    check('used>limit — факт сохраняется', 'ok');

    // Floor: отрицательная дельта не ниже нуля.
    assert.deepEqual(await usage.record(project.id, { dimension: 'staging', deltaBytes: -10 * MB, request_key: 'intent:floor' }), { used: 0 });
    detail = await db.getProject(project.id);
    assert.equal(detail.quota.stagingBytesUsed, 0);
    check('floor 0', 'ok');

    // limit=0 → unlimited: без квот в settings used учитывается.
    const unlimited = await db.createProject({ name: 'quota-unlimited' });
    assert.equal((await db.getProject(unlimited.id)).quota.currentBytesLimit, 0);
    assert.deepEqual(await usage.record(unlimited.id, { dimension: 'current', deltaBytes: 7 * MB, request_key: 'intent:unlimited' }), { used: 7 * MB });
    assert.equal((await db.getProject(unlimited.id)).quota.currentBytesUsed, 7 * MB);
    check('limit=0 — unlimited', 'ok');

    // Bypass: прямое изменение данных без accounting-вызова не меняет счётчик.
    await adminDbPool.query('UPDATE projects SET logical_bytes=$2 WHERE id=$1', [project.id, 99999]);
    detail = await db.getProject(project.id);
    assert.equal(detail.logicalBytes, 99999);
    assert.notEqual(detail.quota.currentBytesUsed, 99999);
    check('bypass-запись: расхождение детектируется', 'ok');

    // 404: неизвестный проект.
    await assert.rejects(
        usage.record('prj-ghost', { dimension: 'current', deltaBytes: 1, request_key: 'k' }),
        (error) => error?.getStatus?.() === 404 || error?.status === 404,
    );
    check('404 неизвестный проект', 'ok');

    // Каскад: удаление проекта стирает счётчики и квитанции.
    const deleted = await db.deleteProject(project.id);
    assert.equal(deleted, true);
    const leftover = (
        await adminDbPool.query(
            'SELECT (SELECT count(*)::int FROM project_quota_usage WHERE project_id=$1) AS usage, (SELECT count(*)::int FROM project_quota_usage_requests WHERE project_id=$1) AS receipts',
            [project.id],
        )
    ).rows[0];
    assert.deepEqual(leftover, { usage: 0, receipts: 0 }, 'ON DELETE CASCADE');
    check('ON DELETE CASCADE: 0 строк после удаления', 'ok');
} catch (error) {
    receipt.failed = String(error && error.stack || error);
    throw error;
} finally {
    // TS-private пулы закрываются до DROP DATABASE: иначе сессии держат БД.
    await dbPoolEnd(db);
    await dbPoolEnd(models);
    await adminDbPool?.end();
    if (created) {
        await admin.query(`DROP DATABASE "${database}"`);
        receipt.databaseDropped = true;
    }
    await admin.end();
    const output = path.join(root, '.run/project-quota-usage-verification');
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'db-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(receipt, null, 2));
}
