/** Usage ACL and metric regression; requires a fresh, explicitly owned PostgreSQL configuration. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { admit, ownedConnection, output, root, Pool } from './model-rate-owned.fixture.mjs';

await admit();
const owned = await ownedConnection();
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json') });
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const sha = value => createHash('sha256').update(value).digest('hex');
const files = ['model-usage/model-usage.types.ts', 'model-usage/model-usage.service.ts', 'model-usage/model-usage.repository.ts', 'model-usage/model-usage-report.ts', 'model-usage/model-usage.query.ts', 'model-usage/model-usage.context.ts', 'model-usage/model-dispatch-metrics.ts', 'model-usage/model-usage-details.schema.ts', 'database/catalog-migrations.ts', 'database/current-schema-verification.ts', 'access/access.model.ts'];
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, 'services/catalog-service/src', file)))])));
const { ensureCatalogSchema, checkCatalogSchema } = load('database/catalog-schema.ts');
const { ModelUsageService } = load('model-usage/model-usage.service.ts');
const { readModelUsageReport } = load('model-usage/model-usage-report.ts');
const { ModelsService } = load('models/models.service.ts');
const { AccessDb } = load('access/access-db.ts');
const { withModelUsage } = load('model-usage/model-usage.context.ts');
const { evaluateFeatureFlags, defaultFeatureFlags } = require(path.join(root, 'services/shared/feature-flags.cjs'));
const admin = new Pool({ connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 3000 });
const originalEnv = { ...process.env }, database = 'nc_model_rate_usage_' + randomUUID().replaceAll('-', '');
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const token = randomUUID(), projectA = 'prj-rate-usage-a', projectB = 'prj-rate-usage-b';
const emails = { main: 'main@owned-rate.test', admin: 'admin@owned-rate.test', developer: 'developer@owned-rate.test', other: 'other@owned-rate.test', observer: 'observer@owned-rate.test', foreign: 'foreign@owned-rate.test', deleted: 'deleted@owned-rate.test' };
const request = (email = emails.main, activeRole = 'Главный админ') => ({ headers: { 'x-neurocenter-internal': token, 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email, activeRole })) } });
const main = request(), projectAdmin = request(emails.admin, 'Админ проекта'), developer = request(emails.developer, 'Разработчик'), observer = request(emails.observer, 'Наблюдатель');
const status = number => error => error.status === number;
const receipt = { startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, port: owned.owner.port, mainPostgresContacted: false, hashes, cases: [], limits: ['Real PostgreSQL, ModelUsageService/Repository, ModelsService.actor and AccessDb; seeded historical receipts exercise report authorization and metadata facets.', 'Loopback flag service only; no external provider, live project data, browser or main PostgreSQL.', 'Partial native regression does not establish repository-wide coverage or production readiness.'] };
const test = async (name, action) => { const started = Date.now(); try { await action(); receipt.cases.push({ name, ok: true, ms: Date.now() - started }); } catch (error) { receipt.cases.push({ name, ok: false, ms: Date.now() - started, error: { name: error.name, message: error.message, status: error.status, stack: error.stack?.split('\n').slice(0, 6) } }); } };
const report = (req = main, query = {}) => service.report(req, query);
const sumRequests = rows => rows.reduce((sum, row) => sum + row.requests, 0);
let pool, models, access, service, server, created = false, flags = evaluateFeatureFlags(defaultFeatureFlags());
try {
    await admin.query('CREATE DATABASE "' + database + '"'); created = true;
    const url = new URL(owned.url); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 4000 });
    server = createServer((req, res) => { if (req.headers['x-neurocenter-internal'] !== token) { res.writeHead(403).end(); return; } if (req.url === '/internal/feature-flags/evaluated') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(flags)); } else { req.resume(); res.writeHead(req.url === '/internal/events' ? 204 : 404).end(); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { CATALOG_PG_URL: url.href, NODE_ENV: 'production', SSO_DISABLE: 'false', NEUROCENTER_INTERNAL_TOKEN: token, FEATURE_FLAGS_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, API_GATEWAY_URL: 'http://127.0.0.1:' + server.address().port });
    await ensureCatalogSchema(pool);
    await pool.query('INSERT INTO projects(id,name) VALUES($1,$2),($3,$4)', [projectA, 'Authorized project A', projectB, 'FOREIGN PROJECT B SENTINEL']);
    for (const [kind, email] of Object.entries(emails).filter(([kind]) => kind !== 'deleted')) await pool.query('INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,$2,$3)', [email, kind === 'foreign' ? 'FOREIGN USER SENTINEL' : 'Name ' + kind, kind === 'main']);
    for (const [projectId, email, role] of [[projectA, emails.admin, 'Админ проекта'], [projectB, emails.admin, 'Разработчик'], [projectA, emails.developer, 'Разработчик'], [projectA, emails.other, 'Разработчик'], [projectA, emails.observer, 'Наблюдатель'], [projectB, emails.foreign, 'Разработчик']]) await pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)', [projectId, email, role]);
    for (const [id, name] of [['agent-rate-a', 'Visible agent A'], ['agent-rate-b', 'Visible agent B'], ['agent-rate-secret', 'FOREIGN AGENT SENTINEL']]) await pool.query("INSERT INTO agent_catalog(id,slug,name,definition,version,manifest) VALUES($1,$1,$2,'{}',1,$3)", [id, name, 'a'.repeat(64)]);
    access = new AccessDb(); await access.ready();
    const catalog = { ensureSchema: () => ensureCatalogSchema(pool), getProject: async id => { const row = (await pool.query('SELECT id,name,state FROM projects WHERE id=$1', [id])).rows[0]; if (!row) throw new Error('Unknown own fixture project'); return row; } };
    models = new ModelsService(catalog, access); service = new ModelUsageService(models); await service.onModuleInit();
    const rows = [
        { actor: emails.developer, project: projectA, model: 'model-visible-a', agent: 'agent-rate-a', endpoint: 'chat', purpose: 'chat', status: 'success', dispatch: 1 },
        { actor: emails.other, project: projectA, model: 'model-visible-b', agent: 'agent-rate-b', endpoint: 'embed', purpose: 'agent', status: 'error', dispatch: 1 },
        { actor: emails.deleted, project: projectA, model: 'model-historical', agent: null, endpoint: 'chat', purpose: 'direct', status: 'cancelled', dispatch: 0 },
        { actor: null, project: projectA, model: 'model-visible-a', agent: null, endpoint: 'embed', purpose: 'reindex', status: 'success', dispatch: 1 },
        { actor: emails.developer, project: projectB, model: 'model-secret', agent: 'agent-rate-secret', endpoint: 'chat', purpose: 'learning', status: 'success', dispatch: 1 },
        { actor: emails.foreign, project: projectB, model: 'model-secret', agent: 'agent-rate-secret', endpoint: 'chat', purpose: 'direct', status: 'success', dispatch: 1 },
        { actor: emails.developer, project: null, model: 'model-personal', agent: null, endpoint: 'chat', purpose: 'chat', status: 'success', dispatch: null },
        { actor: null, project: null, model: 'model-global-task', agent: null, endpoint: 'embed', purpose: 'verification', status: 'success', dispatch: 1 },
        { actor: emails.other, project: projectA, model: 'model-old-time', agent: null, endpoint: 'chat', purpose: 'direct', status: 'success', dispatch: null, old: true },
    ];
    for (const row of rows) {
        row.id = randomUUID();
        await pool.query(`INSERT INTO model_usage_calls(id,worker_id,model_id,model_name,provider,endpoint,purpose,actor_email,project_id,agent_id,status,finished_at,started_at,input_tokens,output_tokens,latency_ms,dispatch_count,dispatched_at,rate_wait_ms,provider_latency_ms,failure_code)
            VALUES($1,$2,$3,$4,'remote-openai',$5,$6,$7,$8,$9,$10,now(),now()-$11::integer*interval '1 day',NULL,0,150,$12,CASE WHEN $12::integer>0 THEN now() ELSE NULL END,CASE WHEN $12::integer IS NULL THEN NULL ELSE 25 END,CASE WHEN $12::integer>0 THEN 100 ELSE NULL END,CASE WHEN $10='cancelled' THEN 'cancelled' ELSE NULL END)`,
        [row.id, randomUUID(), row.model, row.model === 'model-secret' ? 'FOREIGN MODEL SENTINEL' : 'Name ' + row.model, row.endpoint, row.purpose, row.actor, row.project, row.agent, row.status, row.old ? 8 : 0, row.dispatch]);
    }
    await test('Migration24 includes usage detail columns and preserves old nullable metrics', async () => {
        const readiness = await checkCatalogSchema(pool, true); assert.equal(readiness.applied.at(-1), 24);
        const old = (await report(main, { modelId: 'model-personal' })).items[0]; assert.equal(old.dispatchCount, null); assert.equal(old.providerLatencyMs, null);
    });
    await test('Main admin sees all users and server tasks; aggregate groups match the same filtered population', async () => {
        const value = await report(); assert.equal(value.summary.requests, 8); assert.equal(value.scope.kind, 'all');
        for (const key of ['byActor', 'byProject', 'byEndpoint', 'byAgent', 'series']) assert.equal(sumRequests(value[key]), 8, key);
        assert.ok(value.facets.users.some(row => row.email === emails.foreign)); assert.ok(value.facets.projects.some(row => row.id === projectB)); assert.ok(value.byActor.some(row => row.actorEmail === null));
        assert.equal(value.summary.apiCalls, '6'); assert.equal(value.summary.knownDispatchRequests, 7); assert.equal(value.summary.unknownDispatchRequests, 1);
    });
    await test('Project admin includes every actor only in level3 projects, without foreign metadata facets', async () => {
        const value = await report(projectAdmin); assert.equal(value.summary.requests, 4); assert.equal(value.scope.kind, 'projects'); assert.deepEqual(value.scope.projectIds, [projectA]);
        assert.ok(value.items.every(row => row.projectId === projectA)); for (const key of ['byActor', 'byProject', 'byEndpoint', 'byAgent', 'series']) assert.equal(sumRequests(value[key]), 4, key);
        assert.ok(!JSON.stringify(value).includes('FOREIGN')); assert.ok(value.facets.users.some(row => row.email === emails.deleted)); assert.ok(value.items.some(row => row.actorEmail === emails.deleted));
        assert.ok(!value.facets.models.some(row => row.id === 'model-secret')); assert.ok(!value.facets.agents.some(row => row.id === 'agent-rate-secret'));
    });
    await test('Developer reports remain self scoped and include personal calls without granting other project history', async () => {
        const value = await report(developer); assert.equal(value.summary.requests, 2); assert.equal(value.scope.kind, 'self'); assert.ok(value.items.every(row => row.actorEmail === emails.developer && [projectA, null].includes(row.projectId)));
        assert.deepEqual(value.facets.users.map(row => row.email), [emails.developer]); assert.ok(!JSON.stringify(value).includes('FOREIGN')); await assert.rejects(report(observer), status(403));
    });
    await test('Email, agent, endpoint and provider filters narrow authorized rows and preserve scoped facet choices', async () => {
        const choices = (await report(projectAdmin)).facets;
        const value = await report(projectAdmin, { actorEmail: emails.other, agentId: 'agent-rate-b', endpoint: 'embed', provider: 'remote-openai' });
        assert.equal(value.summary.requests, 1); assert.equal(value.items[0].actorEmail, emails.other); assert.deepEqual(value.facets, choices);
        const denied = await report(projectAdmin, { actorEmail: emails.foreign }); assert.equal(denied.summary.requests, 0); assert.deepEqual(denied.items, []); assert.deepEqual(denied.facets, choices);
        await assert.rejects(report(projectAdmin, { projectId: projectB }), status(403)); await assert.rejects(report(developer, { actorEmail: emails.other }), status(403));
    });
    await test('System-only selector and day filters preserve null actors and old dispatch uncertainty', async () => {
        const projectTasks = await report(projectAdmin, { actorEmail: '__system__' }); assert.equal(projectTasks.summary.requests, 1); assert.equal(projectTasks.items[0].actorEmail, null);
        assert.equal((await report(main, { actorEmail: '__system__' })).summary.requests, 2); assert.equal((await report(main, { days: '30' })).summary.requests, 9);
        const historical = await report(main, { days: '30', modelId: 'model-old-time' }); assert.equal(historical.summary.apiCalls, null); assert.equal(historical.summary.unknownDispatchRequests, 1);
    });
    await test('Microsecond pagination keeps every aggregate and metadata facet in the same authorized scope', async () => {
        await pool.query("UPDATE model_usage_calls SET started_at=date_trunc('second',clock_timestamp())-interval '1 second'+interval '0.000123 seconds' WHERE model_id<>'model-old-time'");
        let page = await report(projectAdmin, { limit: '2' }), seen = page.items.map(row => row.id); const expectedFacets = page.facets;
        while (page.history.hasMore) { page = await report(projectAdmin, { limit: '2', cursor: page.history.nextCursor }); seen.push(...page.items.map(row => row.id)); assert.equal(page.summary.requests, 4); assert.deepEqual(page.facets, expectedFacets); assert.ok(page.items.every(row => row.projectId === projectA)); }
        assert.equal(seen.length, 4); assert.equal(new Set(seen).size, 4); assert.deepEqual(new Set(seen), new Set(rows.filter(row => row.project === projectA && !row.old).map(row => row.id)));
    });
    await test('Strict filters reject unknown keys, arrays, malformed identities and untrusted endpoint input', async () => {
        const arrayIdCursor = Buffer.from(JSON.stringify({ id: [randomUUID()], startedAt: new Date().toISOString() })).toString('base64url');
        for (const query of [{ actorEmail: 'not-an-email' }, { actorEmail: [emails.other] }, { agentId: 'x\n' }, { endpoint: 'completion' }, { endpoint: ['chat'] }, { provider: 'x\n' }, { unexpected: 'actor' }, { limit: '101' }, { cursor: arrayIdCursor }]) await assert.rejects(report(main, query), status(400));
        await assert.rejects(report({ headers: { ...main.headers, 'x-neurocenter-device-id': randomUUID() } }), status(403));
    });
    await test('UTC and DST sessions share the exact thirty-times24-hour cutoff in one PostgreSQL snapshot', async () => {
        const db = await pool.connect(), inside = randomUUID(), outside = randomUUID();
        try {
            await db.query('BEGIN'); await db.query('CREATE SCHEMA owned_usage_clock');
            // A private PostgreSQL clock keeps this DST regression deterministic on any future execution date.
            await db.query("CREATE FUNCTION owned_usage_clock.now() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$ SELECT timestamptz '2026-10-23 08:00:00.123456+00' $$");
            await db.query('SET LOCAL search_path=owned_usage_clock,public,pg_catalog'); await db.query("SET LOCAL TIME ZONE 'Australia/Sydney'");
            const clock = (await db.query("SELECT now() AS instant,now()-30*86400*interval '1 second' AS cutoff,now()-interval '30 days' AS calendar_cutoff")).rows[0];
            assert.equal(clock.instant.toISOString(), '2026-10-23T08:00:00.123Z'); assert.notEqual(clock.cutoff.getTime(), clock.calendar_cutoff.getTime(), 'Positive control must cross a real DST change');
            for (const [id, delta] of [[inside, 1], [outside, -1]]) await db.query(`INSERT INTO model_usage_calls(id,worker_id,model_id,model_name,provider,endpoint,purpose,actor_email,status,finished_at,started_at)
                VALUES($1,$2,'model-owned-dst','Owned DST boundary','remote-openai','chat','direct',$3,'success',now(),now()-30*86400*interval '1 second'+$4::integer*interval '1 second')`, [id, randomUUID(), emails.main, delta]);
            const scope = { all: true, actor: null, projectIds: [] }, filter = { days: 30, limit: 50, modelId: 'model-owned-dst' };
            const nonUtc = await readModelUsageReport(db, scope, filter); await db.query("SET LOCAL TIME ZONE 'UTC'"); const utc = await readModelUsageReport(db, scope, filter);
            assert.equal(nonUtc.summary.requests, 1); assert.deepEqual(nonUtc.items.map(row => row.id), [inside]); assert.deepEqual(utc.items.map(row => row.id), [inside]); assert.deepEqual(utc.summary, nonUtc.summary);
            assert.equal(nonUtc.windowTo, utc.windowTo); assert.equal(new Date(Date.parse(nonUtc.windowTo) - 30 * 86400000).toISOString(), clock.cutoff.toISOString());
        } finally { await db.query('ROLLBACK'); db.release(); }
    });
    await test('Fresh grant and account revocation withhold a report that was already queried', async () => {
        const original = service.repository.report.bind(service.repository);
        service.repository.report = async (...args) => { const value = await original(...args); await pool.query("DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2", [projectA, emails.admin]); return value; };
        try { await assert.rejects(report(projectAdmin), status(403)); } finally { service.repository.report = original; await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,'Админ проекта')", [projectA, emails.admin]); }
        await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1', [emails.other]);
        try { await assert.rejects(report(request(emails.other, 'Разработчик')), status(403)); } finally { await pool.query('UPDATE platform_users SET enabled=true WHERE email=$1', [emails.other]); }
    });
    await test('Reporting OFF hides reports while a new unsent observation still creates known zero-dispatch metadata', async () => {
        flags = evaluateFeatureFlags({ ...defaultFeatureFlags(), model_usage: false });
        try {
            await assert.rejects(report(), status(403));
            const model = { id: 'model-no-transport', name: 'No provider', runtime: 'ollama' };
            await withModelUsage({ purpose: 'direct', actorEmail: emails.main }, () => service.observe(model, 'chat', async () => ({ message: { role: 'assistant', content: 'LOCAL FIXTURE ONLY' } })));
            const row = (await pool.query("SELECT * FROM model_usage_calls WHERE model_id='model-no-transport'")).rows[0]; assert.equal(row.dispatch_count, 0); assert.equal(row.provider_latency_ms, null); assert.equal(row.status, 'success');
        } finally { flags = evaluateFeatureFlags(defaultFeatureFlags()); }
    });
} finally {
    await service?.onApplicationShutdown(); await models?.onApplicationShutdown(); await access?.onModuleDestroy();
    if (server) await new Promise(resolve => server.close(resolve)); await pool?.end();
    if (created) { await admin.query('DROP DATABASE "' + database + '"'); receipt.databaseDropped = true; }
    receipt.databaseInventoryPreserved = JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows) === JSON.stringify(beforeDatabases); await admin.end();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
    receipt.sourceFreezeMatchesCurrent = (await Promise.all(files.map(async file => sha(await readFile(path.join(root, 'services/catalog-service/src', file))) === hashes[file]))).every(Boolean);
    receipt.expectedCases = 11; receipt.passed = receipt.cases.filter(row => row.ok).length; receipt.failed = receipt.cases.length - receipt.passed; receipt.completedAt = new Date().toISOString(); receipt.ok = receipt.cases.length === receipt.expectedCases && !receipt.failed && receipt.databaseDropped && receipt.databaseInventoryPreserved && receipt.sourceFreezeMatchesCurrent;
    await writeFile(path.join(output, 'usage-native-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ ok: receipt.ok, passed: receipt.passed, failed: receipt.failed, receipt: path.join(output, 'usage-native-receipt.json') }));
    if (!receipt.ok) process.exitCode = 1;
}
