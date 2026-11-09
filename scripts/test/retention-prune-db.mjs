/**
 * AD-D3 (entry 5.8): retention prune — PostgreSQL-приёмка в изолированных scratch-БД.
 *
 * Два scratch-каталога: полный catalog-schema (MaintenanceService.onModuleInit → ensureCatalogSchema)
 * и rag-base (PLATFORM_QUOTA_SCHEMA из platform-quota-schema.ts). runRetentionPrune против реального
 * DDL: batched-DELETE, два прохода self-FK web_restore_jobs, NOT EXISTS-гарды, fresh-дети как
 * защита родителя, artifact-спецификация (deleted ∖ existing), RAG-down изоляция, smoke-проход
 * всех выражений полной retention-таблицы и idempotent-повтор (0).
 *
 * Запуск: TEST_ADMIN_PG_URL=postgresql://user:password@127.0.0.1:PORT/postgres node scripts/test/retention-prune-db.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRetentionTable, runRetentionPrune } from '../production/retention-prune.mjs';
import { ownedTestPostgresAdmin } from './owned-postgres.fixture.mjs';

const adminConnection = ownedTestPostgresAdmin(process.env.TEST_ADMIN_PG_URL).href;
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
require('ts-node').register({
    project: path.join(root, 'services/catalog-service/tsconfig.json'),
    transpileOnly: true,
});
const { Pool } = require('pg');
const { MaintenanceService } = require(
    path.join(root, 'services/catalog-service/src/maintenance/maintenance.service.ts'),
);
const { PLATFORM_QUOTA_SCHEMA } = require(
    path.join(root, 'services/rag-sync-service/src/rag/quota/platform-quota-schema.ts'),
);
const administration = new Pool({ connectionString: adminConnection });
const suffix = randomUUID().replaceAll('-', '');
const catalogDatabase = 'nc_verify_retention_catalog_' + suffix;
const ragDatabase = 'nc_verify_retention_rag_' + suffix;
const catalogUrl = new URL(adminConnection);
catalogUrl.pathname = '/' + catalogDatabase;
const ragUrl = new URL(adminConnection);
ragUrl.pathname = '/' + ragDatabase;
let createdCatalog = false,
    createdRag = false,
    pool,
    ragPool,
    service;
const cases = [];
const check = async (name, action) => {
    await action();
    cases.push({ name, passed: true });
};
const old = process.env.CATALOG_PG_URL;
try {
    await administration.query('CREATE DATABASE ' + catalogDatabase);
    createdCatalog = true;
    await administration.query('CREATE DATABASE ' + ragDatabase);
    createdRag = true;
    process.env.CATALOG_PG_URL = catalogUrl.href;
    pool = new Pool({ connectionString: catalogUrl.href, max: 6 });
    ragPool = new Pool({ connectionString: ragUrl.href, max: 4 });
    service = new MaintenanceService();
    await service.onModuleInit();
    await ragPool.query(PLATFORM_QUOTA_SCHEMA);
    /** psql -qAt-адаптер: по строке на результат, одна колонка; пустой результат — ''. */
    const text = async (sql, source = pool) =>
        (await source.query(sql)).rows.map((row) => String(Object.values(row)[0] ?? '')).join('\n');
    const query = (sql) => text(sql, pool);
    const queryRag = (sql) => text(sql, ragPool);
    const count = async (sql, source = pool, params) => Number((await source.query(sql, params)).rows[0].n);
    const resources = await loadRetentionTable(path.join(root, 'deploy/production/retention.json'));
    const subset = (names) => resources.filter((item) => names.includes(item.resource));
    const artifactStore = { remove: async () => ({ rowFiles: 0, orphanFiles: 0, orphans: [] }) };
    const skillsStore = { prune: async () => ({ deleted: 0 }) };
    const prune = (subsetNames, extra = {}) =>
        runRetentionPrune({
            resources: subset(subsetNames),
            catalogQuery: query,
            ragQuery: queryRag,
            artifactStore,
            skillsStore,
            ...extra,
        });

    const OLD30 = "now() - interval '40 days'";
    const OLD90 = "now() - interval '100 days'";
    const FRESH = 'now()';

    for (let i = 1; i <= 5; i += 1)
        await pool.query(
            'INSERT INTO security_events(event_id,actor,action,resource_id,created_at) VALUES ($1,$2,$3,$4,' +
                OLD90 +
                ')',
            [randomUUID(), 'fixture', 'fixture.batch' + i, 'security_events'],
        );
    await pool.query(
        'INSERT INTO security_events(event_id,actor,action,resource_id,created_at) VALUES ($1,$2,$3,$4,' + FRESH + ')',
        [randomUUID(), 'fixture', 'fixture.fresh', 'security_events'],
    );
    await check('security_events: batched 2/2/1 при batchLimit=2, свежие строки не трогает', async () => {
        for (const expected of [2, 2, 1]) {
            const report = await prune(['security_events'], { batchLimit: 2 });
            assert.equal(report.resources[0].deleted, expected);
        }
        assert.equal(await count("SELECT count(*) AS n FROM security_events WHERE action='fixture.fresh'"), 1);
        assert.equal(await count("SELECT count(*) AS n FROM security_events WHERE action LIKE 'fixture.batch%'"), 0);
    });

    const previewGuarded = randomUUID(),
        previewFree = randomUUID();
    await pool.query(
        'INSERT INTO legacy_retirement_previews(id,actor,digest,payload,expires_at) VALUES ($1,$2,$3,$4,' + OLD30 + ')',
        [previewGuarded, 'legacy@example.test', 'digest-1', '{}'],
    );
    await pool.query('INSERT INTO legacy_retirement_operations(id,actor,request_key,state) VALUES ($1,$2,$3,$4)', [
        previewGuarded,
        'legacy@example.test',
        randomUUID(),
        'succeeded',
    ]);
    await pool.query(
        'INSERT INTO legacy_retirement_previews(id,actor,digest,payload,expires_at) VALUES ($1,$2,$3,$4,' + OLD30 + ')',
        [previewFree, 'legacy@example.test', 'digest-2', '{}'],
    );
    await check(
        'legacy_retirement_previews: operation блокирует родителя, без операции родитель прунится',
        async () => {
            const report = await prune(['legacy_retirement_previews']);
            assert.equal(report.resources[0].deleted, 1);
            assert.equal(await count('SELECT count(*) AS n FROM legacy_retirement_previews'), 1);
            await pool.query('DELETE FROM legacy_retirement_operations WHERE id = $1', [previewGuarded]);
            const second = await prune(['legacy_retirement_previews']);
            assert.equal(second.resources[0].deleted, 1);
            assert.equal(await count('SELECT count(*) AS n FROM legacy_retirement_previews'), 0);
        },
    );

    const actorRestore = 'restore@example.test';
    const previewOld = randomUUID(),
        restoreOld = randomUUID(),
        previewFresh = randomUUID(),
        restoreFresh = randomUUID(),
        restoreOrphan = randomUUID();
    await pool.query(
        `INSERT INTO web_restore_jobs(id,actor,request_key,kind,input,input_hash,state,message,created_at)
         VALUES ($1,$2,$3,'preview','{}','hash-p1','ready','m',${OLD30})`,
        [previewOld, actorRestore, randomUUID()],
    );
    await pool.query(
        `INSERT INTO web_restore_jobs(id,actor,request_key,kind,input,input_hash,preview_id,state,message,created_at)
         VALUES ($1,$2,$3,'restore','{}','hash-r1',$4,'ready','m',${OLD30})`,
        [restoreOld, actorRestore, randomUUID(), previewOld],
    );
    await pool.query(
        `INSERT INTO web_restore_jobs(id,actor,request_key,kind,input,input_hash,state,message,created_at)
         VALUES ($1,$2,$3,'preview','{}','hash-p2','ready','m',${FRESH})`,
        [previewFresh, actorRestore, randomUUID()],
    );
    await pool.query(
        `INSERT INTO web_restore_jobs(id,actor,request_key,kind,input,input_hash,preview_id,state,message,created_at)
         VALUES ($1,$2,$3,'restore','{}','hash-r2',$4,'ready','m',${FRESH})`,
        [restoreFresh, actorRestore, randomUUID(), previewFresh],
    );
    await pool.query(
        `INSERT INTO web_restore_jobs(id,actor,request_key,kind,input,input_hash,state,message,created_at)
         VALUES ($1,$2,$3,'restore','{}','hash-r3','ready','m',${OLD30})`,
        [restoreOrphan, actorRestore, randomUUID()],
    );
    await check('web_restore_jobs: два прохода self-FK; свежие preview+restore живы; orphan restore снят', async () => {
        const report = await prune(['web_restore_jobs']);
        // Проход 1 — старые restore (preview_id IS NOT NULL); проход 2 — освободившаяся preview + orphan restore.
        assert.equal(report.resources[0].deleted, 3);
        assert.equal(
            await count('SELECT count(*) AS n FROM web_restore_jobs WHERE id IN ($1,$2)', pool, [
                previewFresh,
                restoreFresh,
            ]),
            2,
        );
        assert.equal(await count('SELECT count(*) AS n FROM web_restore_jobs'), 2);
    });

    const device = 'dev-' + randomUUID();
    await pool.query(
        'INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES ($1,$2,$3,$4,$5,$6)',
        [device, 'dev@example.test', 'owner', 'fixture-device', 'fingerprint-' + device, 'token-' + device],
    );
    await pool.query("INSERT INTO model_catalog(id,name,descriptor) VALUES ($1,$2,'{}')", [
        'fixture-model',
        'Fixture Model',
    ]);
    await pool.query(
        `INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash,created_at)
         VALUES ($1,$2,$3,$4,'fixture','{}',$5,$6,${OLD30})`,
        ['jobA', device, 'dev@example.test', 'owner', 'rk-A', 'rh-A'],
    );
    await pool.query(
        `INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash,created_at)
         VALUES ($1,$2,$3,$4,'fixture','{}',$5,$6,${OLD30})`,
        ['jobB', device, 'dev@example.test', 'owner', 'rk-B', 'rh-B'],
    );
    await pool.query(
        `INSERT INTO bridge_instance_events(id,device_id,project_id,email,event,instance_id,binding_id,created_at)
         VALUES ($1,$2,'p1','dev@example.test','fixture-event','inst-1','bind-1',${OLD30})`,
        ['jobA', device],
    );
    await pool.query(
        `INSERT INTO device_model_calls(id,job_id,model_id,device_id,owner_email,actor_role,model_pin,runtime_model,
         connection_revision,request,required_features,deadline_at,created_at)
         VALUES ($1,'jobA','fixture-model',$2,'dev@example.test','owner',repeat('a',64),'runtime-1',1,'{}','{}',
         now() + interval '10 minutes',${OLD30})`,
        [randomUUID(), device],
    );
    await pool.query(
        `INSERT INTO bridge_local_change_plans(id,device_id,project_id,email,binding_id,instance_id,preparation_job_id,
         digest,summary,expires_at,created_at)
         VALUES ($1,$2,'p1','dev@example.test','bind-1','inst-1','jobA','digest-A','{}',${OLD30},${OLD30})`,
        ['plan-A', device],
    );
    await pool.query(
        `INSERT INTO bridge_local_change_plans(id,device_id,project_id,email,binding_id,instance_id,preparation_job_id,
         digest,summary,expires_at,created_at)
         VALUES ($1,$2,'p1','dev@example.test','bind-1','inst-1','jobB','digest-B','{}',${FRESH},${FRESH})`,
        ['plan-B', device],
    );
    await check('bridge-кластер: старые дети и parent сняты; свежий ребёнок защищает parent', async () => {
        const report = await prune([
            'bridge_instance_events',
            'device_model_calls',
            'bridge_local_change_plans',
            'bridge_jobs',
        ]);
        const by = Object.fromEntries(report.resources.map((record) => [record.resource, record]));
        assert.equal(by.bridge_instance_events.deleted, 1);
        assert.equal(by.device_model_calls.deleted, 1);
        assert.equal(by.bridge_local_change_plans.deleted, 1); // plan-A старый; plan-B свежий — жив
        assert.equal(by.bridge_jobs.deleted, 1); // jobA; jobB защищён plan-B
        assert.equal(await count("SELECT count(*) AS n FROM bridge_jobs WHERE id='jobB'"), 1);
        assert.equal(await count("SELECT count(*) AS n FROM bridge_local_change_plans WHERE id='plan-B'"), 1);
    });

    const shaOld = 'c'.repeat(64),
        shaFresh = 'd'.repeat(64);
    await pool.query(
        `INSERT INTO bridge_runtime_artifacts(sha256,compressed_bytes,unpacked_bytes,files_count,imported_at)
         VALUES ($1,1024,2048,1,${OLD30})`,
        [shaOld],
    );
    await pool.query(
        `INSERT INTO bridge_runtime_artifacts(sha256,compressed_bytes,unpacked_bytes,files_count,imported_at)
         VALUES ($1,1024,2048,1,${FRESH})`,
        [shaFresh],
    );
    let artifactSpec = null;
    await check('bridge_runtime_artifacts: строки сняты, FS-спецификация = deleted ∖ existing + cutoff', async () => {
        const fixedNow = Date.now();
        const report = await prune(['bridge_runtime_artifacts'], {
            artifactStore: {
                remove: async (spec) => ((artifactSpec = spec), { rowFiles: 1, orphanFiles: 0, orphans: [] }),
            },
            now: () => fixedNow,
        });
        assert.equal(report.resources[0].deleted, 1);
        assert.deepEqual(artifactSpec, { deleted: [shaOld], existing: [shaFresh], cutoffMs: fixedNow - 30 * 86400000 });
    });

    await ragPool.query(
        'INSERT INTO rag_platform_quota_events(actor,before_policy,after_policy,created_at) VALUES ($1,$2,$3,' +
            OLD90 +
            ')',
        ['quota@example.test', '{}', '{}'],
    );
    await ragPool.query(
        'INSERT INTO rag_platform_quota_events(actor,before_policy,after_policy,created_at) VALUES ($1,$2,$3,' +
            FRESH +
            ')',
        ['quota@example.test', '{}', '{}'],
    );
    await check('rag_platform_quota_events: старые сняты, свежие живы; RAG-down изолирован per ресурс', async () => {
        const report = await prune(['rag_platform_quota_events']);
        assert.equal(report.resources[0].deleted, 1);
        assert.equal(await count('SELECT count(*) AS n FROM rag_platform_quota_events', ragPool), 1);
        const down = await runRetentionPrune({
            resources: subset(['rag_platform_quota_events']),
            catalogQuery: query,
            ragQuery: async () => {
                throw new Error('rag connection refused');
            },
            artifactStore,
            skillsStore,
        });
        assert.equal(down.resources[0].error, 'rag connection refused');
        assert.equal(await count('SELECT count(*) AS n FROM rag_platform_quota_events', ragPool), 1);
    });

    const skillCalls = [];
    await check(
        'smoke: все выражения полной retention-таблицы против реального schema; повторный проход = 0',
        async () => {
            const report = await runRetentionPrune({
                resources,
                catalogQuery: query,
                ragQuery: queryRag,
                artifactStore,
                skillsStore: { prune: async (value) => (skillCalls.push(value), { deleted: 0 }) },
            });
            assert.equal(report.resources.length, 29);
            for (const record of report.resources)
                assert.equal(record.error, undefined, 'ошибка: ' + record.resource + ': ' + record.error);
            assert.deepEqual(skillCalls, [{ path: '.neurocenter-skill-versions', rollingN: 2 }]);
            const repeat = await runRetentionPrune({
                resources,
                catalogQuery: query,
                ragQuery: queryRag,
                artifactStore,
                skillsStore: { prune: async () => ({ deleted: 0 }) },
            });
            assert.ok(
                repeat.resources.every((record) => record.deleted === 0),
                'повторный проход должен снять 0: ' +
                    JSON.stringify(repeat.resources.filter((record) => record.deleted !== 0)),
            );
        },
    );

    await check('receipt-merge: retention-счётчики дописываются к квитанции maintenance_runs', async () => {
        const runId = randomUUID();
        await pool.query(
            "INSERT INTO maintenance_runs(id,slot,policy_revision,state) VALUES ($1,'fixture-slot',1,'running')",
            [runId],
        );
        await pool.query(
            'UPDATE maintenance_runs SET receipt = \'{"backupId":"fixture-external"}\'::jsonb WHERE id = $1',
            [runId],
        );
        await pool.query(
            "UPDATE maintenance_runs SET receipt = coalesce(receipt, '{}'::jsonb) || " +
                '\'{"retention":[{"resource":"security_events","deleted":2}]}\'::jsonb WHERE id = \'' +
                runId +
                "'::uuid;",
        );
        const receipt = (await pool.query('SELECT receipt FROM maintenance_runs WHERE id = $1', [runId])).rows[0]
            .receipt;
        assert.equal(receipt.backupId, 'fixture-external');
        assert.deepEqual(receipt.retention, [{ resource: 'security_events', deleted: 2 }]);
    });

    const folder = path.join(root, '.run/p0-retention');
    await mkdir(folder, { recursive: true });
    await writeFile(
        path.join(folder, 'retention-prune-db.json'),
        JSON.stringify(
            {
                checkedAt: new Date().toISOString(),
                isolatedDatabases: [catalogDatabase, ragDatabase],
                passed: cases.length,
                cases,
            },
            null,
            2,
        ),
    );
    console.log(JSON.stringify({ passed: cases.length, failed: 0, isolatedDatabasesRemoved: true }));
} finally {
    await service?.onModuleDestroy();
    await pool?.end();
    await ragPool?.end();
    if (createdRag) {
        await administration.query('DROP DATABASE ' + ragDatabase);
    }
    if (createdCatalog) {
        await administration.query('DROP DATABASE ' + catalogDatabase);
    }
    await administration.end();
    if (old === undefined) {
        delete process.env.CATALOG_PG_URL;
    } else {
        process.env.CATALOG_PG_URL = old;
    }
}
