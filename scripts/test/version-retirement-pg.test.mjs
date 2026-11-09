import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ownedTestPostgresAdmin } from './owned-postgres.fixture.mjs';

/**
 * Entry 2.7 (AD-16/FR-204): version-level retirement — PG-level checks.
 *
 *  - v56 DDL: `status` columns default to 'active'; the named CHECK constraints
 *    reject any other value (23514).
 *  - `PluginRepository.retireVersion`: irreversible retirement of an
 *    `ai_plugin_versions` row with a `security_events` audit entry; the row and
 *    artifact bytes stay in place (provenance); repeat retirement is a conflict.
 *  - `captureProjectAsset`: a retired head and a retired historical version are
 *    not assigned to new projects; an active version still passes.
 *  - `ModelsRepository.retireModelVersion` + `assign`: a retired model head
 *    revision is not assignable to projects.
 *
 * Тесты прогоняются на собственном PostgreSQL (fixture owned-postgres):
 *   PGPASSWORD=test CATALOG_TEST_PG_URL=postgresql://postgres@127.0.0.1:55433/postgres \
 *     node --test --test-concurrency=1 scripts/test/version-retirement-pg.test.mjs
 * Без переменной сьют честно пропускается. Загружает исходники каталога
 * (ts-node), свежие сборки dist не требуются.
 */
const ADMIN_URL = process.env.CATALOG_TEST_PG_URL;

