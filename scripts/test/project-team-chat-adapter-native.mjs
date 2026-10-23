/** Run explicitly against a fresh owned fixture: --owned-postgres-config /absolute/path/to/cluster/connection.json. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { admit, ownedConnection, output, root, Pool } from './project-team-chat-owned.fixture.mjs';
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata'); require('ts-node').register({ transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json') });
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const sha = value => createHash('sha256').update(value).digest('hex');
const files = ['project-chat-inference/project-chat-inference.service.ts', 'project-chat-inference/project-chat-models.ts', 'project-chat-inference/project-chat-context.ts', 'project-chat/project-chat.service.ts', 'project-chat/project-chat.repository.ts', 'project-chat/project-chat.runner.ts', 'project-chat/project-chat-project.ts', 'project-chat/project-chat-dialogs.ts', 'project-chat/project-chat-room-access.ts', 'project-chat/project-chat.types.ts', 'project-chat/project-chat-dialogs.schema.ts', 'project-chat/project-chat-dialogs.schema-contract.ts'];
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, 'services/catalog-service/src', file)))])));
const { ensureCatalogSchema } = load('database/catalog-schema.ts'), { ModelsService } = load('models/models.service.ts'), { ModelsRepository } = load('models/models.repository.ts'), { AccessDb } = load('access/access-db.ts');
const { ProjectChatService } = load('project-chat/project-chat.service.ts'), { ProjectChatInferenceService } = load('project-chat-inference/project-chat-inference.service.ts'), { AgentRepository } = load('agents/agent.repository.ts');
const { projectEmbeddingPin } = load('models/project-embedding.validation.ts'), { currentModelUsage } = load('model-usage/model-usage.context.ts');
const { evaluateFeatureFlags, defaultFeatureFlags } = require(path.join(root, 'services/shared/feature-flags.cjs'));
await admit(); const owned = await ownedConnection(), admin = new Pool({ connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 3000 });
const original = { ...process.env }, database = 'nc_project_chat_adapter_' + randomUUID().replaceAll('-', ''), token = randomUUID(), projectId = 'prj-adapter-' + randomUUID();
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
let pool, single, observer, access, models, service, server, created = false;
const calls = [], receipt = { startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, hashes, cases: [], mainPostgresContacted: false, limits: ['Actual PostgreSQL, production ProjectChatService/InferenceService/ChatGroup/ModelChatLearningContext/ModelsService and single-connection model pool.', 'Provider runtime is deterministic and records actual validated requests; no paid call, external provider, native OpenCode process or live deployment exercised.'] };
let runtimeBehavior, runtimeReservation;
const main = { headers: { 'x-neurocenter-internal': token, 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: 'main@adapter.test', activeRole: 'Главный админ' })) } }, user = { headers: { ...main.headers, 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: 'user@adapter.test', activeRole: 'Разработчик' })) } };
const test = async (name, action) => { const start = Date.now(); try { await action(); receipt.cases.push({ name, ok: true, ms: Date.now() - start }); } catch (error) { receipt.cases.push({ name, ok: false, ms: Date.now() - start, error: { name: error.name, message: error.message, status: error.status, code: error.code, stack: error.stack?.split('\n').slice(0, 5) } }); } };
const bounded = async (promise, label, ms = 4000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned adapter timeout: ' + label)), ms); })]); } finally { clearTimeout(timer); } };
const post = (prompt, extra = {}) => service.send(user, projectId, { requestKey: randomUUID(), prompt, targetAgentIds: [], ...extra });
try {
    await admin.query('CREATE DATABASE "' + database + '"'); created = true; const url = new URL(owned.url); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 3000 }); single = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 700, statement_timeout: 3000 }); observer = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 1000, statement_timeout: 3000 });
    let flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_learning: false });
    server = createServer((req, res) => { if (req.headers['x-neurocenter-internal'] !== token) { res.writeHead(403).end(); return; } if (req.url === '/internal/feature-flags/evaluated') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(flags)); } else { req.resume(); res.writeHead(req.url === '/internal/events' ? 204 : 404).end(); } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { CATALOG_PG_URL: url.href, NODE_ENV: 'production', SSO_DISABLE: 'false', MODEL_CHAT_CONTEXT_WINDOW_TOKENS: '2048', NEUROCENTER_INTERNAL_TOKEN: token, FEATURE_FLAGS_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, API_GATEWAY_URL: 'http://127.0.0.1:' + server.address().port });
    await ensureCatalogSchema(pool); await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Adapter QA']); await pool.query("INSERT INTO platform_users(email,display_name,is_main_admin) VALUES('main@adapter.test','Main',true),('user@adapter.test','User',false),('observer@adapter.test','Observer',false)"); await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'user@adapter.test','user@adapter.test','User','Разработчик'),($1,'observer@adapter.test','observer@adapter.test','Observer','Наблюдатель')", [projectId]);
    access = new AccessDb(); await access.ready();
    const catalog = { ensureSchema: () => ensureCatalogSchema(pool), getProject: async id => { const row = (await pool.query('SELECT id,name,state FROM projects WHERE id=$1', [id])).rows[0]; if (!row) throw Error('Unknown own project'); return row; } };
    // Preserve every production method while configuring a genuinely one-connection pool before its repositories are constructed.
    models = Object.assign(Object.create(ModelsService.prototype), { pool: single, repository: new ModelsRepository(single), catalog, access });
    const descriptor = { description: 'Owned model', capability: 'chat', runtime: 'ollama', model: 'owned:local', manifestSha256: 'c'.repeat(64), dimension: null, source: 'custom' };
    const modelId = 'model-adapter-local'; await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)', [modelId, 'Adapter local', JSON.stringify(descriptor)]); await pool.query("INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,'main@adapter.test')", [projectId, modelId]);
    const model = await models.get(modelId), pin = projectEmbeddingPin(model), cards = [];
    await pool.query('INSERT INTO project_agent_sets(project_id) VALUES($1)', [projectId]);
    for (const [name, prompt, temperature] of [['Front', 'ONLY FRONT PROFILE', 0.2], ['Back', 'ONLY BACK PROFILE', 0.6]]) {
        const id = 'agent-adapter-' + name.toLowerCase(), card = await new AgentRepository(pool).write(pool, id, { slug: 'nc-adapter-' + name.toLowerCase(), name, definition: { description: name + ' specialist', prompt, mode: 'all', permission: {}, temperature } }, 1);
        await pool.query("INSERT INTO project_agents(project_id,agent_id,version,manifest,enabled,added_by,updated_by,overrides) VALUES($1,$2,1,$3,true,'main@adapter.test','main@adapter.test',$4::jsonb)", [projectId, id, card.manifest, JSON.stringify(name === 'Front' ? { prompt: 'PROJECT FRONT OVERRIDE' } : {})]); cards.push(card);
    }
    const ids = cards.map(card => card.id);
    catalog.getProject = async () => { throw new Error('UNEXPECTED heavyweight CatalogService.getProject: room/profile/learning/model lookup must use lightweight identity'); };
    const runtime = { async infer(selected, endpoint, body, signal) { assert.equal(endpoint, 'chat'); const context = currentModelUsage(); await runtimeReservation?.({ selected, endpoint, body, signal, context }); await load('features/require-feature-enabled.ts').requireFeaturesEnabled(context.requiredFeatures ?? []); await context.beforeInference?.(); signal?.throwIfAborted(); calls.push({ selected, body, context: { ...context, beforeInference: undefined } }); if (runtimeBehavior) return runtimeBehavior({ selected, endpoint, body, signal, context }); return { message: { role: 'assistant', content: 'AGENT ANSWER ' + context.agentId + ' FOR ' + context.turnId }, done_reason: 'stop', usage_reported: false }; } };
    const adapter = new ProjectChatInferenceService(models, runtime); service = new ProjectChatService(models, adapter);
    await test('Single pool actual settings/resolve/assert and concurrent roster reads complete without nested checkout', async () => {
        const detail = await bounded(service.read(main, projectId), 'initial roster'); const configured = await bounded(service.participants(main, projectId, { expectedRevision: detail.room.revision, modelId, expectedModelPin: pin, agentIds: ids }), 'participants resolve'); assert.equal(configured.agents.length, 2); assert.ok(configured.agents.every(row => row.status === 'active'));
        const reads = await bounded(Promise.all(Array.from({ length: 6 }, () => service.read(user, projectId))), 'six max1 reads'); assert.ok(reads.every(row => row.agents.length === 2 && row.agents.every(agent => agent.status === 'active'))); assert.equal(calls.length, 0); assert.equal(single.options.max, 1);
    });
    await test('Observer reads active project roster without inference privileges or manufactured model errors', async () => {
        const observerRequest = { headers: { ...main.headers, 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: 'observer@adapter.test', activeRole: 'Наблюдатель' })) } };
        const detail = await bounded(service.read(observerRequest, projectId), 'observer actual roster'); assert.equal(detail.canPost, false); assert.equal(detail.canConfigure, false); assert.ok(detail.agents.every(row => row.status === 'active')); assert.equal(calls.length, 0);
    });
    await test('Snapshot validation rejects changed definition with unchanged hash and accepts JSONB key reordering', async () => {
        await bounded(service.repository.scoped(projectId, { email: 'user@adapter.test', activeRole: 'Разработчик' }, 2, false, async (db, room) => {
            const [snapshot] = await adapter.resolve(user, projectId, room, [ids[0]], db);
            const reordered = Object.fromEntries(Object.entries(snapshot).reverse()); reordered.definition = Object.fromEntries(Object.entries(snapshot.definition).reverse()); await adapter.assert(user, projectId, reordered, db);
            await assert.rejects(adapter.assert(user, projectId, { ...snapshot, definition: { ...snapshot.definition, prompt: 'TAMPERED SAME HASH PROFILE' } }, db), error => error.status === 409);
        }), 'complete fresh snapshot assertion');
    });
    let parent, first, agent;
    await test('Actual effective profiles and options answer exact source independently with quoted parent and no private model history', async () => {
        const privateId = randomUUID(); await pool.query("INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,title,model_pin) VALUES($1,'user@adapter.test',$2,$3,'PRIVATE MODEL HISTORY',$4)", [privateId, modelId, projectId, pin]);
        const turnId = randomUUID(), request = randomUUID(); await pool.query("INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,input_text,attachment_ids,status,answer) VALUES($1,$2,$3,ARRAY[$3::uuid],$4,'PRIVATE_SENTINEL','PRIVATE_SENTINEL','{}','done',$5::jsonb)", [turnId, privateId, request, 'd'.repeat(64), JSON.stringify({ content: 'PRIVATE_ANSWER_SENTINEL', finishReason: 'stop', usage: { inputTokens: null, outputTokens: null, totalTokens: null, reported: false } })]);
        parent = await post('PARENT HUMAN SENTINEL'); first = await post('CURRENT SOURCE EXACT QUESTION', { replyToId: parent.message.id, targetAgentIds: ids }); await bounded(service.runner.waitIdle(), 'actual two-agent inference'); assert.equal(calls.length, 2);
        assert.equal(calls[0].body.messages[0].content, 'PROJECT FRONT OVERRIDE'); assert.equal(calls[1].body.messages[0].content, 'ONLY BACK PROFILE'); assert.equal(calls[0].body.options.temperature, 0.2); assert.equal(calls[1].body.options.temperature, 0.6);
        for (const call of calls) { const text = JSON.stringify(call.body.messages); assert.ok(text.includes('PARENT HUMAN SENTINEL')); assert.ok(text.includes('CURRENT SOURCE EXACT QUESTION')); assert.ok(text.includes(first.message.id)); assert.ok(!text.includes('PRIVATE_SENTINEL')); assert.ok(!text.includes('PRIVATE_ANSWER_SENTINEL')); assert.equal(call.context.actorEmail, 'user@adapter.test'); assert.equal(call.context.projectId, projectId); assert.equal(call.context.turnId, first.message.id); assert.equal(call.context.purpose, 'agent'); assert.ok(call.context.requiredFeatures.includes('project_chat')); }
        agent = (await pool.query("SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 AND kind='agent' ORDER BY position LIMIT 1", [projectId, first.message.id])).rows[0]; assert.equal(agent.status, 'done'); assert.ok(!(await service.read(user, projectId)).messages.some(row => row.content.includes('PRIVATE_SENTINEL')));
    });
    await test('Reply to completed agent passes its bounded quote and exact new human source to selected specialist only', async () => {
        assert.ok(agent); const before = calls.length, result = await post('USER REPLIES TO AGENT', { replyToId: agent.id, targetAgentIds: [ids[0]] }); await bounded(service.runner.waitIdle(), 'reply agent context'); assert.equal(calls.length - before, 1); const call = calls.at(-1), text = JSON.stringify(call.body.messages); assert.ok(text.includes(agent.id)); assert.ok(text.includes(agent.content)); assert.ok(text.includes('USER REPLIES TO AGENT')); assert.equal(call.context.turnId, result.message.id); assert.equal(call.context.agentId, ids[0]);
    });
    await test('Too-large source is durable human text; context rejection spends no model call and leaves room usable', async () => {
        const before = calls.length, result = await post('x'.repeat(12000), { targetAgentIds: [ids[0]] }); await bounded(service.runner.waitIdle(), 'context size rejection'); assert.equal(calls.length, before); const source = (await pool.query('SELECT * FROM project_chat_messages WHERE id=$1', [result.message.id])).rows[0]; assert.equal(source.content.length, 12000); assert.equal(source.status, 'failed'); const next = await post('Humans continue after context limit'); assert.equal(next.message.status, 'done');
    });
    await test('Actual adapter rejects late provider content when specialist is removed from current room', async () => {
        let started, release; const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
        runtimeBehavior = async () => { started(); await held; return { message: { role: 'assistant', content: 'LATE REMOVED PROVIDER OUTPUT' }, done_reason: 'stop' }; };
        try { const source = await post('Hold actual provider for room exclusion', { targetAgentIds: [ids[0]] }); await bounded(began, 'held provider'); const current = await service.read(main, projectId); await bounded(service.participants(main, projectId, { expectedRevision: current.room.revision, agentIds: [] }), 'remove while provider held'); release(); await bounded(service.runner.waitIdle(), 'removed late provider'); const rows = (await pool.query('SELECT content,status FROM project_chat_messages WHERE source_message_id=$1', [source.message.id])).rows; assert.ok(rows.every(row => !row.content.includes('LATE REMOVED PROVIDER OUTPUT'))); assert.equal((await post('Human post after removal')).message.status, 'done'); } finally { release(); runtimeBehavior = undefined; }
    });
    await test('Actual adapter generation/lease fence rejects a provider result arriving after cancellation', async () => {
        let started, release; const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; }); const current = await service.read(main, projectId); await service.participants(main, projectId, { expectedRevision: current.room.revision, modelId, expectedModelPin: pin, agentIds: [ids[0]] });
        runtimeBehavior = async () => { started(); await held; return { message: { role: 'assistant', content: 'LATE CANCELLED PROVIDER OUTPUT' }, done_reason: 'stop' }; };
        try { const source = await post('Hold actual provider for cancellation', { targetAgentIds: [ids[0]] }); await bounded(began, 'held cancel provider'); await service.cancel(user, projectId, source.message.id, {}); release(); await bounded(service.runner.waitIdle(), 'cancel late provider'); const rows = (await pool.query('SELECT content,status FROM project_chat_messages WHERE source_message_id=$1', [source.message.id])).rows; assert.ok(rows.every(row => row.status === 'cancelled' && !row.content.includes('LATE CANCELLED PROVIDER OUTPUT'))); } finally { release(); runtimeBehavior = undefined; }
    });
    await test('Archive during controlled usage reservation denies fresh provider dispatch while history and exact ACK remain available', async () => {
        const before = calls.length, draft = { requestKey: randomUUID(), prompt: 'Archive during usage admission wait', targetAgentIds: [ids[0]] };
        runtimeReservation = async () => { await observer.query("UPDATE projects SET state='ARCHIVED' WHERE id=$1", [projectId]); };
        try { const accepted = await service.send(user, projectId, draft); await bounded(service.runner.waitIdle(), 'archive after usage wait'); assert.equal(calls.length, before); const detail = await service.read(user, projectId); assert.equal(detail.canPost, false); assert.ok(detail.messages.some(row => row.id === accepted.message.id && row.status === 'failed')); assert.equal((await service.send(user, projectId, draft)).message.id, accepted.message.id); await assert.rejects(post('Fresh post after archive'), error => error.status === 403); } finally { runtimeReservation = undefined; await pool.query("UPDATE projects SET state='ACTIVE' WHERE id=$1", [projectId]); }
    });
    await test('Completed answer survives learning toggle during provider call; next explicit request uses fresh learning context', async () => {
        const before = calls.length; flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_learning: false });
        runtimeBehavior = async () => { flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_learning: true }); return { message: { role: 'assistant', content: 'PAID ANSWER PRESERVED ACROSS LEARNING TOGGLE' }, done_reason: 'stop' }; };
        try { const source = await post('First question before learning toggle', { targetAgentIds: [ids[0]] }); await bounded(service.runner.waitIdle(), 'paid result learning toggle'); assert.equal(calls.length - before, 1); const response = (await pool.query("SELECT content,status FROM project_chat_messages WHERE source_message_id=$1 AND kind='agent'", [source.message.id])).rows[0]; assert.equal(response.status, 'done'); assert.equal(response.content, 'PAID ANSWER PRESERVED ACROSS LEARNING TOGGLE'); assert.ok(!calls[before].context.requiredFeatures.includes('project_learning'));
            runtimeBehavior = undefined; await post('Second explicit question after learning enabled', { targetAgentIds: [ids[0]] }); await bounded(service.runner.waitIdle(), 'fresh learning on next explicit request'); assert.equal(calls.length - before, 2); assert.ok(calls.at(-1).context.requiredFeatures.includes('project_learning'));
        } finally { runtimeBehavior = undefined; flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_learning: false }); }
    });
    await test('Developer creates a private room and explicitly configures assigned models/agents without an administrator', async () => {
        const room = await service.createRoom(user, projectId, {requestKey: randomUUID(), title: 'Private developer dialogue', visibility: 'PRIVATE', memberEmails: ['observer@adapter.test']});
        const initial = await service.read(user, projectId, undefined, room.id); assert.equal(initial.canConfigure, true);
        await service.participants(user, projectId, {expectedRevision: initial.room.revision, modelId, expectedModelPin: pin, agentIds: [ids[0]]}, room.id);
        const parent = await service.send(user, projectId, {requestKey: randomUUID(), prompt: 'PRIVATE ROOM ANCESTOR SENTINEL', targetAgentIds: []}, room.id), before = calls.length;
        const accepted = await service.send(user, projectId, {requestKey: randomUUID(), prompt: 'Private specialist question', replyToId: parent.message.id, targetAgentIds: [ids[0]]}, room.id);
        await bounded(service.runner.waitIdle(), 'developer private inference'); assert.equal(calls.length - before, 1); assert.equal(calls.at(-1).context.privateProjectChatRoomId, room.id); assert.ok(JSON.stringify(calls.at(-1).body).includes('PRIVATE ROOM ANCESTOR SENTINEL'));
        const detail = await service.read(user, projectId, undefined, room.id); assert.ok(detail.messages.some(message => message.kind === 'agent' && message.status === 'done'));
        await assert.rejects(service.read(main, projectId, undefined, room.id), error => error.status === 404);
        const beforePublic = calls.length; await assert.rejects(post('Public attempt to quote a private parent', {replyToId: parent.message.id, targetAgentIds: [ids[0]]}), error => error.status === 404); assert.equal(calls.length, beforePublic);
        await post('Public specialist question without private history', {targetAgentIds: [ids[0]]}); await bounded(service.runner.waitIdle(), 'public context isolation'); assert.equal(calls.at(-1).context.privateProjectChatRoomId, undefined); assert.ok(!JSON.stringify(calls.at(-1).body).includes('PRIVATE ROOM ANCESTOR SENTINEL'));
    });
    await test('Private membership revocation during controlled admission wait prevents a physical provider call', async () => {
        const room = await service.createRoom(main, projectId, {requestKey: randomUUID(), title: 'Private wait guard', visibility: 'PRIVATE', memberEmails: ['user@adapter.test']});
        await service.participants(main, projectId, {expectedRevision: room.revision, modelId, expectedModelPin: pin, agentIds: [ids[0]]}, room.id);
        const audience = await service.read(user, projectId, undefined, room.id); assert.deepEqual(audience.members.map(member => member.email).sort(), ['main@adapter.test', 'user@adapter.test']);
        const before = calls.length; runtimeReservation = async () => {const current = await service.read(main, projectId, undefined, room.id); await service.updateRoom(main, projectId, room.id, {expectedRevision: current.room.revision, title: room.title, memberEmails: []});};
        try {await service.send(user, projectId, {requestKey: randomUUID(), prompt: 'Revoke during private admission', targetAgentIds: [ids[0]]}, room.id); await bounded(service.runner.waitIdle(), 'private wait revocation'); assert.equal(calls.length, before); await assert.rejects(service.read(user, projectId, undefined, room.id), error => error.status === 404);} finally {runtimeReservation = undefined;}
    });
    await test('Private membership revocation after provider dispatch prevents publication of the late answer', async () => {
        const room = await service.createRoom(main, projectId, {requestKey: randomUUID(), title: 'Private late answer guard', visibility: 'PRIVATE', memberEmails: ['user@adapter.test']});
        await service.participants(main, projectId, {expectedRevision: room.revision, modelId, expectedModelPin: pin, agentIds: [ids[0]]}, room.id);
        let began, release; const started = new Promise(resolve => {began = resolve;}), held = new Promise(resolve => {release = resolve;});
        runtimeBehavior = async () => {began(); await held; return {message: {role: 'assistant', content: 'LATE PRIVATE ADAPTER CONTENT'}, done_reason: 'stop'};};
        try {const accepted = await service.send(user, projectId, {requestKey: randomUUID(), prompt: 'Hold private provider answer', targetAgentIds: [ids[0]]}, room.id); await bounded(started, 'private provider held'); const current = await service.read(main, projectId, undefined, room.id); await service.updateRoom(main, projectId, room.id, {expectedRevision: current.room.revision, title: room.title, memberEmails: []}); release(); await bounded(service.runner.waitIdle(), 'private late publication'); const rows = (await observer.query('SELECT content FROM project_chat_messages WHERE source_message_id=$1', [accepted.message.id])).rows; assert.ok(rows.every(row => !row.content.includes('LATE PRIVATE ADAPTER CONTENT')));} finally {release(); runtimeBehavior = undefined;}
    });
    await test('Group-chat OFF after claim and before dispatch spends no provider call', async () => {
        const before = calls.length; runtimeReservation = async () => {flags = evaluateFeatureFlags({...defaultFeatureFlags(), project_learning: false, group_chat: false});};
        try {await post('Toggle group chat during model admission', {targetAgentIds: [ids[0]]}); await bounded(service.runner.waitIdle(), 'group flag before provider'); assert.equal(calls.length, before);} finally {runtimeReservation = undefined; flags = evaluateFeatureFlags({...defaultFeatureFlags(), project_learning: false});}
    });
    await test('Real missing model assignment cannot block human history or ordinary posting', async () => {
        await pool.query('DELETE FROM project_models WHERE project_id=$1 AND model_id=$2', [projectId, modelId]); const detail = await bounded(service.read(user, projectId), 'read without assignment'); assert.ok(detail.messages.length); assert.ok(detail.agents.every(row => row.status === 'blocked')); const before = calls.length, human = await post('No model still human chat'); assert.equal(human.message.status, 'done'); assert.equal(calls.length, before);
    });
    receipt.ok = receipt.cases.every(row => row.ok);
} catch (error) { receipt.ok = false; receipt.initializationError = { name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack }; }
finally {
    const errors = []; for (const [name, close] of [['service', () => service?.onApplicationShutdown()], ['single model pool', () => single?.end()], ['access', () => access?.onModuleDestroy()], ['control pool', () => pool?.end()], ['observer', () => observer?.end()], ['flags', () => server && new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })]]) try { await bounded(Promise.resolve(close()), 'close ' + name, 10000); } catch (error) { errors.push({ name, message: error.message }); }
    try { if (created) { await admin.query('DROP DATABASE "' + database + '"'); receipt.ownDatabaseDropped = true; } receipt.originalDatabasesPreserved = JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows) === JSON.stringify(beforeDatabases); } catch (error) { errors.push({ name: 'database cleanup', message: error.message }); }
    await admin.end(); for (const [file, hash] of Object.entries(hashes)) if (sha(await readFile(path.join(root, 'services/catalog-service/src', file))) !== hash) { receipt.sourceDrift ??= []; receipt.sourceDrift.push(file); }
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original);
    receipt.cleanupErrors = errors; receipt.finishedAt = new Date().toISOString(); if (errors.length || receipt.sourceDrift?.length || !receipt.originalDatabasesPreserved) receipt.ok = false; await writeFile(path.join(output, 'adapter-native-qa-receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1;
}
