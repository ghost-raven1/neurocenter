/** Run explicitly against a fresh owned fixture: --owned-postgres-config /absolute/path/to/cluster/connection.json. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { admit, ownedConnection, output, root, Pool } from './project-team-chat-owned.fixture.mjs';

const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json') });
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const sha = value => createHash('sha256').update(value).digest('hex');
const files = ['project-chat/project-chat.schema.ts', 'project-chat/project-chat.schema-contract.ts', 'project-chat/project-chat.schema-verification.ts', 'project-chat/project-chat.policy.ts', 'project-chat/project-chat.repository.ts', 'project-chat/project-chat.runner.ts', 'project-chat/project-chat.service.ts', 'project-chat/project-chat.validation.ts', 'project-chat/project-chat.types.ts', 'project-chat/project-chat-project.ts', 'project-chat/project-chat-dialogs.ts', 'project-chat/project-chat-room-access.ts', 'project-chat/project-chat-dialogs.schema.ts', 'project-chat/project-chat-dialogs.schema-contract.ts', 'project-chat/project-chat-dialogs.schema-verification.ts', 'database/catalog-migrations.ts', 'database/current-schema-verification.ts'];
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, 'services/catalog-service/src', file)))])));
const { ensureCatalogSchema, checkCatalogSchema } = load('database/catalog-schema.ts');
const { assertCurrentProjectChatSchema: assertProjectChatSchema } = load('project-chat/project-chat-dialogs.schema-verification.ts');
const { ProjectChatService } = load('project-chat/project-chat.service.ts');
const { ProjectChatRepository } = load('project-chat/project-chat.repository.ts');
const { ModelsService } = load('models/models.service.ts');
const { AccessDb } = load('access/access-db.ts');
const { projectLevel } = load('access/access.model.ts');
const { BadRequestException, ConflictException } = require('@nestjs/common');
const { evaluateFeatureFlags, defaultFeatureFlags } = require(path.join(root, 'services/shared/feature-flags.cjs'));
await admit();
const owned = await ownedConnection();
const admin = new Pool({ connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 3000 });
const originalEnv = { ...process.env };
const database = 'nc_project_chat_native_' + randomUUID().replaceAll('-', '');
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const token = randomUUID(), pin = 'a'.repeat(64), fallbackId = 'model-owned-chat';
let pool, observer, server, models, access, service, created = false;
let flags = evaluateFeatureFlags(defaultFeatureFlags()), cases = 0, flagQueries = 0;
const receipt = { startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, port: owned.owner.port, mainPostgresContacted: false, hashes, cases: [], limits: ['Real PostgreSQL 16.15, ProjectChatService/Repository/Runner/Policy, AccessDb and lightweight project identity; injected deterministic inference does not exercise a provider or root model adapter.', 'No browser/Gateway, external IdP, live Ceph or paid inference exercised.', 'No global coverage claim, main PostgreSQL5432 or user configuration touched.'] };
const request = (email = 'a@owned-chat.test', activeRole = 'Разработчик') => ({ headers: { 'x-neurocenter-internal': token, 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email, activeRole })) } });
const a = request(), b = request('b@owned-chat.test'), main = request('main@owned-chat.test', 'Главный админ'), projectAdmin = request('admin@owned-chat.test', 'Админ проекта'), reader = request('reader@owned-chat.test', 'Наблюдатель');
const actor = { email: 'a@owned-chat.test', activeRole: 'Разработчик' };
const status = number => error => error.status === number;
const code = value => error => error.code === value;
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const bounded = async (promise, label, ms = 5000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned QA timeout: ' + label)), ms); })]); } finally { clearTimeout(timer); } };
const snapshots = new Map(['front', 'back', 'qa'].map(name => { const body = { agentId: 'agent-owned-' + name, name: name.toUpperCase(), slug: 'nc-' + name, version: 1, manifest: 'b'.repeat(64), definition: { description: 'Specialist ' + name, prompt: 'PRIVATE PERSONA ' + name, mode: 'all', permission: {} }, modelId: fallbackId, modelName: 'Owned deterministic model', modelPin: pin }; return [body.agentId, { ...body, sha256: sha(JSON.stringify(body)) }]; }));
const allAgents = [...snapshots.keys()], calls = [];
let behavior = async ({ source, response }) => ({ content: response.snapshot.agentId + ' answers ' + source.id + ': ' + source.content, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, reported: true } });
const inference = {
    async roster(_req, _id, room) { return room.agent_ids.map(id => ({ agentId: id, name: snapshots.get(id)?.name || id, slug: snapshots.get(id)?.slug || id, status: snapshots.has(id) ? 'active' : 'removed' })); },
    async resolve(_req, _id, room, ids) { assert.equal(room.model_id, fallbackId); assert.equal(room.model_pin, pin); return ids.map(id => { if (!snapshots.has(id)) throw new ConflictException('Changed agent'); return JSON.parse(JSON.stringify(snapshots.get(id))); }); },
    async assert(_req, _id, snapshot) { if (snapshots.get(snapshot.agentId)?.sha256 !== snapshot.sha256) throw new ConflictException('Agent snapshot changed'); },
    async infer(input) { calls.push({ sourceId: input.source.id, source: input.source.content, parentId: input.source.reply_to_id, responseId: input.response.id, agentId: input.response.snapshot.agentId }); return behavior(input); },
};
const send = (projectId, req = a, extra = {}) => service.send(req, projectId, { requestKey: randomUUID(), prompt: 'Question ' + randomUUID(), targetAgentIds: [], ...extra });
async function project() {
    const id = 'prj-native-chat-' + randomUUID();
    await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [id, 'Owned chat ' + (++cases)]);
    for (const [email, role] of [['a@owned-chat.test', 'Разработчик'], ['b@owned-chat.test', 'Разработчик'], ['admin@owned-chat.test', 'Админ проекта'], ['reader@owned-chat.test', 'Наблюдатель']]) await pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)', [id, email, role]);
    return id;
}
async function configure(id, agents = allAgents) { const detail = await service.read(main, id); return service.participants(main, id, { expectedRevision: detail.room.revision, modelId: fallbackId, expectedModelPin: pin, agentIds: agents }); }
async function children(id, source) { return (await pool.query('SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 ORDER BY position', [id, source])).rows; }
async function test(name, run) {
    const started = Date.now();
    try { await run(); receipt.cases.push({ name, ok: true, ms: Date.now() - started }); }
    catch (error) { receipt.cases.push({ name, ok: false, ms: Date.now() - started, error: { name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack?.split('\n').slice(0, 4) } }); }
    finally { flags = evaluateFeatureFlags(defaultFeatureFlags()); }
}

try {
    await admin.query('CREATE DATABASE "' + database + '"'); created = true;
    const url = new URL(owned.url); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 6, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
    observer = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
    server = createServer((req, res) => { if (req.headers['x-neurocenter-internal'] !== token) { res.writeHead(403).end(); return; } if (req.url === '/internal/feature-flags/evaluated') { flagQueries++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(flags)); } else { req.resume(); res.writeHead(req.url === '/internal/events' ? 204 : 404).end(); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { CATALOG_PG_URL: url.href, NODE_ENV: 'production', SSO_DISABLE: 'false', NEUROCENTER_INTERNAL_TOKEN: token, FEATURE_FLAGS_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, API_GATEWAY_URL: 'http://127.0.0.1:' + server.address().port });
    await ensureCatalogSchema(pool);
    const schema = await checkCatalogSchema(pool, true); assert.deepEqual(schema.applied, Array.from({ length: 27 }, (_, i) => i)); assert.equal(schema.ready, true);
    receipt.cases.push({ name: 'All27 migrations0..26 apply and repeated physical readiness passes', ok: true });
    for (const [email, name, isMain] of [['a@owned-chat.test', 'User A', false], ['b@owned-chat.test', 'User B', false], ['admin@owned-chat.test', 'Project Admin', false], ['reader@owned-chat.test', 'Reader', false], ['main@owned-chat.test', 'Main', true]]) await pool.query('INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,$2,$3)', [email, name, isMain]);
    access = new AccessDb(); await access.ready();
    const catalog = { ensureSchema: () => ensureCatalogSchema(pool), getProject: async id => { const row = (await pool.query('SELECT id,name,state FROM projects WHERE id=$1 OR name=$1', [id])).rows[0]; if (!row) { const { NotFoundException } = require('@nestjs/common'); throw new NotFoundException('Project absent'); } return row; } };
    models = new ModelsService(catalog, access);
    catalog.getProject = async () => { throw new Error('UNEXPECTED heavyweight CatalogService.getProject: shared chat must not require RAG HTTP or filesystem stats'); };
    service = new ProjectChatService(models, inference);

    await test('Full physical assertion detects source FK and immutability function drift', async () => {
        const db = await pool.connect();
        try { await db.query('BEGIN'); const fk = (await db.query("SELECT conname FROM pg_constraint WHERE conrelid='project_chat_messages'::regclass AND contype='f' AND pg_get_constraintdef(oid) LIKE '%source_message_id%'")).rows[0].conname; await db.query('ALTER TABLE project_chat_messages DROP CONSTRAINT "' + fk + '"'); await assert.rejects(assertProjectChatSchema(db), /не готова/); await db.query('ROLLBACK'); await db.query('BEGIN'); await db.query("CREATE OR REPLACE FUNCTION neurocenter_project_chat_message_immutable() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'"); await assert.rejects(assertProjectChatSchema(db), /не готова/); } finally { await db.query('ROLLBACK'); db.release(); } await assertProjectChatSchema(pool);
    });
    await test('Two users concurrently append without room revision or a model and share author snapshots', async () => {
        const id = await project(), before = calls.length;
        const results = await Promise.all(Array.from({ length: 10 }, (_, n) => send(id, n % 2 ? a : b, { prompt: 'Concurrent human ' + n })));
        assert.equal(new Set(results.map(row => row.message.id)).size, 10); await service.runner.waitIdle(); assert.equal(calls.length, before);
        const detailA = await service.read(a, id), detailB = await service.read(b, id); assert.deepEqual(detailA.messages, detailB.messages); assert.equal(detailA.messages.length, 10); assert.equal(detailA.room.modelId, null); assert.equal(detailA.members.length, 4); assert.ok(detailA.messages.every(row => row.status === 'done' && row.author?.displayName));
    });
    await test('Accepted post replay remains exact after OFF; new post and changed-body reuse do not write', async () => {
        const id = await project(), draft = { requestKey: randomUUID(), prompt: 'Durable ACK retry', targetAgentIds: [] }, first = await service.send(a, id, draft);
        flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_chat: false }); const count = flagQueries;
        assert.equal((await service.send(a, id, draft)).message.id, first.message.id); assert.equal(flagQueries, count);
        await assert.rejects(send(id), status(403)); await assert.rejects(service.send(a, id, { ...draft, prompt: 'Different' }), status(409)); assert.equal((await service.read(b, id)).messages.length, 1);
    });
    await test('Same request key is author-scoped; exact concurrent retry creates one row per author', async () => {
        const id = await project(), draft = { requestKey: randomUUID(), prompt: 'Shared request key', targetAgentIds: [] };
        const same = await Promise.all(Array.from({ length: 6 }, () => service.send(a, id, draft))); assert.equal(new Set(same.map(value => value.message.id)).size, 1);
        const other = await service.send(b, id, draft); assert.notEqual(other.message.id, same[0].message.id); assert.equal((await service.read(main, id)).messages.length, 2);
    });
    await test('Current projectLevel semantics: observer read-only, unrelated active admin caps to developer, unassigned role denied', async () => {
        const id = await project(), elsewhere = await project();
        await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'a-admin-role','a@owned-chat.test','A admin elsewhere','Админ проекта')", [elsewhere]);
        const adminRoleA = request('a@owned-chat.test', 'Админ проекта'), claims = await access.claims('a@owned-chat.test'); assert.equal(projectLevel(claims, 'Админ проекта', id), 2);
        const detail = await service.read(adminRoleA, id); assert.equal(detail.canPost, true); assert.equal(detail.canConfigure, false);
        await send(id, adminRoleA); await assert.rejects(service.participants(adminRoleA, id, { expectedRevision: detail.room.revision, agentIds: [] }), status(403));
        const readonly = await service.read(reader, id); assert.equal(readonly.canPost, false); await assert.rejects(send(id, reader), status(403)); await assert.rejects(service.read(request('b@owned-chat.test', 'Главный админ'), id), status(403));
    });
    await test('Strict DTO whitelist, byte/UUID/agent bounds and device identity prevent spoofed attribution', async () => {
        const id = await project();
        for (const patch of [{ author_email: 'main@owned-chat.test' }, { author: { email: 'main@owned-chat.test' } }, { status: 'done' }, { expectedRevision: 0 }, { prompt: 'x'.repeat(131073) }, { prompt: '\0' }, { replyToId: 'wrong' }, { targetAgentIds: ['agent-owned-front', 'agent-owned-front'] }]) await assert.rejects(send(id, a, patch), status(400));
        await assert.rejects(service.participants(main, id, { expectedRevision: 0, agentIds: [], unknown: true }), status(400));
        await assert.rejects(service.read({ headers: { ...a.headers, 'x-neurocenter-device-id': randomUUID() } }, id), status(403)); assert.equal((await service.read(a, id)).messages.length, 0);
    });
    await test('Replies reference human or agent message in exact room; crossroom rejection is also enforced by SQL FK', async () => {
        const id = await project(), other = await project(), first = await send(id), foreign = await send(other);
        const reply = await send(id, b, { replyToId: first.message.id, prompt: 'Reply to human' }); assert.equal(reply.message.replyToId, first.message.id);
        await assert.rejects(send(id, a, { replyToId: foreign.message.id }), status(404));
        await configure(id, [allAgents[0]]); const addressed = await send(id, a, { targetAgentIds: [allAgents[0]] }); await service.runner.waitIdle(); const agent = (await children(id, addressed.message.id)).find(row => row.kind === 'agent');
        const answer = await send(id, b, { replyToId: agent.id, prompt: 'Reply to agent' }); assert.equal(answer.message.replyToId, agent.id);
        const summary = (await children(id, addressed.message.id)).find(row => row.kind === 'summary'); await assert.rejects(send(id, b, { replyToId: summary.id }), status(409));
        await assert.rejects(pool.query('UPDATE project_chat_messages SET reply_to_id=$2 WHERE id=$1', [reply.message.id, foreign.message.id]), /immutable/);
        const draft = { requestKey: randomUUID(), prompt: 'SQL foreign parent', targetAgentIds: [] }; await assert.rejects(service.repository.scoped(id, actor, 2, true, async (db, room, current) => service.repository.add(db, room, current, { ...draft, replyToId: foreign.message.id, hash: 'f'.repeat(64) }, [])), code('23503'));
    });
    await test('Two users and three independent questions each receive three specialist replies and source-linked deterministic result', async () => {
        const id = await project(); await configure(id); const before = calls.length;
        const sources = await Promise.all([send(id, a, { prompt: 'Frontend question', targetAgentIds: allAgents }), send(id, b, { prompt: 'Backend question', targetAgentIds: allAgents }), send(id, a, { prompt: 'QA question', targetAgentIds: allAgents })]);
        await bounded(service.runner.waitIdle(), 'three question queue');
        assert.equal(calls.length - before, 9);
        for (const { message } of sources) { const rows = await children(id, message.id), replies = rows.filter(row => row.kind === 'agent'), summary = rows.find(row => row.kind === 'summary'); assert.equal(replies.length, 3); assert.ok(replies.every(row => row.status === 'done' && row.reply_to_id === message.id && row.content.includes(message.id))); assert.equal(new Set(replies.map(row => row.snapshot.agentId)).size, 3); assert.equal(summary.status, 'done'); assert.ok(summary.content.includes(message.id)); for (const row of replies) assert.ok(summary.content.includes(row.id)); }
        const publicView = JSON.stringify(await service.read(b, id)); for (const field of ['PRIVATE PERSONA', 'request_hash', 'author_role', 'lease_until', 'generation', 'manifest']) assert.ok(!publicView.includes(field), 'Public payload leaks ' + field);
    });
    await test('Human append remains available during inference; queued cancel and OFF running cancel preserve terminal fence', async () => {
        const id = await project(); await configure(id, [allAgents[0]]); const started = defer();
        const previous = behavior; behavior = async input => { started.resolve(); await new Promise((_, reject) => { if (input.signal.aborted) reject(input.signal.reason); else input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); }); throw Error('unreachable'); };
        try { const running = await send(id, a, { targetAgentIds: [allAgents[0]] }); await bounded(started.promise, 'provider started'); const queued = await send(id, b, { targetAgentIds: [allAgents[0]] }); const ordinary = await send(id, b, { prompt: 'Human chat while busy' }); assert.equal(ordinary.message.status, 'done'); flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_chat: false }); await service.cancel(b, id, queued.message.id, {}); await service.cancel(a, id, running.message.id, {}); await bounded(service.runner.waitIdle(), 'cancelled drain'); const rows = (await service.read(main, id)).messages; assert.equal(rows.find(row => row.id === queued.message.id).status, 'cancelled'); assert.equal(rows.find(row => row.id === running.message.id).status, 'cancelled'); assert.ok(rows.some(row => row.id === ordinary.message.id && row.status === 'done')); } finally { behavior = previous; }
    });
    await test('Failed specialist alone retries; successful response is immutable and does not incur a second call', async () => {
        const id = await project(); await configure(id, allAgents.slice(0, 2)); const previous = behavior; let failed = false;
        behavior = async input => { if (input.response.snapshot.agentId === allAgents[1] && !failed) { failed = true; throw Error('secret-provider-credential'); } return previous(input); };
        try { const source = await send(id, a, { targetAgentIds: allAgents.slice(0, 2) }); await service.runner.waitIdle(); const initial = await children(id, source.message.id), saved = initial.find(row => row.kind === 'agent' && row.status === 'done'); assert.equal(initial.find(row => row.kind === 'summary').status, 'failed'); const before = calls.length, key = randomUUID(); const retried = await service.retry(a, id, source.message.id, { requestKey: key }); await service.runner.waitIdle(); assert.equal(calls.length - before, 1); const final = await children(id, source.message.id); assert.equal(final.find(row => row.id === saved.id).content, saved.content); assert.equal(final.find(row => row.id === saved.id).generation, saved.generation); assert.ok(final.every(row => row.status === 'done')); flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_chat: false }); await service.retry(a, id, source.message.id, { requestKey: key }); assert.equal(calls.length - before, 1); await assert.rejects(pool.query("UPDATE project_chat_messages SET content='tamper' WHERE id=$1", [saved.id]), /immutable/); assert.ok(!JSON.stringify(retried).includes('secret-provider-credential')); } finally { behavior = previous; }
    });
    await test('Fresh membership/account revocation denies reading and exact accepted replay without disclosing stored text', async () => {
        const id = await project(), draft = { requestKey: randomUUID(), prompt: 'Membership private', targetAgentIds: [] }; await service.send(a, id, draft); await pool.query("DELETE FROM project_members WHERE project_id=$1 AND principal_name='a@owned-chat.test'", [id]); await assert.rejects(service.read(a, id), status(403)); await assert.rejects(service.send(a, id, draft), status(403)); await pool.query("UPDATE platform_users SET enabled=false WHERE email='b@owned-chat.test'"); try { await assert.rejects(service.read(b, id), status(403)); } finally { await pool.query("UPDATE platform_users SET enabled=true WHERE email='b@owned-chat.test'"); }
    });
    await test('Revocation while provider runs fences late model content and avoids later recipients', async () => {
        const id = await project(); await configure(id, allAgents.slice(0, 2)); const previous = behavior, before = calls.length;
        behavior = async input => { await observer.query("DELETE FROM project_members WHERE project_id=$1 AND principal_name='a@owned-chat.test'", [id]); return { content: 'LATE PRIVATE MODEL CONTENT' }; };
        try { const source = await send(id, a, { targetAgentIds: allAgents.slice(0, 2) }); await service.runner.waitIdle(); const rows = await children(id, source.message.id); assert.equal(calls.length - before, 1); assert.ok(rows.every(row => row.status === 'failed' && !row.content.includes('LATE PRIVATE MODEL CONTENT'))); await assert.rejects(service.read(a, id), status(403)); } finally { behavior = previous; }
    });
    await test('Excluding agent during provider wait rejects late answer but keeps room and ordinary posts usable', async () => {
        const id = await project(); await configure(id, [allAgents[0]]); const previous = behavior;
        behavior = async input => { const detail = await service.read(main, id); await service.participants(main, id, { expectedRevision: detail.room.revision, agentIds: [] }); return { content: 'REMOVED AGENT MUST NOT COMMIT' }; };
        try { const source = await send(id, a, { targetAgentIds: [allAgents[0]] }); await service.runner.waitIdle(); assert.ok((await children(id, source.message.id)).every(row => !row.content.includes('REMOVED AGENT MUST NOT COMMIT'))); const human = await send(id, b); assert.equal(human.message.status, 'done'); } finally { behavior = previous; }
    });
    await test('Expired running attempt is failed without automatic paid retry; stale generation cannot publish', async () => {
        const id = await project(); await configure(id, [allAgents[0]]); const previousSchedule = service.runner.schedule; service.runner.schedule = () => {};
        let source; try { source = await send(id, a, { targetAgentIds: [allAgents[0]] }); } finally { service.runner.schedule = previousSchedule; }
        const job = await service.repository.claim(id), before = calls.length;
        await pool.query("UPDATE project_chat_messages SET lease_until=now()-interval '1 second' WHERE project_id=$1 AND status='running'", [id]); await service.repository.recover(); assert.equal(calls.length, before); await assert.rejects(service.repository.assertRunning(pool, id, source.message.id, job.generation), status(409)); assert.ok((await children(id, source.message.id)).every(row => row.status === 'failed'));
    });
    await test('Queue wakeup accepted after empty claim is not lost at worker-finally boundary', async () => {
        const id = await project(); await configure(id, [allAgents[0]]); const empty = defer(), release = defer(), claim = service.repository.claim.bind(service.repository); let intercept = true;
        service.repository.claim = async value => { const job = await claim(value); if (value === id && !job && intercept) { intercept = false; empty.resolve(); await release.promise; } return job; };
        try { service.runner.schedule(id); await bounded(empty.promise, 'empty claim barrier'); const source = await send(id, a, { targetAgentIds: [allAgents[0]] }); release.resolve(); await bounded(service.runner.waitIdle(), 'dirty queue reschedule'); assert.equal((await service.repository.message(pool, id, source.message.id)).status, 'done'); } finally { release.resolve(); service.repository.claim = claim; }
    });
    await test('Production transaction destroys unrolled-back session and preserves physical state after lost rollback ACK', async () => {
        const id = await project(); await send(id); const rawPool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
        try { for (const rollback of ['not-dispatched', 'ack-lost']) { let released, pid; const fault = { query: pool.query.bind(pool), connect: async () => { const client = await rawPool.connect(), query = client.query.bind(client), release = client.release.bind(client); pid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid; return { query: async (...args) => { if (args[0] === 'ROLLBACK' && rollback === 'not-dispatched') throw Error('Rollback not sent'); const result = await query(...args); if (args[0] === 'ROLLBACK' && rollback === 'ack-lost') throw Error('Rollback ACK lost'); return result; }, release: discard => { released = discard; release(discard); } }; } };
            const repository = new ProjectChatRepository(fault), before = (await observer.query('SELECT revision FROM project_chat_rooms WHERE project_id=$1', [id])).rows[0].revision, primary = new Error('Intentional owned write failure');
            await assert.rejects(repository.scoped(id, actor, 2, true, async db => { await db.query('UPDATE project_chat_rooms SET revision=revision+1 WHERE project_id=$1', [id]); throw primary; }), error => error === primary); assert.equal(released, true);
            const next = await rawPool.connect(); try { const nextPid = (await next.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; assert.notEqual(nextPid, pid); await next.query('COMMIT'); } finally { next.release(); } assert.equal((await observer.query('SELECT revision FROM project_chat_rooms WHERE project_id=$1', [id])).rows[0].revision, before);
        } } finally { await rawPool.end(); }
    });
    await test('Pagination preserves strict position order and does not permit foreign room cursors', async () => {
        const id = await project(), other = await project(), foreign = await send(other); for (let i = 0; i < 7; i++) await send(id, i % 2 ? a : b, { prompt: 'Page ' + i });
        const first = await service.history(a, id, undefined, '3'), second = await service.history(b, id, first.history.nextCursor, '3'); assert.equal(first.messages.length, 3); assert.equal(second.messages.length, 3); assert.ok(BigInt(second.messages.at(-1).position) < BigInt(first.messages[0].position)); await assert.rejects(service.history(a, id, foreign.message.id, '3'), status(404)); for (const limit of ['0', '51', 'NaN', '1.5']) await assert.rejects(service.history(a, id, undefined, limit), status(400));
    });
    await test('Archived room retains history and cancellation while new posts, retry and configuration remain denied', async () => {
        const id = await project(); await configure(id, [allAgents[0]]); const originalSchedule = service.runner.schedule; service.runner.schedule = () => {};
        let source; try { source = await send(id, a, { targetAgentIds: [allAgents[0]] }); } finally { service.runner.schedule = originalSchedule; }
        await pool.query("UPDATE projects SET state='ARCHIVED' WHERE id=$1", [id]); flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_chat: false });
        const detail = await service.read(a, id); assert.equal(detail.canPost, false); assert.equal((await service.read(main, id)).canConfigure, false); assert.ok(detail.messages.some(row => row.id === source.message.id));
        await assert.rejects(send(id), status(403)); await assert.rejects(service.retry(a, id, source.message.id, { requestKey: randomUUID() }), status(403));
        const cancelled = await service.cancel(a, id, source.message.id, {}); assert.equal(cancelled.message.status, 'cancelled'); assert.ok((await service.history(b, id)).messages.length);
    });
    await test('Author switching active role to assigned observer receives no retry or cancel capability', async () => {
        const id = await project(), elsewhere = await project(); await configure(id, [allAgents[0]]); const originalSchedule = service.runner.schedule; service.runner.schedule = () => {};
        let source; try { source = await send(id, a, { targetAgentIds: [allAgents[0]] }); } finally { service.runner.schedule = originalSchedule; }
        await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'a-observer-role','a@owned-chat.test','Observer elsewhere','Наблюдатель')", [elsewhere]);
        const observing = request('a@owned-chat.test', 'Наблюдатель'), detail = await service.read(observing, id), item = detail.messages.find(row => row.id === source.message.id); assert.equal(detail.canPost, false); assert.equal(item.canCancel, false); assert.equal(item.canRetry, false); await assert.rejects(service.cancel(observing, id, source.message.id, {}), status(403));
    });
    await test('Agent queue caps 20 per author and100 per room never cap ordinary human messages', async () => {
        const id = await project(); await configure(id, [allAgents[0]]); const originalSchedule = service.runner.schedule; service.runner.schedule = () => {};
        try {
            const authors = [a, b, projectAdmin, main];
            for (const name of ['c', 'd']) { const email = name + '@owned-chat.test'; await pool.query('INSERT INTO platform_users(email,display_name) VALUES($1,$2)', [email, name]); await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,'Разработчик')", [id, email]); authors.push(request(email)); }
            for (let i = 0; i < 20; i++) await send(id, a, { targetAgentIds: [allAgents[0]] }); await assert.rejects(send(id, a, { targetAgentIds: [allAgents[0]] }), status(409)); assert.equal((await send(id, a, { prompt: 'A human after author quota' })).message.status, 'done');
            for (const author of authors.slice(1, 5)) for (let i = 0; i < 20; i++) await send(id, author, { targetAgentIds: [allAgents[0]] });
            const queued = await pool.query("SELECT count(*) AS total FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND status='queued'", [id]); assert.equal(Number(queued.rows[0].total), 100);
            await assert.rejects(send(id, authors[5], { targetAgentIds: [allAgents[0]] }), status(409)); assert.equal((await send(id, authors[5], { prompt: 'Humans continue after room quota' })).message.status, 'done');
        } finally { service.runner.schedule = originalSchedule; }
    });
    await test('Accepted human send ACK replay succeeds after archive and OFF while fresh admissions remain denied', async () => {
        const id = await project(), draft = { requestKey: randomUUID(), prompt: 'Accepted before archive', targetAgentIds: [] }, accepted = await service.send(a, id, draft), before = calls.length;
        await pool.query("UPDATE projects SET state='ARCHIVED' WHERE id=$1", [id]); flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_chat: false });
        const repeated = await service.send(a, id, draft); assert.equal(repeated.message.id, accepted.message.id); assert.equal(repeated.message.content, draft.prompt); assert.equal(calls.length, before);
        await assert.rejects(send(id), status(403)); await assert.rejects(service.send(a, id, { ...draft, prompt: 'Changed accepted payload' }), status(409)); assert.equal((await service.read(b, id)).messages.length, 1);
    });
    await test('Accepted retry ACK replay succeeds after archive and OFF without a new attempt or provider call', async () => {
        const id = await project(); await configure(id, [allAgents[0]]); const previous = behavior; behavior = async () => { throw Error('Controlled failure before accepted retry'); };
        let source; try { source = await send(id, a, { targetAgentIds: [allAgents[0]] }); await service.runner.waitIdle(); } finally { behavior = previous; }
        const originalSchedule = service.runner.schedule; service.runner.schedule = () => {};
        try { const key = randomUUID(), accepted = await service.retry(a, id, source.message.id, { requestKey: key }), before = calls.length;
            await pool.query("UPDATE projects SET state='ARCHIVED' WHERE id=$1", [id]); flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), project_chat: false });
            const repeated = await service.retry(a, id, source.message.id, { requestKey: key }); assert.equal(repeated.message.id, accepted.message.id); assert.equal(repeated.message.status, 'queued'); assert.equal(calls.length, before);
            assert.equal(Number((await pool.query('SELECT count(*) AS total FROM project_chat_retry_requests WHERE project_id=$1', [id])).rows[0].total), 1); await assert.rejects(service.retry(a, id, source.message.id, { requestKey: randomUUID() }), status(403)); await service.cancel(a, id, source.message.id, {});
        } finally { service.runner.schedule = originalSchedule; }
    });
    await test('Removed specialist retry refuses enqueue without changing partial success or accepted request receipts', async () => {
        const id = await project(); await configure(id, allAgents.slice(0, 2)); const previous = behavior;
        behavior = async input => { if (input.response.snapshot.agentId === allAgents[1]) throw Error('Controlled missing specialist'); return previous(input); };
        let source; try { source = await send(id, a, { targetAgentIds: allAgents.slice(0, 2) }); await service.runner.waitIdle(); } finally { behavior = previous; }
        const detail = await service.read(main, id); await service.participants(main, id, { expectedRevision: detail.room.revision, modelId: fallbackId, expectedModelPin: pin, agentIds: [allAgents[0]] });
        const before = calls.length, rows = await children(id, source.message.id); await assert.rejects(service.retry(a, id, source.message.id, { requestKey: randomUUID() }), status(409)); assert.equal(calls.length, before); assert.deepEqual(await children(id, source.message.id), rows); assert.equal(Number((await pool.query('SELECT count(*) AS total FROM project_chat_retry_requests WHERE project_id=$1', [id])).rows[0].total), 0);
    });
    await test('Administrator retry cannot bypass source author queue20; exact accepted retry remains valid at full capacity', async () => {
        const id = await project(); await configure(id, [allAgents[0]]); const previous = behavior; behavior = async () => { throw Error('Controlled failure for retry admission'); };
        let source; try { source = await send(id, a, { targetAgentIds: [allAgents[0]] }); await service.runner.waitIdle(); } finally { behavior = previous; }
        const originalSchedule = service.runner.schedule; service.runner.schedule = () => {};
        try { const queued = []; for (let i = 0; i < 20; i++) queued.push(await send(id, a, { targetAgentIds: [allAgents[0]] }));
            const key = randomUUID(); await assert.rejects(service.retry(main, id, source.message.id, { requestKey: key }), status(409)); assert.equal(Number((await pool.query('SELECT count(*) AS total FROM project_chat_retry_requests WHERE project_id=$1', [id])).rows[0].total), 0); assert.equal((await send(id, a, { prompt: 'Human chat after retry cap' })).message.status, 'done');
            await service.cancel(a, id, queued[0].message.id, {}); const accepted = await service.retry(main, id, source.message.id, { requestKey: key }); assert.equal(accepted.message.status, 'queued'); assert.equal((await service.retry(main, id, source.message.id, { requestKey: key })).message.id, accepted.message.id);
            assert.equal(Number((await pool.query("SELECT count(*) AS total FROM project_chat_messages WHERE project_id=$1 AND author_email='a@owned-chat.test' AND kind='user' AND status='queued'", [id])).rows[0].total), 20);
        } finally { service.runner.schedule = originalSchedule; }
    });
    await test('Current project state stays locked until accepted post commits and concurrent archive waits', async () => {
        const id = await project(), entered = defer(), release = defer(), originalAdd = service.repository.add.bind(service.repository);
        const writer = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 }); let posting, writing;
        service.repository.add = async (...args) => { if (args[1].project_id === id) { entered.resolve(); await release.promise; } return originalAdd(...args); };
        try { posting = send(id, a, { prompt: 'Accepted before concurrent archive' }); await bounded(entered.promise, 'accepted post state lock'); const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; let committed = false;
            writing = writer.query("UPDATE projects SET state='ARCHIVED' WHERE id=$1", [id]).then(() => { committed = true; });
            let waiting = false; for (let i = 0; i < 100 && !committed; i++) { const row = (await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]; if (row?.wait_event_type === 'Lock') { waiting = true; break; } }
            assert.equal(committed, false); assert.equal(waiting, true); release.resolve(); const accepted = await posting; await writing; assert.equal(accepted.message.status, 'done'); assert.equal((await service.read(a, id)).canPost, false); await assert.rejects(send(id), status(403));
        } finally { release.resolve(); service.repository.add = originalAdd; await Promise.allSettled([posting, writing].filter(Boolean)); await writer.end(); }
    });
    await test('ACK seeds all ten slots and watched old responses finish after more than50 newer human posts without foreign leakage', async () => {
        const extras = Array.from({ length: 5 }, (_, n) => 'agent-watch-extra-' + n), started = defer(), release = defer(), previous = behavior;
        for (const id of extras) { const source = snapshots.get(allAgents[0]); snapshots.set(id, { ...source, agentId: id, name: id, slug: id, sha256: sha(id) }); }
        const ids = [...allAgents, ...extras], id = await project(); await configure(id, ids);
        behavior = async input => { if (input.source.project_id === id && input.response.snapshot.agentId === ids[0]) { started.resolve(); await release.promise; } return previous(input); };
        try { const source = await send(id, a, { prompt: 'Watch old eight-agent question', targetAgentIds: ids }); assert.equal(source.messages.length, 10); assert.equal(new Set(source.messages.map(row => row.id)).size, 10); assert.ok(source.messages.some(row => row.id === source.message.id)); const known = source.messages.map(row => row.id);
            await bounded(started.promise, 'held eight-agent first provider'); for (let n = 0; n < 55; n++) await send(id, b, { prompt: 'Newer human post ' + n });
            const foreignProject = await project(), foreign = await send(foreignProject, a, { prompt: 'FOREIGN WATCH SENTINEL' }), tail = await service.read(b, id); assert.ok(tail.messages.every(row => !known.includes(row.id))); assert.equal(tail.messages.length, 50);
            release.resolve(); await bounded(service.runner.waitIdle(), 'watched eight-agent completion'); const watched = await service.read(b, id, [...known, foreign.message.id].join(',')); assert.deepEqual(watched.history, tail.history); assert.equal(watched.messages.filter(row => known.includes(row.id)).length, 10); assert.ok(watched.messages.filter(row => known.includes(row.id)).every(row => row.status === 'done')); assert.ok(watched.messages.every(row => row.id !== foreign.message.id && !row.content.includes('FOREIGN WATCH SENTINEL')));
            assert.equal((await service.read(b, id, source.message.id)).messages.filter(row => known.includes(row.id)).length, 1, 'Watch cannot expand arbitrary source children');
            for (const invalid of ['', 'not-a-uuid', [source.message.id], [source.message.id, source.message.id].join(','), Array.from({ length: 51 }, () => randomUUID()).join(',')]) await assert.rejects(service.read(b, id, invalid), status(400));
        } finally { release.resolve(); behavior = previous; await service.runner.waitIdle(); for (const id of extras) snapshots.delete(id); }
    });
    receipt.ok = receipt.cases.every(row => row.ok);
} catch (error) { receipt.ok = false; receipt.initializationError = { name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack }; }
finally {
    const errors = [];
    for (const [name, close] of [['service', () => service?.onApplicationShutdown()], ['models', () => models?.onApplicationShutdown()], ['access', () => access?.onModuleDestroy()], ['pool', () => pool?.end()], ['observer', () => observer?.end()], ['flags', () => server && new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })]]) try { await bounded(Promise.resolve(close()), 'close ' + name, 10000); } catch (error) { errors.push({ name, message: error.message }); }
    try { if (created) { await admin.query('DROP DATABASE "' + database + '"'); receipt.ownDatabaseDropped = true; } const after = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows; receipt.originalDatabasesPreserved = JSON.stringify(after) === JSON.stringify(beforeDatabases); } catch (error) { errors.push({ name: 'database cleanup', message: error.message }); }
    await admin.end();
    for (const [file, hash] of Object.entries(hashes)) if (sha(await readFile(path.join(root, 'services/catalog-service/src', file))) !== hash) { receipt.sourceDrift ??= []; receipt.sourceDrift.push(file); }
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
    receipt.cleanupErrors = errors; receipt.finishedAt = new Date().toISOString(); if (errors.length || receipt.sourceDrift?.length || !receipt.originalDatabasesPreserved) receipt.ok = false;
    await writeFile(path.join(output, 'native-qa-receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1;
}
