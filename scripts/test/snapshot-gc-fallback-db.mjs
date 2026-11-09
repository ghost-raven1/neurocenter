/**
 * AD-D3 (entry 5.9): S3 snapshot GC fallback — PostgreSQL-приёмка в изолированной scratch-БД.
 *
 * Scratch-каталог (полный catalog-schema через ensureCatalogSchema) + собственный S3-fixture
 * (signed-HTTP-сервер без контейнера) + SnapshotService.gcFallbackTick() против реального DDL:
 * liveness-гейт (verifier down/жив), age-фильтр delete_after, head/profile-фильтры,
 * двухфазный reclaim S3-объекта и строки (security event), idempotency через advisory-лок
 * (гонка с verifier-триггерным gc), таймерный lifecycle (OnModuleInit/Destroy).
 *
 * Запуск: TEST_ADMIN_PG_URL=postgresql://user:password@127.0.0.1:PORT/postgres node scripts/test/snapshot-gc-fallback-db.mjs
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { realpath, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedTestPostgresAdmin } from './owned-postgres.fixture.mjs';

const adminConnection = ownedTestPostgresAdmin(process.env.TEST_ADMIN_PG_URL).href;
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
require('ts-node').register({
    project: path.join(root, 'services/catalog-service/tsconfig.json'),
    transpileOnly: true,
});
const { Pool } = require('pg');
const { ensureCatalogSchema } = require(path.join(root, 'services/catalog-service/src/database/catalog-schema.ts'));
const { SnapshotService } = require(path.join(root, 'services/catalog-service/src/snapshots/snapshot.service.ts'));

/** Минимальный S3-протокольный fixture: только DELETE version-объекта, который бьёт SnapshotStorage.remove. */
async function s3Fixture() {
    const buckets = new Map();
    const events = [];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://fixture');
        const parts = url.pathname.slice(1).split('/');
        const bucket = parts.shift();
        const key = parts.join('/');
        events.push({ method: request.method, bucket, key, versionId: url.searchParams.get('versionId') });
        for await (const _chunk of request) {
            /* Drain the fixture request before answering. */
        }
        if (request.method === 'DELETE') {
            const objects = buckets.get(bucket);
            if (objects) {
                const current = objects.get(key);
                if (current && current.version === url.searchParams.get('versionId')) objects.delete(key);
            }
            response.writeHead(204);
            response.end();
            return;
        }
        response.writeHead(405);
        response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        endpoint: 'http://127.0.0.1:' + server.address().port,
        events,
        objects(bucket) {
            if (!buckets.has(bucket)) buckets.set(bucket, new Map());
            return buckets.get(bucket);
        },
        seed(bucket, key, version, bytes) {
            this.objects(bucket).set(key, { version, bytes });
        },
        async close() {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const PROJECT = 'prj-gc-fixture';
const BUCKET = 'snapshot-gc-acceptance';
const keyFor = (sha) => 'projects/' + digest(PROJECT) + '/blobs/' + sha;
const SNAP = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((name) => [name, randomUUID()]));
const SHA = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((name) => [name, name.toLowerCase().repeat(64)]));
const VERSION = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((name) => [name, 'version-' + name]));
const VERIFIER = randomUUID();

const administration = new Pool({ connectionString: adminConnection });
const suffix = randomUUID().replaceAll('-', '');
const databaseName = 'nc_verify_snapshot_gc_' + suffix;
const catalogUrl = new URL(adminConnection);
catalogUrl.pathname = '/' + databaseName;
let createdDatabase = false,
    pool,
    service,
    s3,
    storageDir;
const cases = [];
const check = async (name, action) => {
    await action();
    cases.push({ name, passed: true });
};
const oldEnv = {};
for (const name of [
    'CATALOG_PG_URL',
    'SNAPSHOT_STORAGE_DIR',
    'SNAPSHOT_S3_ENDPOINT',
    'SNAPSHOT_S3_BUCKET',
    'SNAPSHOT_S3_REGION',
    'SNAPSHOT_S3_ACCESS_KEY',
    'SNAPSHOT_S3_SECRET_KEY',
    'SNAPSHOT_VERIFIER_IMAGE_DIGEST',
])
    oldEnv[name] = process.env[name];
