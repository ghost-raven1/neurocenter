/** Shared PostgreSQL rolling admission, cancellation and policy regression on an owned fixture. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { admit, ownedConnection, output, root, Pool } from './model-rate-owned.fixture.mjs';

await admit(); const owned = await ownedConnection();
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata'); require('ts-node').register({ transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json') });
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const { ensureCatalogSchema, checkCatalogSchema } = load('database/catalog-schema.ts');
const { assertModelRateLimitsSchema } = load('model-rate-limits/model-rate-limits.schema-verification.ts');
const { ModelRateLimitsService } = load('model-rate-limits/model-rate-limits.service.ts');
const { ModelRateLimitsRepository } = load('model-rate-limits/model-rate-limits.repository.ts');
const { ModelsService } = load('models/models.service.ts');
const { AccessDb } = load('access/access-db.ts');
const { projectEmbeddingPin } = load('models/project-embedding.validation.ts');
const { evaluateFeatureFlags, defaultFeatureFlags } = require(path.join(root, 'services/shared/feature-flags.cjs'));
const sha = value => createHash('sha256').update(value).digest('hex');
const files = ['model-rate-limits/model-rate-limits.service.ts', 'model-rate-limits/model-rate-limits.repository.ts', 'model-rate-limits/model-rate-limits.client.ts', 'model-rate-limits/model-rate-limits.validation.ts', 'model-rate-limits/model-rate-limits.types.ts', 'model-rate-limits/model-rate-limits.wait.ts', 'model-rate-limits/model-rate-limits.schema.ts', 'model-rate-limits/model-rate-limits.schema-contract.ts', 'model-rate-limits/model-rate-limits.schema-verification.ts', 'database/catalog-migrations.ts'];
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, 'services/catalog-service/src', file)))])));
const originalEnv = { ...process.env }, database = 'nc_model_rate_native_' + randomUUID().replaceAll('-', ''), token = randomUUID();
const admin = new Pool({ connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 3000 }), beforeDatabases = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const request = (email = 'main@owned-rate.test', activeRole = 'Главный админ') => ({ headers: { 'x-neurocenter-internal': token, 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email, activeRole })) } });
const main = request(), adminUser = request('admin@owned-rate.test', 'Админ проекта'), developer = request('developer@owned-rate.test', 'Разработчик');
const receipt = { startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, mainPostgresContacted: false, hashes, cases: [], limits: ['Real PostgreSQL16.15 and production rate repository/service, AccessDb and ModelsService; no external provider or paid call.', 'Rolling-window native checks use actual database time. Exact synthetic4.999/5.000 boundaries belong to deterministic unit tests.', 'No browser/Gateway, main PostgreSQL or live user configuration exercised.'] };
const test = async (name, action) => { const started = Date.now(); try { await action(); receipt.cases.push({ name, ok: true, ms: Date.now() - started }); } catch (error) { receipt.cases.push({ name, ok: false, ms: Date.now() - started, error: { name: error.name, message: error.message, status: error.status, stack: error.stack?.split('\n').slice(0, 6) } }); } };
const status = number => error => error.status === number;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = async (promise, label, ms = 5000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned rate timeout: ' + label)), ms); })]); } finally { clearTimeout(timer); } };
let pool, observer, access, models, service, second, server, modelA, modelB, created = false, flags = evaluateFeatureFlags(defaultFeatureFlags());
const count = async id => Number((await pool.query('SELECT count(*)::int AS count FROM model_api_dispatch_slots WHERE model_id=$1', [id])).rows[0].count);
const clean = async () => { await pool.query('TRUNCATE model_api_dispatch_slots,model_api_rate_limits'); };
const seedSlot = async (id, ageMs = 0) => pool.query("INSERT INTO model_api_dispatch_slots(id,model_id,dispatched_at) VALUES($1,$2,clock_timestamp()-$3::integer*interval '1 millisecond')", [randomUUID(), id, ageMs]);
const save = async (id, requests, windowMs, enabled = true) => service.save(main, id, { expectedRevision: (await service.read(main, id)).revision, requests, windowMs, enabled });
try {
    await admin.query('CREATE DATABASE "' + database + '"'); created = true; const url = new URL(owned.url); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 5000 }); observer = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 1000, statement_timeout: 4000 });
    server = createServer((req, res) => { if (req.headers['x-neurocenter-internal'] !== token) { res.writeHead(403).end(); return; } if (req.url === '/internal/feature-flags/evaluated') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(flags)); } else { req.resume(); res.writeHead(req.url === '/internal/events' ? 204 : 404).end(); } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { CATALOG_PG_URL: url.href, NODE_ENV: 'production', SSO_DISABLE: 'false', NEUROCENTER_INTERNAL_TOKEN: token, FEATURE_FLAGS_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, API_GATEWAY_URL: 'http://127.0.0.1:' + server.address().port });
    await ensureCatalogSchema(pool); await pool.query("INSERT INTO projects(id,name) VALUES('prj-rate-native','Owned rate native')");
    await pool.query("INSERT INTO platform_users(email,display_name,is_main_admin) VALUES('main@owned-rate.test','Main',true),('second-main@owned-rate.test','Second main',true),('admin@owned-rate.test','Admin',false),('developer@owned-rate.test','Developer',false)");
    await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-rate-native','admin@owned-rate.test','admin@owned-rate.test','Admin','Админ проекта'),('prj-rate-native','developer@owned-rate.test','developer@owned-rate.test','Developer','Разработчик')");
    for (const id of ['model-rate-a', 'model-rate-b']) await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2::jsonb)', [id, JSON.stringify({ description: 'Owned rate model', capability: 'chat', runtime: 'ollama', model: 'owned:rate', manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom' })]);
    access = new AccessDb(); await access.ready(); const catalog = { ensureSchema: () => ensureCatalogSchema(pool) }; models = new ModelsService(catalog, access);
    service = new ModelRateLimitsService(models); second = new ModelRateLimitsService(models); await service.onModuleInit(); await second.onModuleInit(); modelA = await models.get('model-rate-a'); modelB = await models.get('model-rate-b');
    await test('Migration24 readiness detects missing admission index and rate constraint drift', async () => {
        assert.equal((await checkCatalogSchema(pool, true)).applied.at(-1), 24); await assertModelRateLimitsSchema(pool); const db = await pool.connect();
        try { for (const sql of ['DROP INDEX model_api_dispatch_slots_model_time', 'ALTER TABLE model_api_rate_limits DROP CONSTRAINT model_api_rate_limits_window_ms_check']) { await db.query('BEGIN'); await db.query(sql); await assert.rejects(assertModelRateLimitsSchema(db), /не готова/); await db.query('ROLLBACK'); } } finally { await db.query('ROLLBACK'); db.release(); }
        await assertModelRateLimitsSchema(pool);
    });
    await test('Default is five requests per five seconds; only main admin can change independent policy', async () => {
        const value = await service.read(main, modelA.id); assert.deepEqual([value.requests, value.windowMs, value.revision, value.enabled, value.canManage], [5, 5000, 0, true, true]);
        assert.equal((await service.read(adminUser, modelA.id)).canManage, false); await assert.rejects(service.read(developer, modelA.id), status(403)); await assert.rejects(service.save(adminUser, modelA.id, { expectedRevision: 0, requests: 1, windowMs: 1000, enabled: true }), status(403));
    });
    await test('Policy runtime whitelist rejects malformed integers, ranges, secret fields and stale revision', async () => {
        const input = { expectedRevision: 0, requests: 5, windowMs: 5000, enabled: true };
        for (const raw of [{ ...input, requests: 0 }, { ...input, requests: 1001 }, { ...input, windowMs: 999 }, { ...input, windowMs: 86400001 }, { ...input, windowMs: 1000.5 }, { ...input, enabled: 'true' }, { ...input, apiKey: 'private' }, { ...input, expectedRevision: -1 }]) await assert.rejects(service.save(main, modelA.id, raw), status(400));
        await save(modelA.id, 5, 5000); await assert.rejects(service.save(main, modelA.id, input), status(409));
    });
    await test('Two replicas racing for sixteen attempts commit exactly five shared model slots', async () => {
        await clean(); const results = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? second : service).repository.tryAcquire(modelA.id)));
        // A lock contender may have to retry; denied lock acquisition is not a committed slot.
        let admitted = results.filter(row => row.admitted).length;
        for (let index = 0; index < 16 && admitted < 5; index++) if ((await service.repository.tryAcquire(modelA.id)).admitted) admitted++;
        assert.equal(admitted, 5); assert.equal(await count(modelA.id), 5); const denied = await second.repository.tryAcquire(modelA.id); assert.equal(denied.admitted, false); assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 5000);
    });
    await test('Rolling policy rejects a burst straddling a fixed one-second bucket boundary', async () => {
        await clean(); await save(modelA.id, 2, 1000);
        const dbTime = (await pool.query("SELECT extract(epoch FROM clock_timestamp())*1000 AS milliseconds")).rows[0].milliseconds, boundary = Math.ceil(Number(dbTime) / 1000) * 1000;
        await pool.query("INSERT INTO model_api_dispatch_slots(id,model_id,dispatched_at) VALUES($1,$2,to_timestamp(($3::double precision-20)/1000)),($4,$2,to_timestamp(($3::double precision-10)/1000))", [randomUUID(), modelA.id, boundary, randomUUID()]);
        const remaining = boundary + 30 - Date.now(); if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
        const denied = await service.repository.tryAcquire(modelA.id); assert.equal(denied.admitted, false); assert.ok(denied.retryAfterMs > 500); assert.equal(await count(modelA.id), 2);
    });
    await test('CAS policy saves preserve model identity and retained history across a larger window', async () => {
        await clean(); const pin = projectEmbeddingPin(await models.get(modelA.id)), expected = { expectedRevision: 0, requests: 1, windowMs: 1000, enabled: true };
        const results = await Promise.allSettled([service.save(main, modelA.id, expected), second.save(main, modelA.id, { ...expected, requests: 2 })]); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.status, 409);
        await seedSlot(modelA.id, 1500); await save(modelA.id, 1, 5000); const denied = await service.repository.tryAcquire(modelA.id); assert.equal(denied.admitted, false); assert.ok(denied.retryAfterMs > 2500); assert.equal(await count(modelA.id), 1); assert.equal(projectEmbeddingPin(await models.get(modelA.id)), pin);
    });
    await test('A smaller maximum returns the correct ranked retry time without resetting recent slots', async () => {
        await clean(); for (const age of [4000, 3000, 2000, 1000]) await seedSlot(modelA.id, age); await save(modelA.id, 2, 5000);
        const denied = await service.repository.tryAcquire(modelA.id); assert.equal(denied.admitted, false); assert.ok(denied.retryAfterMs > 2000 && denied.retryAfterMs <= 3100, 'Second newest slot governs a limit of two'); assert.equal(await count(modelA.id), 4);
        await seedSlot(modelA.id, 86401000); const off = await save(modelA.id, 2, 5000, false); assert.equal(off.enabled, false); assert.equal((await service.repository.tryAcquire(modelA.id)).admitted, true); assert.equal(await count(modelA.id), 5, 'Only history older than24h is deleted; disabled policy still records starts');
    });
    await test('Cancelled quota waiter commits no extra slot and an independent model progresses', async () => {
        await clean(); await save(modelA.id, 1, 86400000); await seedSlot(modelA.id); const abort = new AbortController(), waited = defer();
        const pending = service.acquire(modelA, abort.signal, undefined, () => waited.resolve()); const rejected = assert.rejects(pending, error => error === abort.signal.reason);
        await bounded(waited.promise, 'quota wait barrier'); await bounded(second.acquire(modelB), 'independent model'); abort.abort(new Error('Owned queued cancellation')); await rejected; assert.equal(await count(modelA.id), 1); assert.equal(await count(modelB.id), 1);
    });
    await test('Advisory lock contention is cancellable without holding another model or inserting an event', async () => {
        await clean(); const lock = await observer.connect(); const abort = new AbortController(), waited = defer();
        await lock.query('BEGIN'); await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-api-rate:'||$1,0))", [modelA.id]);
        const pending = service.acquire(modelA, abort.signal, undefined, () => waited.resolve()), rejected = assert.rejects(pending, error => error === abort.signal.reason);
        try { await bounded(waited.promise, 'advisory contention barrier'); await bounded(second.acquire(modelB), 'independent during SQL lock'); abort.abort(new Error('Cancel owned lock waiter')); await rejected; } finally { await lock.query('ROLLBACK'); lock.release(); }
        assert.equal(await count(modelA.id), 0); assert.equal(await count(modelB.id), 1);
    });
    await test('Aborting a held fresh-authorization callback releases its rate client and late completion cannot admit', async () => {
        await clean(); const abort = new AbortController(), entered = defer(), release = defer();
        const pending = service.acquire(modelA, abort.signal, async () => { entered.resolve(); await release.promise; return true; });
        const rejected = assert.rejects(pending, error => error === abort.signal.reason);
        try { await bounded(entered.promise, 'fresh authorization entered'); abort.abort(new Error('Owned callback cancellation')); await bounded(rejected, 'held callback abort settlement', 500); assert.equal(service.pool.idleCount, service.pool.totalCount); }
        finally { release.resolve(); await pending.catch(() => undefined); }
        assert.equal(await count(modelA.id), 0); await bounded(second.acquire(modelB), 'other model after callback cancellation'); assert.equal(await count(modelB.id), 1);
    });
    await test('A cancelled max-one pool checkout rejects promptly and returns its late client unused', async () => {
        await clean(); const tiny = new Pool({ connectionString: pool.options.connectionString, max: 1, connectionTimeoutMillis: 1000 }), held = await tiny.connect(), abort = new AbortController();
        const repository = new ModelRateLimitsRepository(tiny), pending = repository.tryAcquire(modelA.id, abort.signal), rejected = assert.rejects(pending, error => error === abort.signal.reason); let released = false;
        try {
            await bounded((async () => { while (tiny.waitingCount !== 1) await new Promise(resolve => setImmediate(resolve)); })(), 'queued pool checkout'); abort.abort(new Error('Owned queued checkout cancellation')); await bounded(rejected, 'checkout abort', 500); held.release(); released = true;
            await bounded((async () => { while (tiny.waitingCount || tiny.idleCount !== 1) await new Promise(resolve => setImmediate(resolve)); })(), 'late checkout returned'); assert.equal(await count(modelA.id), 0);
        } finally { if (!released) held.release(); await pending.catch(() => undefined); await tiny.end(); }
    });
    await test('Cancelling a settings SQL lock wait settles before unlocking and saves no policy', async () => {
        await clean(); const lock = await pool.connect(), abort = new AbortController(); await lock.query('BEGIN'); await lock.query('SELECT id FROM model_catalog WHERE id=$1 FOR UPDATE', [modelA.id]);
        const pending = service.repository.trySave(modelA.id, { expectedRevision: 0, requests: 1, windowMs: 1000, enabled: true }, 'main@owned-rate.test', () => models.requireMain(main), abort.signal), rejected = assert.rejects(pending, error => error === abort.signal.reason);
        try {
            await bounded((async () => { for (;;) { const value = await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM model_catalog%FOR SHARE' LIMIT 1"); if (value.rowCount) return; await new Promise(resolve => setTimeout(resolve, 10)); } })(), 'settings SQL wait');
            abort.abort(new Error('Owned settings SQL cancellation')); await bounded(rejected, 'settings SQL abort before unlock', 500); assert.equal((await service.repository.read(modelA.id)).revision, 0);
        } finally { await lock.query('ROLLBACK'); lock.release(); await pending.catch(() => undefined); }
    });
    await test('Settings recheck main-admin authority after waiting for the model row lock', async () => {
        await clean(); const lock = await pool.connect(); await lock.query('BEGIN'); await lock.query('SELECT id FROM model_catalog WHERE id=$1 FOR UPDATE', [modelA.id]);
        const pending = service.save(main, modelA.id, { expectedRevision: 0, requests: 1, windowMs: 1000, enabled: true }), rejected = assert.rejects(pending, status(403));
        try {
            await bounded((async () => { for (;;) { const waiting = await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM model_catalog%FOR SHARE' LIMIT 1"); if (waiting.rowCount) return; await new Promise(resolve => setTimeout(resolve, 15)); } })(), 'settings row-lock barrier');
            await observer.query("UPDATE platform_users SET is_main_admin=false WHERE email='main@owned-rate.test'"); await lock.query('COMMIT'); await rejected; assert.equal((await service.repository.read(modelA.id)).revision, 0);
        } finally { await lock.query('ROLLBACK'); lock.release(); await observer.query("UPDATE platform_users SET is_main_admin=true WHERE email='main@owned-rate.test'"); }
    });
    await test('Lost COMMIT acknowledgement keeps a conservative slot and never automatically re-admits', async () => {
        await clean(); let commits = 0; const wrapped = { async connect() { const db = await pool.connect(), query = db.query.bind(db); return { async query(...args) { const result = await query(...args); if (args[0] === 'COMMIT') { commits++; throw new Error('Owned lost admission COMMIT acknowledgement'); } return result; }, release: () => db.release() }; } };
        const original = service.repository.tryAcquire.bind(service.repository), repository = new ModelRateLimitsRepository(wrapped); service.repository.tryAcquire = repository.tryAcquire.bind(repository);
        try { await assert.rejects(service.acquire(modelA), error => error.status === 503 && error.getResponse().code === 'MODEL_RATE_STORE_UNAVAILABLE'); assert.equal(commits, 1); assert.equal(await count(modelA.id), 1); } finally { service.repository.tryAcquire = original; }
    });
    await test('Cancellation immediately after a confirmed admission COMMIT keeps its slot and returns no permission to send', async () => {
        await clean(); const abort = new AbortController(); let commits = 0;
        const wrapped = { async connect() { const db = await pool.connect(), query = db.query.bind(db); return { async query(...args) { const result = await query(...args); if (args[0] === 'COMMIT') { commits++; abort.abort(new Error('Owned post-COMMIT cancellation')); } return result; }, release: () => db.release() }; } };
        const original = service.repository.tryAcquire.bind(service.repository), repository = new ModelRateLimitsRepository(wrapped); service.repository.tryAcquire = repository.tryAcquire.bind(repository);
        try { await assert.rejects(service.acquire(modelA, abort.signal), error => error === abort.signal.reason); assert.equal(commits, 1); assert.equal(await count(modelA.id), 1); } finally { service.repository.tryAcquire = original; }
    });
    await test('Lost settings COMMIT acknowledgement is explicit, GET reconciles it and no hidden write repeats', async () => {
        await clean(); let commits = 0; const wrapped = { async connect() { const db = await pool.connect(), query = db.query.bind(db); return { async query(...args) { const result = await query(...args); if (args[0] === 'COMMIT') { commits++; throw new Error('Owned settings COMMIT acknowledgement lost'); } return result; }, release: error => db.release(error) }; } };
        const original = service.repository.trySave.bind(service.repository), repository = new ModelRateLimitsRepository(wrapped); service.repository.trySave = repository.trySave.bind(repository);
        try { await assert.rejects(service.save(main, modelA.id, { expectedRevision: 0, requests: 1, windowMs: 1000, enabled: true }), error => error.status === 503 && error.getResponse().code === 'MODEL_RATE_POLICY_SAVE_UNCONFIRMED'); assert.equal(commits, 1); const current = await service.read(main, modelA.id); assert.equal(current.revision, 1); assert.equal(current.requests, 1); }
        finally { service.repository.trySave = original; }
    });
    await test('A real bounded thirty-second quota wait ends with structured429 and no extra committed slot', async () => {
        await clean(); await save(modelA.id, 1, 86400000); await seedSlot(modelA.id); const started = performance.now(); let waited = 0;
        await assert.rejects(service.acquire(modelA, undefined, undefined, ms => { waited += ms; }), error => error.status === 429 && error.getResponse().code === 'MODEL_RATE_WAIT_TIMEOUT' && error.getResponse().retryAfterMs > 0);
        const elapsed = performance.now() - started; assert.ok(elapsed >= 29500 && elapsed < 34000); assert.ok(waited >= 29000); assert.equal(await count(modelA.id), 1);
    });
} finally {
    await service?.onApplicationShutdown(); await second?.onApplicationShutdown(); await models?.onApplicationShutdown(); await access?.onModuleDestroy(); if (server) await new Promise(resolve => server.close(resolve)); await observer?.end(); await pool?.end();
    if (created) { await admin.query('DROP DATABASE "' + database + '"'); receipt.databaseDropped = true; }
    receipt.databaseInventoryPreserved = JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows) === JSON.stringify(beforeDatabases); await admin.end();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
    receipt.sourceFreezeMatchesCurrent = (await Promise.all(files.map(async file => sha(await readFile(path.join(root, 'services/catalog-service/src', file))) === hashes[file]))).every(Boolean);
    receipt.expectedCases = 17; receipt.passed = receipt.cases.filter(row => row.ok).length; receipt.failed = receipt.cases.length - receipt.passed; receipt.completedAt = new Date().toISOString(); receipt.ok = receipt.cases.length === receipt.expectedCases && !receipt.failed && receipt.databaseDropped && receipt.databaseInventoryPreserved && receipt.sourceFreezeMatchesCurrent;
    await writeFile(path.join(output, 'rate-native-receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ ok: receipt.ok, passed: receipt.passed, failed: receipt.failed, receipt: path.join(output, 'rate-native-receipt.json') })); if (!receipt.ok) process.exitCode = 1;
}