if (ADMIN_URL) {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
    require('reflect-metadata');
    require('ts-node').register({
        transpileOnly: true,
        project: path.join(root, 'services/catalog-service/tsconfig.json'),
    });
    const { Pool } = require('pg');
    const load = (file) => require(path.join(root, 'services/catalog-service/src', file));
    const { CATALOG_MIGRATIONS } = load('database/catalog-migrations.ts');
    const { migrateCatalog } = load('database/migrations.ts');
    const { PluginRepository } = load('publication/plugin-repository.ts');
    const { ModelsRepository } = load('models/models.repository.ts');
    const { captureProjectAsset } = load('catalog/project-asset-pins.ts');

    const adminUrl = ownedTestPostgresAdmin(ADMIN_URL);
    const dbName = 'version_retirement_pg_' + randomUUID().replaceAll('-', '');
    const testUrl = new URL(adminUrl.href);
    testUrl.pathname = '/' + dbName;

    let pool,
        created = false;
    before(async () => {
        const admin = new Pool({ connectionString: adminUrl.href, max: 1, connectionTimeoutMillis: 5000 });
        await admin.query('CREATE DATABASE ' + dbName);
        created = true;
        await admin.end();
        const setup = new Pool({ connectionString: testUrl.toString(), max: 1, statement_timeout: 120000 });
        await migrateCatalog(setup, CATALOG_MIGRATIONS);
        await setup.end();
        pool = new Pool({ connectionString: testUrl.toString(), max: 4 });
    });
    after(async () => {
        await pool?.end();
        const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
        if (created) await admin.query('DROP DATABASE ' + dbName);
        await admin.end();
    });

    const ACTOR = 'pg-actor@retire.test';
    const CONFLICT = (error) => error.name === 'ConflictException';
    /** Минимальная mcp-карточка с version-строк(ами); files/config хранятся как есть. */
    async function pluginCard(id, name, version = 1) {
        const files = [{ path: 'server.cjs', content: '// ' + name }],
            config = { transport: 'stdio', command: 'node', entrypoint: 'server.cjs' };
        await pool.query('INSERT INTO ai_plugins(id,name,kind,version,config,files) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [
            id,
            name,
            'mcp',
            version,
            JSON.stringify(config),
            JSON.stringify(files),
        ]);
        for (let v = 1; v <= version; v++)
            await pool.query(
                'INSERT INTO ai_plugin_versions(ai_plugin_id,version,files,config,author,note) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)',
                [id, v, JSON.stringify(files), JSON.stringify(config), ACTOR, 'v' + v],
            );
    }
    /** Минимальная модель: карточка + ровно одна ревизия (head). */
    async function modelCard(id, name) {
        const descriptor = JSON.stringify({ runtime: 'custom', capability: 'completion', model: name });
        await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)', [id, name, descriptor]);
        await pool.query(
            'INSERT INTO model_catalog_versions(model_id,revision,name,descriptor,model_pin,created_at,updated_at) VALUES($1,1,$2,$3::jsonb,$4,now(),now())',
            [id, name, descriptor, 'a'.repeat(64)],
        );
    }
    const versionStatus = async (id, version) =>
        (await pool.query('SELECT status FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=$2', [id, version]))
            .rows[0]?.status;
    const retiredGate = /отозвана и не назначается в проекты/;

    test('v56 DDL: status по умолчанию active; именованный CHECK отклоняет любое другое значение', async () => {
        const pluginId = 'ai-plug-ddl-' + randomUUID();
        await pool.query('INSERT INTO ai_plugins(id,name) VALUES($1,$2)', [pluginId, 'DDL QA ' + pluginId.slice(-8)]);
        await pool.query("INSERT INTO ai_plugin_versions(ai_plugin_id,version,files) VALUES($1,1,'[]'::jsonb)", [
            pluginId,
        ]);
        assert.equal(await versionStatus(pluginId, 1), 'active', 'дефолт status — active');
        await assert.rejects(
            pool.query("INSERT INTO ai_plugin_versions(ai_plugin_id,version,files,status) VALUES($1,2,'[]'::jsonb,'bogus')", [
                pluginId,
            ]),
            (error) => error.code === '23514',
            'CHECK ai_plugin_versions_status_check обязан отклонить статус',
        );
        const modelId = 'model-ddl-' + randomUUID();
        await modelCard(modelId, 'DDL Model ' + modelId.slice(-8));
        assert.equal(
            (await pool.query('SELECT status FROM model_catalog_versions WHERE model_id=$1 AND revision=1', [modelId]))
                .rows[0].status,
            'active',
        );
        await assert.rejects(
            pool.query("UPDATE model_catalog_versions SET status='bogus' WHERE model_id=$1", [modelId]),
            (error) => error.code === '23514',
            'CHECK model_catalog_versions_status_check обязан отклонить статус',
        );
    });

    test('retireVersion: необратимый отзыв версии инструмента — аудит, провенанс, повтор запрещён', async () => {
        const repo = new PluginRepository(pool);
        const id = 'ai-plug-retire-' + randomUUID(),
            files = [{ path: 'server.cjs', content: '// retire target' }],
            config = JSON.stringify({ transport: 'stdio', command: 'node', args: ['server.cjs'] });
        await pool.query('INSERT INTO ai_plugins(id,name,kind,version,config,files) VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb)', [
            id,
            'Retire QA',
            'mcp',
            config,
            JSON.stringify(files),
        ]);
        await pool.query(
            "INSERT INTO ai_plugin_versions(ai_plugin_id,version,files,config,author) VALUES($1,1,$2::jsonb,$3::jsonb,'seed')",
            [id, JSON.stringify(files), config],
        );
        const retired = await repo.retireVersion(id, 1, ACTOR);
        assert.equal(retired.status, 'retired');
        assert.equal(await versionStatus(id, 1), 'retired');
        // Аудит: ровно одна запись security_events с переходом active→retired.
        const events = (
            await pool.query("SELECT actor,resource_id,before_state,after_state FROM security_events WHERE action='plugin.version.retire'")
        ).rows;
        assert.equal(events.length, 1);
        assert.equal(events[0].actor, ACTOR);
        assert.equal(events[0].resource_id, id + ':1');
        assert.equal(events[0].before_state.status, 'active');
        assert.equal(events[0].after_state.status, 'retired');
        // Повторный retire — конфликт с actionable-сообщением, статус не меняется.
        await assert.rejects(repo.retireVersion(id, 1, ACTOR), (error) => CONFLICT(error) && /необратим/.test(error.message));
        assert.equal(await versionStatus(id, 1), 'retired');
        // Провенанс: строка версии и байты артефакта сохраняются.
        const row = (
            await pool.query('SELECT files,config,author,note FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=1', [id])
        ).rows[0];
        assert.deepEqual(row.files, files);
        const version = await repo.version(id, 1);
        assert.equal(version.status, 'retired');
        assert.deepEqual(version.files, files);
        // Отсутствующая версия/карточка — null (служебный слой превратит в 404).
        assert.equal(await repo.retireVersion(id, 99, ACTOR), null);
        assert.equal(await repo.retireVersion('ai-plug-absent-' + randomUUID(), 1, ACTOR), null);
    });

    test('captureProjectAsset: retired head и retired историческая версия не назначаются; active проходит', async () => {
        const headId = 'ai-plug-head-' + randomUUID();
        await pluginCard(headId, 'Head Retire QA');
        await new PluginRepository(pool).retireVersion(headId, 1, ACTOR);
        await assert.rejects(captureProjectAsset(pool, headId, 'mcp'), (error) => CONFLICT(error) && retiredGate.test(error.message));
        const oldId = 'ai-plug-old-' + randomUUID();
        await pluginCard(oldId, 'Old Retire QA', 2);
        await new PluginRepository(pool).retireVersion(oldId, 1, ACTOR);
        // Head (v2) активна — назначение head допустимо...
        const headSnapshot = await captureProjectAsset(pool, oldId, 'mcp');
        assert.equal(headSnapshot.package.plugin.version, 2);
        // ...но явный запрос отозванной v1 — конфликт.
        await assert.rejects(captureProjectAsset(pool, oldId, 'mcp', 1), (error) => CONFLICT(error) && retiredGate.test(error.message));
        const activeId = 'ai-plug-active-' + randomUUID();
        await pluginCard(activeId, 'Active QA');
        const snapshot = await captureProjectAsset(pool, activeId, 'mcp');
        assert.equal(snapshot.package.plugin.id, activeId);
        assert.equal(snapshot.package.manifest.filesCount, 1);
    });

    test('модель: retireModelVersion — аудит и необратимость; assign retired head — конфликт', async () => {
        const repo = new ModelsRepository(pool);
        const modelId = 'model-retire-' + randomUUID();
        await modelCard(modelId, 'Retire Model QA');
        await repo.retireModelVersion(modelId, 1, ACTOR);
        assert.equal(
            (await pool.query('SELECT status FROM model_catalog_versions WHERE model_id=$1 AND revision=1', [modelId]))
                .rows[0].status,
            'retired',
        );
        const events = (
            await pool.query("SELECT actor,resource_id FROM security_events WHERE action='model.version.retire'")
        ).rows;
        assert.equal(events.length, 1);
        assert.equal(events[0].actor, ACTOR);
        assert.equal(events[0].resource_id, modelId + ':1');
        await assert.rejects(repo.retireModelVersion(modelId, 1, ACTOR), (error) => CONFLICT(error) && /необратим/.test(error.message));
        // Назначение модели с retired head — 409, строка назначения не пишется.
        const projectId = 'prj-retire-' + randomUUID();
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Retire QA Project']);
        await assert.rejects(repo.assign(projectId, modelId, ACTOR), (error) => CONFLICT(error) && retiredGate.test(error.message));
        assert.equal(
            (await pool.query('SELECT count(*)::int AS n FROM project_models WHERE project_id=$1 AND model_id=$2', [
                projectId,
                modelId,
            ])).rows[0].n,
            0,
        );
    });
} else {
    test('version-retirement PG: пропуск (CATALOG_TEST_PG_URL не задан)', { skip: true }, () => {});
}