try {
    s3 = await s3Fixture();
    const origin = new URL(s3.endpoint).origin;
    const storageId = 's3:' + digest(JSON.stringify([origin, BUCKET])).slice(0, 32);
    process.env.SNAPSHOT_S3_ENDPOINT = s3.endpoint;
    process.env.SNAPSHOT_S3_BUCKET = BUCKET;
    process.env.SNAPSHOT_S3_REGION = 'us-east-1';
    process.env.SNAPSHOT_S3_ACCESS_KEY = 'gc-fixture-access';
    process.env.SNAPSHOT_S3_SECRET_KEY = 'gc-fixture-secret';
    delete process.env.SNAPSHOT_VERIFIER_IMAGE_DIGEST;
    delete process.env.SNAPSHOT_STORAGE_DIR;
    storageDir = await realpath(await mkdtemp(path.join(tmpdir(), 'nc-snapshot-gc-')));
    await administration.query('CREATE DATABASE ' + databaseName);
    createdDatabase = true;
    process.env.CATALOG_PG_URL = catalogUrl.href;
    pool = new Pool({ connectionString: catalogUrl.href, max: 6 });
    await ensureCatalogSchema(pool);
    const text = async (sql, params = []) =>
        (await pool.query(sql, params)).rows.map((row) => String(Object.values(row)[0] ?? '')).join('\n');
    const count = async (sql, params = []) => Number(await text(sql, params));
    const statusOf = async (id) =>
        (await pool.query('SELECT status FROM project_snapshots WHERE id=$1', [id])).rows[0].status;
    const seedSnapshot = async (name, deleteAfterSql) => {
        await pool.query(
            `INSERT INTO project_snapshots(id,project_id,request_key,request_hash,email,role,device_id,binding_id,
             status,total_bytes,created_at,delete_after,expected_head_revision)
             VALUES ($1,$2,$3,$4,'gc@example.test','owner','dev-gc','bind-gc','DELETING',3,now() - interval '3 hours',${deleteAfterSql},1)`,
            [SNAP[name], PROJECT, randomUUID(), 'request-hash-' + name],
        );
        await pool.query(
            'INSERT INTO project_snapshot_blob_refs(snapshot_id,project_id,sha256,bytes) VALUES ($1,$2,$3,3)',
            [SNAP[name], PROJECT, SHA[name]],
        );
        await pool.query(
            'INSERT INTO project_snapshot_blobs(project_id,sha256,bytes,storage_id,version_id) VALUES ($1,$2,3,$3,$4)',
            [PROJECT, SHA[name], storageId, VERSION[name]],
        );
        s3.seed(BUCKET, keyFor(SHA[name]), VERSION[name], Buffer.from('gc-fixture-' + name));
    };
    await pool.query('INSERT INTO projects(id,name) VALUES ($1,$2)', [PROJECT, 'Fixture GC']);
    await pool.query(
        "INSERT INTO project_snapshot_verifiers(id,last_seen,sdk_version,image_digest) VALUES ($1,now() - interval '10 minutes','0.29.0',$2)",
        [VERIFIER, 'sha256:' + '0'.repeat(64)],
    );
    await seedSnapshot('A', "now() - interval '1 hour'");
    await seedSnapshot('B', "now() + interval '2 hours'");
    await seedSnapshot('C', "now() - interval '90 minutes'");
    await pool.query('UPDATE projects SET head_snapshot_id=$1 WHERE id=$2', [SNAP.C, PROJECT]);
    await seedSnapshot('D', "now() - interval '120 minutes'");
    await pool.query(
        `INSERT INTO project_snapshot_profiles(id,project_id,snapshot_id,revision,skill_pins,capsule,capsule_sha256,signature,email)
         VALUES ($1,$2,$3,1,'[]','{}','capsule-fixture','{}','gc@example.test')`,
        [randomUUID(), PROJECT, SNAP.D],
    );
    service = new SnapshotService({ ensureSchema: async () => {} }, { ready: async () => {} }, {});

    await check(
        'verifier down + просроченный DELETING: reclaim S3-объекта и строки, head/future/profile не тронуты',
        async () => {
            await service.gcFallbackTick();
            assert.equal(await statusOf(SNAP.A), 'DELETED');
            assert.equal(
                await count('SELECT count(*) FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2', [
                    PROJECT,
                    SHA.A,
                ]),
                0,
            );
            assert.equal(
                await count('SELECT count(*) FROM project_snapshot_blob_refs WHERE snapshot_id=$1', [SNAP.A]),
                0,
            );
            assert.equal(s3.objects(BUCKET).has(keyFor(SHA.A)), false);
            assert.equal(await statusOf(SNAP.B), 'DELETING');
            assert.equal(s3.objects(BUCKET).has(keyFor(SHA.B)), true);
            assert.equal(await statusOf(SNAP.C), 'DELETING');
            assert.equal(s3.objects(BUCKET).has(keyFor(SHA.C)), true);
            assert.equal(await statusOf(SNAP.D), 'DELETING');
            assert.equal(s3.objects(BUCKET).has(keyFor(SHA.D)), true);
            assert.equal(
                await count("SELECT count(*) FROM security_events WHERE action='snapshot.deleted' AND resource_id=$1", [
                    SNAP.A,
                ]),
                1,
            );
            assert.deepEqual(
                s3.events.filter((event) => event.method === 'DELETE').map((event) => [event.key, event.versionId]),
                [[keyFor(SHA.A), VERSION.A]],
            );
        },
    );

    await check('verifier жив — fallback не reclaim (основной путь)', async () => {
        await pool.query('UPDATE project_snapshot_verifiers SET last_seen=now() WHERE id=$1', [VERIFIER]);
        await seedSnapshot('E', "now() - interval '1 hour'");
        await service.gcFallbackTick();
        assert.equal(await statusOf(SNAP.E), 'DELETING');
        assert.equal(
            await count('SELECT count(*) FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2', [
                PROJECT,
                SHA.E,
            ]),
            1,
        );
        assert.equal(s3.objects(BUCKET).has(keyFor(SHA.E)), true);
        assert.deepEqual(
            s3.events.filter((event) => event.method === 'DELETE').map((event) => [event.key, event.versionId]),
            [[keyFor(SHA.A), VERSION.A]],
        );
        await pool.query("UPDATE project_snapshot_verifiers SET last_seen=now() - interval '10 minutes' WHERE id=$1", [
            VERIFIER,
        ]);
        // E остаётся DELETING, но с будущим delete_after: в следующем кейзе единственный кандидат — F.
        await pool.query("UPDATE project_snapshots SET delete_after=now() + interval '2 hours' WHERE id=$1", [SNAP.E]);
    });

    await check(
        'advisory-лок у verifier-gc — fallback no-op; после освобождения лока reclaim завершается',
        async () => {
            await seedSnapshot('F', "now() - interval '1 hour'");
            const contender = await pool.connect();
            try {
                await contender.query("SELECT pg_advisory_lock(hashtextextended('neurocenter:snapshot-storage',0))");
                await service.gcFallbackTick();
                assert.equal(await statusOf(SNAP.F), 'DELETING');
                assert.equal(s3.objects(BUCKET).has(keyFor(SHA.F)), true);
            } finally {
                await contender.query("SELECT pg_advisory_unlock(hashtextextended('neurocenter:snapshot-storage',0))");
                contender.release();
            }
            await service.gcFallbackTick();
            assert.equal(await statusOf(SNAP.F), 'DELETED');
            assert.equal(s3.objects(BUCKET).has(keyFor(SHA.F)), false);
            assert.equal(
                await count("SELECT count(*) FROM security_events WHERE action='snapshot.deleted' AND resource_id=$1", [
                    SNAP.F,
                ]),
                1,
            );
        },
    );

    await check('повторный tick без кандидатов — idempotent no-op без новых событий', async () => {
        const eventsBefore = await count("SELECT count(*) FROM security_events WHERE action='snapshot.deleted'");
        const deletesBefore = s3.events.filter((event) => event.method === 'DELETE').length;
        await service.gcFallbackTick();
        assert.equal(await count("SELECT count(*) FROM security_events WHERE action='snapshot.deleted'"), eventsBefore);
        assert.equal(s3.events.filter((event) => event.method === 'DELETE').length, deletesBefore);
        assert.equal(s3.events.filter((event) => event.method === 'DELETE').length, 2);
    });

    await check(
        'таймерный lifecycle: OnModuleInit стартует fallback-таймер, OnModuleDestroy закрывает пул',
        async () => {
            assert.equal(service.gcFallbackTimer, undefined);
            const originalEnd = service.pool.end.bind(service.pool);
            let ended = 0;
            service.pool.end = async () => {
                ended++;
                return originalEnd();
            };
            await service.onModuleInit();
            assert.ok(service.gcFallbackTimer, 'fallback-таймер должен быть запущен');
            await service.onModuleDestroy();
            assert.equal(ended, 1);
        },
    );
} finally {
    await service?.pool.end().catch(() => undefined);
    await pool?.end();
    await s3?.close();
    if (createdDatabase) await administration.query('DROP DATABASE ' + databaseName);
    await administration.end();
    await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
    for (const [name, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}
const report = path.join(root, '.run/p0-snapshot-gc/snapshot-gc-fallback-db.json');
await mkdir(path.dirname(report), { recursive: true });
await writeFile(
    report,
    JSON.stringify(
        {
            checkedAt: new Date().toISOString(),
            isolatedDatabase: databaseName,
            passed: cases.length,
            cases,
        },
        null,
        2,
    ),
);
console.log(JSON.stringify({ passed: cases.length, failed: 0, isolatedDatabaseRemoved: true }));
