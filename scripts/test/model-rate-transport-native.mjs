/** Real runtime/transport/usage/rate integration; provider fetch is deterministic and never uses the network. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { admit, ownedConnection, output, root, Pool } from './model-rate-owned.fixture.mjs';

await admit(); const owned = await ownedConnection(), require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata'); require('ts-node').register({ transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json') });
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const { ensureCatalogSchema } = load('database/catalog-schema.ts'), { ModelsService } = load('models/models.service.ts'), { AccessDb } = load('access/access-db.ts');
const { ModelRateLimitsService } = load('model-rate-limits/model-rate-limits.service.ts'), { ModelRateLimitsRepository } = load('model-rate-limits/model-rate-limits.repository.ts');
const { ModelApiAdmission } = load('model-api-admission/model-api-admission.ts'), { ModelUsageService } = load('model-usage/model-usage.service.ts'), { ModelRuntime } = load('models/model-runtime.ts');
const { OllamaClient } = load('models/ollama-client.ts'), { RemoteConnectionService } = load('models/remote-connection.service.ts'), { RemoteModelClient } = load('models/remote-model-client.ts');
const { remoteVerificationDigest } = load('models/remote-model-validation.ts'), { localModelAlias } = load('models/local-model-alias.ts');
const { withModelUsage, currentModelUsage } = load('model-usage/model-usage.context.ts');
const { ForbiddenException, ConflictException } = require('@nestjs/common');
const { evaluateFeatureFlags, defaultFeatureFlags } = require(path.join(root, 'services/shared/feature-flags.cjs'));
const files = ['model-rate-limits/model-rate-limits.client.ts', 'model-rate-limits/model-rate-limits.repository.ts', 'model-rate-limits/model-rate-limits.service.ts', 'model-rate-limits/model-rate-limits.wait.ts', 'model-api-admission/model-api-admission.ts', 'models/remote-model-client.ts', 'models/remote-connection.service.ts', 'models/ollama-client.ts', 'models/model-runtime.ts', 'model-usage/model-dispatch-metrics.ts', 'model-usage/model-usage.service.ts', 'model-usage/model-usage.repository.ts'];
const sha = value => createHash('sha256').update(value).digest('hex'), hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, 'services/catalog-service/src', file)))])));
const admin = new Pool({ connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 1000 }), beforeDatabases = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const originalEnv = { ...process.env }, database = 'nc_model_rate_transport_' + randomUUID().replaceAll('-', ''), token = randomUUID(), projectId = 'prj-owned-rate-transport';
const request = (email = 'developer@owned-transport.test', activeRole = 'Разработчик') => ({ headers: { 'x-neurocenter-internal': token, 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email, activeRole })) } });
const user = request(), main = request('main@owned-transport.test', 'Главный админ');
const receipt = { startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, mainPostgresContacted: false, externalProviderCalls: 0, hashes, cases: [], limits: ['Real PostgreSQL, ModelsService/AccessDb, rate admission, ModelRuntime, remote/local clients and durable ModelUsageService; injected provider fetch returns deterministic Responses.', 'Quota authority is admission time after fresh callback and before short SQL admission; no claim of atomic ACL or exact network start under an arbitrarily delayed COMMIT acknowledgement.', 'No paid inference, live provider/network, browser, S3, or main PostgreSQL.'] };
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = async (promise, label, ms = 4000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned transport timeout: ' + label)), ms); })]); } finally { clearTimeout(timer); } };
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
let pool, models, access, limits, usage, local, remote, runtime, server, created = false, flags = evaluateFeatureFlags(defaultFeatureFlags()), mode = 'normal';
let localChat, localEmbed, remoteChat, remoteEmbed, heldStarted, heldRelease; const calls = [];
const provider = async (url, options = {}) => {
    const route = new URL(String(url)).pathname, body = options.body ? JSON.parse(options.body) : undefined, context = currentModelUsage();
    const unload = route === '/api/chat' && Array.isArray(body?.messages) && !body.messages.length, billable = ['/chat/completions', '/v1/chat/completions', '/v1/embeddings', '/api/embed', '/api/chat'].includes(route) && !unload;
    calls.push({ route, body, billable, actor: context.actorEmail, purpose: context.purpose });
    if (billable && mode === '429') return new Response('{}', { status: 429 });
    if (billable && mode === 'throw') throw new Error('Owned provider network failure');
    if (billable && mode === 'hold') { heldStarted.resolve(); await Promise.race([heldRelease.promise, new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))]); options.signal.throwIfAborted(); }
    if (route === '/api/tags') return response({ models: [localChat, localEmbed].map(model => ({ name: localModelAlias(model), digest: model.manifestSha256 })) });
    if (route === '/api/ps') return response({ models: [] });
    if (route === '/api/show') return response({ capabilities: body.model === localModelAlias(localEmbed) ? ['embedding'] : ['completion'] });
    if (unload) return response({ model: body.model, done: true, done_reason: 'unload' });
    if (route === '/api/embed') return response({ model: body.model, embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map(() => [1, 2, 3]), prompt_eval_count: 2 });
    if (route === '/api/chat') return response({ model: body.model, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'OWNED LOCAL ANSWER' }, prompt_eval_count: 3, eval_count: 4 });
    if (route === '/v1/embeddings') return response({ model: body.model, object: 'list', data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: [1, 2, 3] })), usage: { prompt_tokens: 2 } });
    if (route === '/v1/chat/completions') return response({ model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OWNED REMOTE ANSWER' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    throw new Error('Unexpected injected provider route ' + route);
};
const billable = () => calls.filter(row => row.billable).length;
const slots = async id => Number((await pool.query('SELECT count(*)::int AS count FROM model_api_dispatch_slots WHERE model_id=$1', [id])).rows[0].count);
const records = async () => (await pool.query('SELECT * FROM model_usage_calls ORDER BY started_at,id')).rows;
const authorize = model => models.getUsable(model.id, user, projectId);
const infer = (model = remoteChat, context = {}, signal) => withModelUsage({ purpose: 'chat', actorEmail: 'developer@owned-transport.test', projectId, beforeInference: () => authorize(model), ...context }, () => runtime.infer(model, model.capability === 'embedding' ? 'embed' : 'chat', model.capability === 'embedding' ? { input: ['Owned embedding'] } : { messages: [{ role: 'user', content: 'Owned question; never stored in ledger' }] }, signal));
const clean = async () => { calls.length = 0; mode = 'normal'; flags = evaluateFeatureFlags(defaultFeatureFlags()); await pool.query('TRUNCATE model_usage_calls,model_api_dispatch_slots,model_api_rate_limits'); };
const throttle = async model => { await limits.save(main, model.id, { expectedRevision: 0, requests: 1, windowMs: 86400000, enabled: true }); await pool.query('INSERT INTO model_api_dispatch_slots(id,model_id,dispatched_at) VALUES($1,$2,clock_timestamp())', [randomUUID(), model.id]); };
const waitBarrier = () => { const denied = defer(), original = limits.repository.tryAcquire.bind(limits.repository); limits.repository.tryAcquire = async (...args) => { const result = await original(...args); if (!result.admitted) denied.resolve(); return result; }; return { denied: denied.promise, restore: () => { limits.repository.tryAcquire = original; } }; };
const test = async (name, action) => { const started = Date.now(); try { await clean(); await action(); receipt.cases.push({ name, ok: true, ms: Date.now() - started }); } catch (error) { receipt.cases.push({ name, ok: false, ms: Date.now() - started, error: { name: error.name, message: error.message, status: error.status, stack: error.stack?.split('\n').slice(0, 7) } }); } };
try {
    await admin.query('CREATE DATABASE "' + database + '"'); created = true; const url = new URL(owned.url); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 4000 });
    server = createServer((req, res) => { if (req.headers['x-neurocenter-internal'] !== token) { res.writeHead(403).end(); return; } if (req.url === '/internal/feature-flags/evaluated') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(flags)); } else { req.resume(); res.writeHead(req.url === '/internal/events' ? 204 : 404).end(); } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { CATALOG_PG_URL: url.href, NODE_ENV: 'production', SSO_DISABLE: 'false', NEUROCENTER_INTERNAL_TOKEN: token, FEATURE_FLAGS_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, API_GATEWAY_URL: 'http://127.0.0.1:' + server.address().port });
    await ensureCatalogSchema(pool); await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Owned transport project']);
    await pool.query("INSERT INTO platform_users(email,display_name,is_main_admin) VALUES('main@owned-transport.test','Main',true),('developer@owned-transport.test','Developer',false)"); await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'developer@owned-transport.test','developer@owned-transport.test','Developer','Разработчик')", [projectId]);
    const descriptors = [
        ['model-transport-local-chat', { capability: 'chat', runtime: 'ollama', model: 'owned:chat', manifestSha256: 'a'.repeat(64), dimension: null }],
        ['model-transport-local-embed', { capability: 'embedding', runtime: 'ollama', model: 'owned:embed', manifestSha256: 'b'.repeat(64), dimension: 3 }],
        ['model-transport-remote-chat', { capability: 'chat', runtime: 'remote-openai', model: 'owned-chat', modelVersion: 'owned-v1', dimension: null }],
        ['model-transport-remote-embed', { capability: 'embedding', runtime: 'remote-openai', model: 'owned-embed', modelVersion: 'owned-v1', dimension: 3 }],
    ];
    for (const [id, descriptor] of descriptors) {
        if (descriptor.runtime === 'remote-openai') descriptor.verificationSha256 = remoteVerificationDigest({ id, ...descriptor }, { modelId: id, revision: 1, baseUrl: 'https://owned-provider.invalid/v1', requestDimensions: false, options: {}, timeoutMs: 1000 }, descriptor.dimension);
        await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2::jsonb)', [id, JSON.stringify({ ...descriptor, description: 'Owned fixture', source: 'custom' })]); await pool.query("INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,'main@owned-transport.test')", [projectId, id]);
        if (descriptor.runtime === 'remote-openai') await pool.query("INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,semantic_sha,verified_at,options,timeout_ms) VALUES($1,1,'https://owned-provider.invalid/v1',false,'none',$2,now(),'{}',1000)", [id, descriptor.verificationSha256]);
    }
    access = new AccessDb(); await access.ready(); const catalog = { ensureSchema: () => ensureCatalogSchema(pool), getProject: async id => (await pool.query('SELECT id,name,state FROM projects WHERE id=$1', [id])).rows[0] }; models = new ModelsService(catalog, access);
    [localChat, localEmbed, remoteChat, remoteEmbed] = await Promise.all(descriptors.map(([id]) => models.get(id))); limits = new ModelRateLimitsService(models); usage = new ModelUsageService(models); await limits.onModuleInit(); await usage.onModuleInit();
    const admission = new ModelApiAdmission(limits); local = new OllamaClient({ fetch: provider, env: { NODE_ENV: 'test', MODEL_RUNTIME_URL: 'http://127.0.0.1:11435' }, usage, admission }); remote = new RemoteConnectionService(models, usage, admission); remote.client = new RemoteModelClient({ fetch: provider, admission }); runtime = new ModelRuntime(local, remote, usage);
    await test('Remote chat and verification share five slots across actors and record each real dispatch once', async () => {
        await infer(); await remote.check(remoteChat, 'main@owned-transport.test', () => models.requireMain(main)); for (let n = 0; n < 3; n++) await infer(); assert.equal(billable(), 5); assert.equal(await slots(remoteChat.id), 5);
        const barrier = waitBarrier(), abort = new AbortController(); const pending = remote.check(remoteChat, 'main@owned-transport.test', () => models.requireMain(main), abort.signal), rejected = assert.rejects(pending, error => error === abort.signal.reason);
        try { await bounded(barrier.denied, 'sixth physical probe denied'); abort.abort(new Error('Owned sixth probe cancellation')); await rejected; } finally { barrier.restore(); }
        const saved = await records(); assert.equal(saved.length, 6); assert.equal(saved.filter(row => row.dispatch_count === 1).length, 5); assert.equal(saved.filter(row => row.dispatch_count === 0).length, 1); assert.equal(billable(), 5); assert.ok(saved.every(row => row.provider_latency_ms === null || Number(row.provider_latency_ms) >= 0)); assert.ok(saved.some(row => row.actor_email === 'main@owned-transport.test' && row.purpose === 'verification')); assert.ok(!JSON.stringify(saved).includes('Owned question'));
    });
    await test('Ollama normal inference and verification share admission while metadata and unload are exempt', async () => {
        await infer(localChat); await withModelUsage({ purpose: 'verification', actorEmail: 'main@owned-transport.test', beforeInference: () => models.requireMain(main) }, () => local.check(localChat)); const before = await slots(localChat.id); await local.status(localChat); await local.stop(localChat);
        assert.equal(before, 2); assert.equal(await slots(localChat.id), 2); assert.equal(billable(), 2); assert.ok(calls.some(row => row.route === '/api/show')); assert.ok(calls.some(row => row.route === '/api/chat' && !row.billable)); assert.equal((await records()).length, 2);
    });
    await test('Remote and local embedding keep distinct card quotas and exact usage attribution', async () => {
        await infer(remoteEmbed, { purpose: 'device-embedding' }); await infer(localEmbed, { purpose: 'reindex' }); assert.equal(await slots(remoteEmbed.id), 1); assert.equal(await slots(localEmbed.id), 1); assert.equal(billable(), 2);
        const saved = await records(); assert.equal(saved.length, 2); assert.ok(saved.every(row => row.endpoint === 'embed' && row.dispatch_count === 1 && row.actor_email === 'developer@owned-transport.test' && row.project_id === projectId)); assert.deepEqual(saved.map(row => row.purpose).sort(), ['device-embedding', 'reindex']);
    });
    await test('Fresh real project-role revocation during quota wait rejects before any provider action', async () => {
        await throttle(remoteChat); const barrier = waitBarrier(), pending = infer(), rejected = assert.rejects(pending, error => error.status === 403);
        try { await bounded(barrier.denied, 'quota wait before revocation'); await pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1", [projectId]); await bounded(rejected, 'fresh role denial'); assert.equal(billable(), 0); assert.equal(await slots(remoteChat.id), 1); const saved = (await records())[0]; assert.equal(saved.dispatch_count, 0); assert.equal(saved.failure_code, 'permission_denied'); }
        finally { barrier.restore(); await pool.query("UPDATE project_members SET role='Разработчик' WHERE project_id=$1", [projectId]); }
    });
    await test('Feature and job-generation changes during quota wait each prevent a new dispatch', async () => {
        for (const cause of ['feature', 'generation']) {
            await clean(); await throttle(remoteChat); let generation = 1; const barrier = waitBarrier(); const pending = infer(remoteChat, { beforeInference: async () => { await authorize(remoteChat); if (generation !== 1) throw new ConflictException('Owned expired generation'); } }), rejected = assert.rejects(pending, error => cause === 'feature' ? error.status === 403 : error.status === 409);
            try { await bounded(barrier.denied, 'quota wait before ' + cause); if (cause === 'feature') flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), model_chat: false }); else generation = 2; await bounded(rejected, cause + ' denial'); assert.equal(billable(), 0); assert.equal(await slots(remoteChat.id), 1); assert.equal((await records())[0].dispatch_count, 0); } finally { barrier.restore(); }
        }
    });
    await test('Cancelling after a provider started preserves its committed slot and records no automatic retry', async () => {
        mode = 'hold'; heldStarted = defer(); heldRelease = defer(); const abort = new AbortController(), pending = infer(remoteChat, {}, abort.signal), rejected = assert.rejects(pending, error => error === abort.signal.reason);
        try { await bounded(heldStarted.promise, 'provider started'); abort.abort(new Error('Owned provider cancellation')); await bounded(rejected, 'provider cancellation'); assert.equal(billable(), 1); assert.equal(await slots(remoteChat.id), 1); const saved = (await records())[0]; assert.equal(saved.status, 'cancelled'); assert.equal(saved.dispatch_count, 1); }
        finally { heldRelease.resolve(); mode = 'normal'; }
    });
    await test('Provider429 and network failure retain slots and never repeat physical inference', async () => {
        for (const failure of ['429', 'throw']) { mode = failure; const before = billable(); await assert.rejects(infer(), error => error.status === 503); assert.equal(billable() - before, 1); } assert.equal(await slots(remoteChat.id), 2); assert.ok((await records()).every(row => row.dispatch_count === 1 && row.failure_code === 'provider_error'));
    });
    await test('Terminal ledger write failure retries its metadata without repeating a completed provider call', async () => {
        const original = usage.repository.finish.bind(usage.repository); let failed = false; usage.repository.finish = async (...args) => { if (!failed) { failed = true; throw new Error('Owned terminal receipt unavailable'); } return original(...args); };
        try { const value = await infer(); assert.equal(value.message.content, 'OWNED REMOTE ANSWER'); assert.equal((await records())[0].status, 'pending'); usage.repository.finish = original; await usage.maintain(); const saved = (await records())[0]; assert.equal(saved.status, 'success'); assert.equal(saved.dispatch_count, 1); assert.equal(billable(), 1); assert.equal(await slots(remoteChat.id), 1); }
        finally { usage.repository.finish = original; }
    });
    await test('Ambiguous admission COMMIT leaves one conservative slot but performs zero provider fetches', async () => {
        let commits = 0; const wrapped = { async connect() { const db = await pool.connect(), query = db.query.bind(db); return { async query(...args) { const value = await query(...args); if (args[0] === 'COMMIT') { commits++; throw new Error('Owned lost COMMIT ACK'); } return value; }, release: error => db.release(error) }; } };
        const original = limits.repository.tryAcquire.bind(limits.repository), repository = new ModelRateLimitsRepository(wrapped); limits.repository.tryAcquire = repository.tryAcquire.bind(repository);
        try { await assert.rejects(infer(), error => error.status === 503); assert.equal(commits, 1); assert.equal(billable(), 0); assert.equal(await slots(remoteChat.id), 1); const saved = (await records())[0]; assert.equal(saved.dispatch_count, 0); assert.equal(saved.failure_code, 'rate_store_unavailable'); }
        finally { limits.repository.tryAcquire = original; }
    });
    await test('Global enforcement OFF bypasses the unavailable optional rate store while preserving old events', async () => {
        await throttle(remoteChat); flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), model_rate_limits: false }); const original = limits.acquire.bind(limits); let rateCalls = 0;
        limits.acquire = async () => { rateCalls++; throw new Error('Optional rate store must not be used'); };
        try { await infer(); assert.equal(rateCalls, 0); assert.equal(billable(), 1); assert.equal(await slots(remoteChat.id), 1); assert.equal((await records())[0].dispatch_count, 1); }
        finally { limits.acquire = original; }
    });
} finally {
    await usage?.onApplicationShutdown(); await limits?.onApplicationShutdown(); await models?.onApplicationShutdown(); await access?.onModuleDestroy(); if (server) await new Promise(resolve => server.close(resolve)); await pool?.end();
    if (created) { await admin.query('DROP DATABASE "' + database + '"'); receipt.databaseDropped = true; }
    receipt.databaseInventoryPreserved = JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows) === JSON.stringify(beforeDatabases); await admin.end();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
    receipt.sourceFreezeMatchesCurrent = (await Promise.all(files.map(async file => sha(await readFile(path.join(root, 'services/catalog-service/src', file))) === hashes[file]))).every(Boolean);
    receipt.expectedCases = 10; receipt.passed = receipt.cases.filter(row => row.ok).length; receipt.failed = receipt.cases.length - receipt.passed; receipt.completedAt = new Date().toISOString(); receipt.ok = receipt.cases.length === receipt.expectedCases && !receipt.failed && receipt.databaseDropped && receipt.databaseInventoryPreserved && receipt.sourceFreezeMatchesCurrent;
    await writeFile(path.join(output, 'transport-native-receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ ok: receipt.ok, passed: receipt.passed, failed: receipt.failed, receipt: path.join(output, 'transport-native-receipt.json') })); if (!receipt.ok) process.exitCode = 1;
}
