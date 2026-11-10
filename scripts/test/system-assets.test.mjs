import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { startSkillPackagingFixture } from './skill-packaging.fixture.mjs';

const requireCatalog = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const { readBundledCatalog } = requireCatalog('../shared/bundled-catalog.cjs');

/**
 * Epic 12, story 12.1 — явный REQUIRED-набор системных ассетов.
 *
 * Интеграционный сценарий на реальном admin-импорте:
 *  1. REQUIRED-набор (12) читается из того же источника истины, что и сервис;
 *     из них 9 (skill + agent) входят в index и импортируются через
 *     /api/asset-imports — реальный импортный конвейер. mcp/plugin/bridge —
 *     вне-индексные поставки (packaging/bridge-flow), в сценарии они ещё не
 *     импортированы: проверяется, что их отсутствие = ЯВНОЕ «не готово»,
 *     а не тихая деградация, и что создание проекта при этом не падает.
 *  2. Создание проекта — автоназначение импортированного REQUIRED-набора.
 *  3. system-readiness: готовое/неготовое состояние по каждому ассету.
 *  4. Запрет удаления системного ассета из проекта (409 с основанием).
 *  5. Модельные и пользовательские ассеты в проект не подставляются.
 */
test(
    'Required system assets: auto-assignment, removal guard, readiness, model/user exclusion',
    { skip: !process.env.CATALOG_TEST_PG_URL, timeout: 240000 },
    async (t) => {
        const f = await startSkillPackagingFixture({ adminUrl: process.env.CATALOG_TEST_PG_URL });
        t.after(async () => {
            await f.close();
        });

        // REQUIRED-набор из того же источника истины, что и сервис.
        const bundle = await readBundledCatalog();
        const commit = bundle.pin.commit;
        const current = bundle.manifest.current;
        const required = current.filter((row) => row.system === true && row.required === true);
        const requiredIds = required.map((row) => row.id);
        // Индексная часть набора — то, что проходит /api/asset-imports.
        const indexRequired = required.filter((row) => row.kind === 'skill' || row.kind === 'agent');
        const projectRequired = required.filter((row) => row.kind !== 'bridge');
        const modelIds = current.filter((row) => row.kind === 'model').map((row) => row.id);
        assert.equal(requiredIds.length, 12, 'REQUIRED-набор содержит ровно 12 ассетов');
        assert.equal(projectRequired.length, 11, 'Проектный набор = 11 (без bridge)');
        assert.equal(indexRequired.length, 9, 'Индексная часть REQUIRED-набора = 9 (4 skill + 5 agent)');

        const terminal = async (id) => {
            for (let i = 0; i < 900; i++) {
                const job = await f.request('main', '/api/asset-imports/' + id);
                if (['SUCCEEDED', 'FAILED', 'NEEDS_INPUT', 'PARTIAL', 'CANCELLED'].includes(job.state)) return job;
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
            throw Error('Импорт не завершён за отведённое время.');
        };
        const nativeId = async (externalId, kind) =>
            (
                await f.pool.query(
                    'SELECT native_id FROM asset_source_receipts WHERE repository=$1 AND external_id=$2 AND asset_kind=$3 AND active',
                    ['app-bundled', externalId, kind],
                )
            ).rows[0]?.native_id;

        // 1. Реальный admin-импорт индексной части REQUIRED-набора.
        const job = await f.request('main', '/api/asset-imports', {
            method: 'POST',
            status: 201,
            body: { requestKey: randomUUID(), ids: indexRequired.map((row) => row.id), commit },
        });
        const finished = await terminal(job.id);
        assert.equal(finished.state, 'SUCCEEDED', JSON.stringify(finished.items, null, 2));

        // 2. Создание проекта — автоназначение импортированного REQUIRED-набора.
        const project = await f.request('main', '/api/projects', {
            method: 'POST',
            status: 201,
            body: { name: 'System Assets QA' },
        });

        const expectedAssets = await Promise.all(
            indexRequired
                .filter((row) => row.kind !== 'agent')
                .map(async (row) => ({
                    externalId: row.id,
                    kind: row.kind,
                    subsystem: row.subsystem,
                    nativeId: await nativeId(row.id, row.kind),
                })),
        );
        const expectedAgents = await Promise.all(
            indexRequired
                .filter((row) => row.kind === 'agent')
                .map(async (row) => ({ externalId: row.id, subsystem: row.subsystem, nativeId: await nativeId(row.id, 'agent') })),
        );
        for (const row of [...expectedAssets, ...expectedAgents])
            assert.ok(row.nativeId, `Native-карточка не опубликована для ${row.externalId}`);

        await t.test('проект получает 4 системных скилла с pin_origin=assigned', async () => {
            const assets = (
                await f.pool.query('SELECT asset_id,asset_kind,pin_origin,added_by FROM project_assets WHERE project_id=$1', [
                    project.id,
                ])
            ).rows;
            const expectedIds = new Set(expectedAssets.map((row) => row.nativeId));
            assert.equal(assets.length, expectedAssets.length, JSON.stringify(assets));
            for (const row of assets) {
                assert.equal(row.pin_origin, 'assigned', JSON.stringify(row));
                assert.equal(row.added_by, 'system:catalog', 'Назначает каталог, а не человек');
                assert.ok(expectedIds.has(row.asset_id), 'Лишнее назначение: ' + row.asset_id);
            }
            for (const expected of expectedAssets)
                assert.ok(
                    assets.some((row) => row.asset_id === expected.nativeId && row.asset_kind === expected.kind),
                    'Не назначен: ' + expected.externalId,
                );
        });

        await t.test('проект получает 5 системных агентов', async () => {
            const agents = (
                await f.pool.query(
                    'SELECT agent_id,version,manifest,added_by FROM project_agents WHERE project_id=$1 AND NOT removed',
                    [project.id],
                )
            ).rows;
            assert.equal(agents.length, expectedAgents.length, JSON.stringify(agents));
            for (const row of agents) assert.equal(row.added_by, 'system:catalog');
            for (const expected of expectedAgents)
                assert.ok(agents.some((row) => row.agent_id === expected.nativeId), 'Не назначен агент: ' + expected.externalId);
        });

        await t.test('system-readiness: 9 assigned + 2 явно unpublished (mcp/plugin не импортированы), bridge вне списка', async () => {
            const readiness = await f.request('main', `/api/projects/${project.id}/system-readiness`);
            assert.equal(readiness.status, 'not-ready', JSON.stringify(readiness));
            assert.equal(readiness.assets.length, projectRequired.length, 'Видны все 11 project-level ассетов');
            for (const row of readiness.assets) {
                assert.ok(
                    ['assigned', 'unpublished', 'unassigned'].includes(row.state),
                    'Явное состояние: ' + JSON.stringify(row),
                );
            }
            for (const expected of [...expectedAssets, ...expectedAgents]) {
                const found = readiness.assets.find((row) => row.id === expected.externalId);
                assert.ok(found, 'Ассет в отчёте: ' + expected.externalId);
                assert.equal(found.state, 'assigned', JSON.stringify(found));
                assert.equal(found.subsystem, expected.subsystem);
            }
            for (const id of ['mcp-opencode-rag', 'plugin-opencode-rag-plugin']) {
                const found = readiness.assets.find((row) => row.id === id);
                assert.ok(found, 'Ассет в отчёте: ' + id);
                assert.equal(found.state, 'unpublished', 'Не импортировано = явный unpublished: ' + JSON.stringify(found));
            }
            // bridge — device-level, в проектную готовность не входит.
            assert.ok(!readiness.assets.some((row) => row.id === 'neurocenter-bridge'));
        });

        await t.test('модельные ассеты не назначаются проекту и не несут маркеров', async () => {
            assert.ok(modelIds.length >= 1, 'В каталоге есть модельные ассеты');
            for (const id of modelIds) {
                const row = current.find((r) => r.id === id);
                assert.equal(row.system, undefined, id + ' не входит в required-набор');
                assert.equal(row.required, undefined, id + ' не входит в required-набор');
                const native = await nativeId(id, 'model');
                const inProject =
                    (await f.pool.query('SELECT 1 FROM project_assets WHERE project_id=$1 AND asset_id=$2', [
                        project.id,
                        native ?? id,
                    ])).rowCount > 0 ||
                    (await f.pool.query('SELECT 1 FROM project_agents WHERE project_id=$1 AND agent_id=$2', [
                        project.id,
                        native ?? id,
                    ])).rowCount > 0;
                assert.equal(inProject, false, `Модельный ассет ${id} не должен попадать в проект`);
            }
        });

        await t.test('у пользовательских (несистемных) ассетов нет маркеров и автоназначения', async () => {
            const userAssets = current.filter((row) => !requiredIds.includes(row.id) && row.kind !== 'model');
            assert.ok(userAssets.length >= 1, 'В каталоге есть пользовательские ассеты');
            for (const row of userAssets) {
                assert.equal(row.system, undefined, `У ${row.id} не должно быть маркера system`);
                assert.equal(row.required, undefined, `У ${row.id} не должно быть маркера required`);
                const native = await nativeId(row.id, row.kind);
                if (!native) continue;
                const assigned =
                    (await f.pool.query('SELECT 1 FROM project_assets WHERE project_id=$1 AND asset_id=$2', [
                        project.id,
                        native,
                    ])).rowCount > 0;
                assert.equal(assigned, false, `Пользовательский ассет ${row.id} не должен назначаться`);
            }
        });

        await t.test('удаление системного скилла из проекта — явная 409 с основанием', async () => {
            const skill = expectedAssets[0];
            const response = await f.request('main', `/api/projects/${project.id}/assets`, {
                method: 'DELETE',
                status: 409,
                body: { assetId: skill.nativeId, assetKind: skill.kind },
            });
            assert.match(response.message, /нельзя удалить/);
            assert.match(response.message, new RegExp(skill.subsystem), 'В основании указана подсистема');
            const still = (
                await f.pool.query('SELECT 1 FROM project_assets WHERE project_id=$1 AND asset_id=$2', [
                    project.id,
                    skill.nativeId,
                ])
            ).rowCount;
            assert.equal(still, 1, 'Системный ассет не удалён');
        });

        await t.test('удаление системного агента из проекта — явная 409 с основанием', async () => {
            const agent = expectedAgents[0];
            const revision = (
                await f.pool.query('SELECT revision FROM project_agent_sets WHERE project_id=$1', [project.id])
            ).rows[0].revision;
            const response = await f.request('main', `/api/projects/${project.id}/agents/${agent.nativeId}`, {
                method: 'DELETE',
                status: 409,
                body: { requestKey: randomUUID(), expectedRevision: revision },
            });
            assert.match(response.message, /нельзя удалить/);
            assert.match(response.message, new RegExp(agent.subsystem), 'В основании указана подсистема');
            const still = (
                await f.pool.query(
                    'SELECT 1 FROM project_agents WHERE project_id=$1 AND agent_id=$2 AND NOT removed',
                    [project.id, agent.nativeId],
                )
            ).rowCount;
            assert.equal(still, 1, 'Системный агент не удалён');
        });

        // 3. Контроль: проект, созданный ДО импорта, не получает автоназначение,
        //    но его system-readiness честно показывает not-ready с явными причинами.
        await t.test('проект без импортированного набора — not-ready с явными причинами', async () => {
            // prj-qa-packaging создан фикстурой напрямую в SQL (до импорта).
            const readiness = await f.request('main', `/api/projects/${f.projectId}/system-readiness`);
            assert.equal(readiness.status, 'not-ready', JSON.stringify(readiness));
            const states = readiness.assets.map((row) => row.state);
            assert.ok(states.every((state) => ['assigned', 'unpublished', 'unassigned'].includes(state)));
        });
    },
);
