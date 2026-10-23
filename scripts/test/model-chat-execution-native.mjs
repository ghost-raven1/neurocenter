/** Actual usage/admission writes and execution projection on an explicitly owned PostgreSQL fixture. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {admit, ownedConnection, output, root, Pool} from './project-team-chat-owned.fixture.mjs';

await admit(); const owned = await ownedConnection();
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata'); require('ts-node').register({transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json')});
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const {ensureCatalogSchema} = load('database/catalog-schema.ts');
const {ModelUsageService} = load('model-usage/model-usage.service.ts');
const {ModelRateLimitsService} = load('model-rate-limits/model-rate-limits.service.ts');
const {ModelApiAdmission} = load('model-api-admission/model-api-admission.ts');
const {withModelUsage} = load('model-usage/model-usage.context.ts');
const {projectExecutionState} = load('model-chat/chat-execution-state.ts');
const {ChatRepository} = load('model-chat/chat.repository.ts');
const {turnView} = load('model-chat/chat.types.ts');
const {responseView} = load('model-chat/chat-group.types.ts');
const {FEATURE_FLAGS, evaluateFeatureFlags} = require(path.join(root, 'services/shared/feature-flags.cjs'));
const sourceFiles = ['model-chat/chat-execution-state.ts', 'model-chat/chat.repository.ts', 'model-chat/chat.types.ts', 'model-chat/chat-group.types.ts', 'model-usage/model-usage.service.ts', 'model-usage/model-usage.repository.ts', 'model-usage/model-dispatch-metrics.ts', 'model-api-admission/model-api-admission.ts', 'model-rate-limits/model-rate-limits.service.ts', 'model-rate-limits/model-rate-limits.repository.ts'];
const sha = value => createHash('sha256').update(value).digest('hex');
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(path.join(root, 'services/catalog-service/src', file)))])));
const savedEnv = {...process.env}, database = 'nc_model_execution_' + randomUUID().replaceAll('-', ''), token = randomUUID();
const admin = new Pool({connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 3000});
const originalDatabases = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const receipt = {startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, port: owned.owner.port, mainPostgresContacted: false, hashes, cases: [], limits: [
    'Real ModelUsageService.observe, ModelApiAdmission.run, rate service/repositories, PostgreSQL and execution-state SQL; deterministic held provider callbacks make no model request.',
    'The only HTTP server is an owned loopback feature-state fixture. No S3, browser, gateway, live account, external network or paid inference exercised.',
    'Six narrow projection cases supply DTO rows; the seventh exercises persisted ChatRepository.create/addTurn/rows/finish. No complete ModelChatService send/HTTP scenario is claimed.'
]};
const defer = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const bounded = async (promise, label, milliseconds = 5000) => {
    let timer; try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Owned execution timeout: ' + label)), milliseconds);})]);}
    finally {clearTimeout(timer);}
};
const test = async (name, action) => {
    const started = Date.now(); try {await action(); receipt.cases.push({name, ok: true, ms: Date.now() - started});}
    catch (error) {receipt.cases.push({name, ok: false, ms: Date.now() - started, error: {name: error.name, message: error.message, stack: error.stack?.split('\n').slice(0, 7)}});}
};
const owner = 'owner@owned-execution.test', project = 'prj-owned-execution', modelA = {id: 'model-owned-execution-a', name: 'Owned A', runtime: 'ollama', capability: 'chat'}, modelB = {...modelA, id: 'model-owned-execution-b', name: 'Owned B'};
const conversation = {id: randomUUID(), owner_email: owner, model_id: modelA.id, mode: 'model'};
const turn = () => ({id: randomUUID(), request_id: randomUUID(), request_ids: [], status: 'pending', responses: [], target_agent_ids: [], created_at: new Date().toISOString()});
let pool, observer, usage, rates, gate, server, created = false;
const releases = new Set(), controllers = new Set(), operations = new Set();
const rows = operation => observer.query('SELECT * FROM model_usage_calls WHERE operation_id=$1 ORDER BY started_at,id', [operation]).then(result => result.rows);
const projectState = async (row, room = conversation) => {await projectExecutionState(observer, room, [row]); return turnView(row).executionState;};
async function untilRow(operation, predicate, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {const value = (await rows(operation))[0]; if (value && predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5));}
    throw new Error('Owned execution timeout: ' + label);
}
async function hold(row, context = {}, model = modelA) {
    const entered = defer(), settled = defer(), release = defer(), abort = new AbortController(); releases.add(release); controllers.add(abort);
    const action = async signal => {
        entered.resolve(); let aborted;
        try {await Promise.race([release.promise, new Promise((_, reject) => {aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, {once: true}); if (signal.aborted) aborted();})]); signal.throwIfAborted(); return {message: {content: 'Owned deterministic answer'}, prompt_eval_count: 1, eval_count: 2};}
        finally {if (aborted) signal.removeEventListener('abort', aborted); settled.resolve();}
    };
    const pending = withModelUsage({purpose: 'chat', actorEmail: owner, projectId: project, turnId: row.id, operationId: row.request_id, ...context},
        () => usage.observe(model, 'chat', signal => gate.run(model, signal, () => action(signal)), abort.signal));
    pending.catch(() => undefined); operations.add(pending);
    pending.finally(() => {operations.delete(pending); releases.delete(release); controllers.delete(abort);}).catch(() => undefined);
    return {entered, settled, release, abort, pending, async finish() {release.resolve(); return bounded(pending, 'provider settlement');}};
}
try {
    await admin.query('CREATE DATABASE ' + database); created = true;
    // Apply to every subsequently created usage/rate pool connection, including injected failure paths.
    await admin.query('ALTER DATABASE ' + database + " SET statement_timeout='5s'");
    const url = new URL(owned.url); url.pathname = '/' + database;
    pool = new Pool({connectionString: url.href, max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000});
    observer = new Pool({connectionString: url.href, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000});
    const flags = evaluateFeatureFlags(Object.fromEntries(FEATURE_FLAGS.map(flag => [flag.key, true])));
    server = createServer((req, res) => {req.resume(); if (req.headers['x-neurocenter-internal'] === token && req.url === '/internal/feature-flags/evaluated') {res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(flags));} else res.writeHead(404).end();});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, {CATALOG_PG_URL: url.href, NEUROCENTER_INTERNAL_TOKEN: token, FEATURE_FLAGS_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, NODE_ENV: 'production'});
    await ensureCatalogSchema(pool);
    await pool.query('INSERT INTO projects(id,name) VALUES($1,$1)', [project]);
    for (const model of [modelA, modelB]) {
        await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)', [model.id, model.name, JSON.stringify({runtime: model.runtime, capability: 'chat', model: 'owned:execution', source: 'custom', manifestSha256: 'a'.repeat(64), dimension: null})]);
        await pool.query('INSERT INTO model_api_rate_limits(model_id,revision,requests,window_ms,enabled,updated_by) VALUES($1,1,1000,1000,true,$2)', [model.id, owner]);
    }
    const models = {ready: async () => undefined}; usage = new ModelUsageService(models); rates = new ModelRateLimitsService(models); gate = new ModelApiAdmission(rates);
    await usage.onModuleInit(); await rates.onModuleInit();

    await test('Actual admission waits without dispatch, then a held provider persists RUNNING before it settles', async () => {
        const row = turn(), lock = await pool.connect(); await lock.query('BEGIN'); await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-api-rate:'||$1,0))", [modelA.id]);
        const waitingAtRate = defer(), acquire = rates.repository.tryAcquire.bind(rates.repository);
        rates.repository.tryAcquire = async (...args) => {const value = await acquire(...args); if (!value.admitted) waitingAtRate.resolve(); return value;};
        const request = await hold(row);
        try {
            await bounded(waitingAtRate.promise, 'actual rate repository denied while owned advisory fence is held');
            const waiting = await untilRow(row.request_id, value => value.status === 'pending', 'undispatched receipt');
            assert.equal(waiting.dispatch_count, null); assert.equal(await projectState(row), 'waiting');
            await lock.query('COMMIT'); await bounded(request.entered.promise, 'provider starts');
            const running = await untilRow(row.request_id, value => Number(value.dispatch_count) === 1 && value.provider_latency_ms === null, 'active dispatch SQL');
            assert.equal(running.status, 'pending'); assert.equal(await projectState(row), 'running');
            await request.finish(); assert.equal((await rows(row.request_id))[0].status, 'success'); assert.equal(await projectState(row), 'waiting');
            row.status = 'done'; assert.equal(await projectState(row), null);
        } finally {rates.repository.tryAcquire = acquire; await lock.query('ROLLBACK'); lock.release(); await request.finish().catch(() => undefined);}
    });
    await test('A settled provider clears RUNNING even when terminal accounting write-back is unavailable', async () => {
        const row = turn(), finish = usage.repository.finish.bind(usage.repository); usage.repository.finish = async () => {throw new Error('Owned terminal write-back failure');};
        const request = await hold(row);
        try {
            await bounded(request.entered.promise, 'held provider'); await untilRow(row.request_id, value => Number(value.dispatch_count) === 1, 'dispatch progress');
            assert.equal(await projectState(row), 'running'); await request.finish();
            const settled = (await rows(row.request_id))[0]; assert.equal(settled.status, 'pending'); assert.notEqual(settled.provider_latency_ms, null);
            assert.equal(await projectState(row), 'waiting');
        } finally {usage.repository.finish = finish; await request.finish().catch(() => undefined);}
    });
    await test('A delayed active metadata write cannot overtake the later settled write', async () => {
        const row = turn(), entered = defer(), release = defer(), progress = usage.repository.dispatchProgress.bind(usage.repository);
        usage.repository.dispatchProgress = async (...args) => {if (args[4] === null) {entered.resolve(); await release.promise;} return progress(...args);};
        const request = await hold(row);
        try {
            await bounded(entered.promise, 'active write deliberately held before SQL'); request.release.resolve();
            await bounded(request.settled.promise, 'physical provider settled while metadata is held');
            assert.equal(await projectState(row), 'waiting'); release.resolve(); await request.finish();
            const settled = (await rows(row.request_id))[0]; assert.notEqual(settled.provider_latency_ms, null); assert.equal(settled.status, 'success');
            assert.equal(await projectState(row), 'waiting');
        } finally {release.resolve(); usage.repository.dispatchProgress = progress; await request.finish().catch(() => undefined);}
    });
    await test('Provider failure and cancellation clear activity without converting another attempt to RUNNING', async () => {
        const failed = turn();
        await assert.rejects(withModelUsage({purpose: 'chat', actorEmail: owner, turnId: failed.id, operationId: failed.request_id}, () => usage.observe(modelA, 'chat', signal => gate.run(modelA, signal, async () => {throw new Error('Owned provider failure');}))), /Owned provider failure/);
        assert.equal((await rows(failed.request_id))[0].status, 'error'); assert.equal(await projectState(failed), 'waiting');
        const row = turn(), request = await hold(row);
        try {
            await bounded(request.entered.promise, 'cancel held provider'); await untilRow(row.request_id, value => Number(value.dispatch_count) === 1, 'cancel active SQL');
            assert.equal(await projectState(row), 'running'); request.abort.abort(new Error('Owned cancellation')); await assert.rejects(request.pending, /Owned cancellation/);
            assert.equal((await rows(row.request_id))[0].status, 'cancelled'); row.status = 'cancelled'; assert.equal(await projectState(row), null);
        } finally {await request.finish().catch(() => undefined);}
    });
    await test('Current attempt, turn, model and owner are all required; expired leases never remain active', async () => {
        const row = turn(), request = await hold(row);
        try {
            await bounded(request.entered.promise, 'scope held provider'); await untilRow(row.request_id, value => Number(value.dispatch_count) === 1, 'scope dispatch SQL');
            assert.equal(await projectState(row), 'running');
            assert.equal(await projectState({...row, request_id: randomUUID()}), 'waiting');
            assert.equal(await projectState({...row, id: randomUUID()}), 'waiting');
            assert.equal(await projectState(row, {...conversation, model_id: modelB.id}), 'waiting');
            assert.equal(await projectState(row, {...conversation, owner_email: 'foreign@owned-execution.test'}), 'waiting');
            await pool.query("UPDATE model_usage_calls SET lease_until=now()-interval '1 second' WHERE operation_id=$1", [row.request_id]);
            assert.equal(await projectState(row), 'waiting');
        } finally {await request.finish();}
    });
    await test('Only the dispatched current sibling agent/model pair is RUNNING during a group round', async () => {
        const row = turn(), response = (agent, model, status = 'pending') => ({id: randomUUID(), agent_id: agent, status, snapshot: {agentId: agent, modelId: model.id}, request_id: row.request_id});
        row.responses = [response('agent-a', modelA), response('agent-b', modelB), response('agent-done', modelB, 'done')];
        const request = await hold(row, {purpose: 'agent', agentId: 'agent-b'}, modelB), room = {...conversation, mode: 'group'};
        try {
            await bounded(request.entered.promise, 'group sibling provider'); await untilRow(row.request_id, value => Number(value.dispatch_count) === 1, 'group dispatch SQL');
            assert.equal(await projectState(row, room), 'running'); assert.deepEqual(row.responses.map(value => responseView(value).executionState), ['waiting', 'running', null]);
            row.responses[1].request_id = randomUUID(); assert.equal(await projectState(row, room), 'waiting');
            row.responses[1].request_id = row.request_id;
            row.responses[1].snapshot.modelId = modelA.id; assert.equal(await projectState(row, room), 'waiting');
            row.responses[1].snapshot.modelId = modelB.id; row.responses[1].agent_id = 'agent-replaced'; assert.equal(await projectState(row, room), 'waiting');
            row.responses[1].agent_id = 'agent-b'; row.request_id = randomUUID(); assert.equal(await projectState(row, room), 'waiting');
        } finally {await request.finish();}
    });
    await test('Persisted ChatRepository rows and history expose actual transport state with no attachment or S3 dependency', async () => {
        const repository = new ChatRepository(pool);
        const room = await repository.create(owner, modelA.id, project, 'a'.repeat(64), 'Owned persisted chat', async () => undefined);
        const row = await repository.addTurn(observer, room, {requestId: randomUUID(), hash: 'b'.repeat(64), prompt: 'Owned prompt', attachmentIds: [], text: 'Owned prompt'});
        const before = await repository.rows(observer, room); assert.equal(before.turns.length, 1); assert.equal(turnView(before.turns[0]).executionState, 'waiting'); assert.deepEqual(before.attachments, []);
        const request = await hold(row);
        try {
            await bounded(request.entered.promise, 'persisted turn provider'); await untilRow(row.request_id, value => Number(value.dispatch_count) === 1, 'persisted dispatch SQL');
            const active = await repository.rows(observer, room); assert.equal(turnView(active.turns[0]).executionState, 'running'); assert.deepEqual(active.attachments, []);
            await request.finish(); const settled = await repository.rows(observer, room); assert.equal(turnView(settled.turns[0]).executionState, 'waiting');
            assert.equal(await repository.finish(observer, room, row, {content: 'Owned answer', finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 2, totalTokens: 3, reported: true}}), true);
            const terminal = await repository.rows(observer, room); assert.equal(turnView(terminal.turns[0]).executionState, null); assert.equal(terminal.turns[0].status, 'done');
            const next = await repository.addTurn(observer, room, {requestId: randomUUID(), hash: 'c'.repeat(64), prompt: 'Next owned prompt', attachmentIds: [], text: 'Next owned prompt'});
            const history = await repository.rows(observer, room, next.id, 50, false); assert.deepEqual(history.turns.map(value => value.id), [row.id]); assert.equal(turnView(history.turns[0]).executionState, null); assert.deepEqual(history.attachments, []);
        } finally {await request.finish().catch(() => undefined);}
    });
    receipt.ok = receipt.cases.every(value => value.ok);
} catch (error) {receipt.ok = false; receipt.initializationError = {name: error.name, message: error.message, stack: error.stack};}
finally {
    for (const release of releases) release.resolve(); for (const controller of controllers) controller.abort(new Error('Owned fixture cleanup'));
    const errors = [];
    try {await bounded(Promise.allSettled([...operations]), 'outstanding operation drain', 10000);} catch (error) {errors.push({name: 'operation drain', message: error.message});}
    for (const [name, close] of [['usage', () => usage?.onApplicationShutdown()], ['rates', () => rates?.onApplicationShutdown()], ['observer', () => observer?.end()], ['pool', () => pool?.end()], ['flags', () => server && new Promise(resolve => {server.close(resolve); server.closeAllConnections();})]]) {
        try {await bounded(Promise.resolve(close()), 'close ' + name, 10000);} catch (error) {errors.push({name, message: error.message});}
    }
    try {if (created) {await admin.query('DROP DATABASE ' + database); receipt.ownDatabaseDropped = true;} receipt.databaseInventoryPreserved = JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows) === JSON.stringify(originalDatabases);} catch (error) {errors.push({name: 'database cleanup', message: error.message});}
    await admin.end();
    for (const [file, hash] of Object.entries(hashes)) if (sha(await readFile(path.join(root, 'services/catalog-service/src', file))) !== hash) {receipt.sourceDrift ??= []; receipt.sourceDrift.push(file);}
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv);
    receipt.cleanupErrors = errors; receipt.finishedAt = new Date().toISOString(); if (errors.length || receipt.sourceDrift?.length || !receipt.databaseInventoryPreserved) receipt.ok = false;
    await writeFile(path.join(output, 'model-chat-execution-native-receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1;
}
