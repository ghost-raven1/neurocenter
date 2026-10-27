import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { createAgentReadinessFixture, TRIAL_PROJECT } from './agent-readiness-postgres.fixture';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { assertAgentReadinessSchema } from '../src/agent-readiness/agent-readiness.schema-verification';
import type { StartAgentTrial } from '../src/agent-readiness/agent-readiness.types';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { requiredRouteFeatures } from '../../shared/feature-policy.cjs';
import { AgentReadinessService } from '../src/agent-readiness/agent-readiness.service';
import { ModelRuntime } from '../src/models/model-runtime';
import { RemoteConnectionService } from '../src/models/remote-connection.service';

const connection = process.env.AGENT_READINESS_TEST_PG_URL;
describe.skipIf(!connection)('Owner-scoped diagnostic trials — actual isolated PostgreSQL', () => {
    let f: Awaited<ReturnType<typeof createAgentReadinessFixture>>, flags = defaultFeatureFlags();
    const releases: Array<() => void> = [];
    const create = async (definition: Parameters<typeof f.addAgent>[0] = {}) => {
        const model = await f.addModel('model-' + randomUUID()), agent = await f.addAgent(definition), overview = await f.service.overview(f.request(), TRIAL_PROJECT), item = overview.items.find(row => row.agentId === agent.id)!;
        const input: StartAgentTrial = { requestId: randomUUID(), expectedRevision: item.projectRevision, expectedAgentPin: item.currentPin,
            modelId: model.id, expectedModelPin: projectEmbeddingPin(model), tool: 'none' };
        return { model, agent, item, input, start: () => f.service.start(f.request(), TRIAL_PROJECT, agent.id, input) };
    };
    const hold = () => { let release!: () => void, reached!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; }); releases.push(release);
        f.setProvider(async call => { reached(); await gate; const nonce = /"nonce":"([^"]+)"/.exec((call.body.messages as Array<{ content: string }>).at(-1)!.content)![1];
            return { message: { role: 'assistant', content: JSON.stringify({ nonce, sum: 42 }) }, done_reason: 'stop', usage_reported: true, prompt_eval_count: 31, eval_count: 13 }; }); return { release, ready };
    };
    beforeAll(async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 })));
        f = await createAgentReadinessFixture(connection!);
    });
    beforeEach(() => { flags = defaultFeatureFlags(); f.calls.length = 0; });
    afterEach(async () => {
        releases.splice(0).forEach(release => release());
        await f.service.onApplicationShutdown();
        await f.db.query('DELETE FROM agent_readiness_trials; DELETE FROM model_usage_calls; DELETE FROM project_embedding_settings; DELETE FROM project_agents; DELETE FROM project_models; UPDATE project_agent_sets SET revision=0');
        await f.db.query("UPDATE project_members SET role='Разработчик' WHERE principal_name='owner@localhost'");
        f.models.pool.options.max = 5;
        vi.restoreAllMocks();
        f.setProvider(async call => { const nonce = /"nonce":"([^"]+)"/.exec((call.body.messages as Array<{ content: string }>).at(-1)!.content)![1];
            return { message: { role: 'assistant', content: JSON.stringify({ nonce, sum: 42 }) }, done_reason: 'stop', usage_reported: true, prompt_eval_count: 31, eval_count: 13 }; });
    });
    afterAll(async () => { await f?.close(); vi.unstubAllGlobals(); });

    it('adopts only migration20 and preserves all earlier migration checksums, detects physical drift', async () => {
        const journal = (await f.db.query('SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version')).rows;
        expect(journal.map(row => row.version)).toEqual(CATALOG_MIGRATIONS.map(row => row.version)); expect(journal.find(row=>row.name==='project-agent-diagnostic-trials')).toBeDefined();expect(journal.at(-1).name).toBe('durable-project-chat-method-workflows');
        await assertAgentReadinessSchema(f.db);
        await f.db.query('BEGIN'); await f.db.query('DROP INDEX agent_readiness_single_pending');
        await expect(assertAgentReadinessSchema(f.db)).rejects.toThrow('agent_readiness_single_pending'); await f.db.query('ROLLBACK');
        expect((await f.db.query('SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version')).rows).toEqual(journal);
    });
    it('reads metadata without inference and can diagnose a disabled tool-less assignment without enabling it', async () => {
        const c = await create(); expect(c.item.eligibility).toMatchObject({ canRun: true, modelSelection: 'choose', tools: [{ available: false }] }); expect(f.calls).toHaveLength(0);
        const initial = await c.start(), done = await f.settle(initial.id, c.agent.id);
        expect(done).toMatchObject({ executionSurface: 'server_chat', status: 'succeeded', current: true, canCancel: false, receipt: { modelId: c.model.id, checks: [{ status: 'passed' }, { status: 'passed' }], usage: { calls: 1, reported: true, inputTokens: 31, outputTokens: 13 } } });
        expect((await f.db.query('SELECT enabled FROM project_agents WHERE agent_id=$1', [c.agent.id])).rows[0].enabled).toBe(false);
        expect((await f.db.query('SELECT purpose,actor_email,project_id,agent_id,operation_id,status FROM model_usage_calls')).rows).toEqual([{ purpose: 'verification', actor_email: 'owner@localhost', project_id: TRIAL_PROJECT, agent_id: c.agent.id, operation_id: done.id, status: 'success' }]);
    });
    it('maps an unavailable flag service to a safe metadata 503 without inferring', async () => {
        await create(); vi.mocked(fetch).mockRejectedValueOnce(new Error('https://private-provider.invalid?key=secret'));
        await expect(f.service.overview(f.request(), TRIAL_PROJECT)).rejects.toMatchObject({ status: 503, message: 'Не удалось проверить доступность функций. Повторите позже.' });
        expect(f.calls).toHaveLength(0); expect((await f.db.query('SELECT id FROM agent_readiness_trials')).rows).toEqual([]);
    });
    it('uses borrowed transactional reads with a model pool of one and never holds a model transaction across inference', async () => {
        const c = await create(); f.models.pool.options.max = 1;
        const initial = await c.start(); expect((await f.settle(initial.id, c.agent.id)).status).toBe('succeeded'); expect(f.calls).toHaveLength(1);
    }, 5000);
    it('sends a configured 64-token limit through the real dispatcher rather than overriding it with 256', async () => {
        const c = await create(); await f.db.query("UPDATE model_remote_connections SET options=options||'{\"maxOutputTokens\":64}'::jsonb WHERE model_id=$1", [c.model.id]);
        const initial = await c.start(); expect((await f.settle(initial.id, c.agent.id)).status).toBe('succeeded');
        expect(f.calls).toHaveLength(1); expect(f.calls[0].body.options).toMatchObject({ num_predict: 64 });
    });
    it('replays lost ACK exactly after feature off without paying again; a new request is denied', async () => {
        const c = await create(), initial = await c.start(); await f.settle(initial.id, c.agent.id); flags.agents = false; flags.model_hosting = false;
        expect((await c.start()).id).toBe(initial.id);
        await expect(f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, requestId: randomUUID() })).rejects.toMatchObject({ status: 403 });
        expect((await f.service.overview(f.request(), TRIAL_PROJECT)).items[0].latestTrial?.status).toBe('succeeded'); expect(f.calls).toHaveLength(1);
        expect(requiredRouteFeatures('POST', `/api/projects/${TRIAL_PROJECT}/agents/${c.agent.id}/readiness-trials`, c.input)).toEqual([]);
    });
    it('rejects stale agent/model/project CAS without trials, ledger writes or calls', async () => {
        const c = await create();
        for (const extra of [{ expectedRevision: 50 }, { expectedAgentPin: 'f'.repeat(64) }, { expectedModelPin: 'f'.repeat(64) }]) await expect(f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, ...extra })).rejects.toMatchObject({ status: 409 });
        expect((await f.db.query('SELECT id FROM agent_readiness_trials')).rows).toEqual([]); expect((await f.db.query('SELECT id FROM model_usage_calls')).rows).toEqual([]); expect(f.calls).toHaveLength(0);
    });
    it('serializes duplicate requests, rejects changed bodies and prevents parallel double inference', async () => {
        const c = await create(), held = hold(), results = await Promise.all([c.start(), c.start()]); await held.ready;
        expect(results[0].id).toBe(results[1].id);
        await expect(f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, tool: 'project_search' })).rejects.toMatchObject({ status: 409 });
        await expect(f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
        held.release(); await f.settle(results[0].id, c.agent.id); expect(f.calls).toHaveLength(1);
    });
    it('keeps all results private even from another developer and the global admin', async () => {
        const c = await create(), initial = await c.start(); await f.settle(initial.id, c.agent.id);
        for (const email of ['other@localhost', 'admin@localhost']) {
            expect((await f.service.overview(f.request(email), TRIAL_PROJECT)).items[0].latestTrial).toBeNull();
            await expect(f.service.read(f.request(email), TRIAL_PROJECT, c.agent.id, initial.id)).rejects.toMatchObject({ status: 404 });
            await expect(f.service.cancel(f.request(email), TRIAL_PROJECT, c.agent.id, initial.id, { expectedRevision: 0 })).rejects.toMatchObject({ status: 404 });
        }
        await expect(f.service.overview(f.request('observer@localhost'), TRIAL_PROJECT)).rejects.toMatchObject({ status: 403 });
        await expect(f.service.overview({ headers: { ...f.request().headers, 'x-neurocenter-device-id': 'device' } } as never, TRIAL_PROJECT)).rejects.toMatchObject({ status: 403 });
    });
    it('cancels with fresh owner CAS after flag off and does not save a late response', async () => {
        const c = await create(), held = hold(), initial = await c.start(); await held.ready; flags.agents = false;
        const running = await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id);
        await expect(f.service.cancel(f.request(), TRIAL_PROJECT, c.agent.id, initial.id, { expectedRevision: running.revision + 100 })).rejects.toMatchObject({ status: 409 });
        expect((await f.service.cancel(f.request(), TRIAL_PROJECT, c.agent.id, initial.id, { expectedRevision: running.revision })).status).toBe('cancelled');
        held.release(); expect((await f.settle(initial.id, c.agent.id)).status).toBe('cancelled');
    });
    it('does not commit success after the model pin or effective prompt changed during inference', async () => {
        for (const change of ['model', 'prompt']) {
            const c = await create(), held = hold(), initial = await c.start(); await held.ready;
            if (change === 'model') await f.db.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{verificationSha256}',to_jsonb($2::text)) WHERE id=$1", [c.model.id, 'c'.repeat(64)]);
            else await f.db.query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [c.agent.id, JSON.stringify({ prompt: 'Новый промпт' })]);
            held.release(); const done = await f.settle(initial.id, c.agent.id); expect(done.status).toBe('failed'); expect(done.current).toBe(false);
        }
    });
    it('does not mark a receipt stale for an unrelated agent change, but does for its exact prompt', async () => {
        const c = await create(), initial = await c.start(); await f.settle(initial.id, c.agent.id); const peer = await f.addAgent({ prompt: 'Другой агент' });
        expect((await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id)).current).toBe(true);
        await f.db.query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [c.agent.id, JSON.stringify({ prompt: 'Иной промпт' })]);
        expect((await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id)).current).toBe(false); expect(peer.id).not.toBe(c.agent.id);
    });
    it('enforces a fixed agent model and explicit project-search permission/consent before any paid work', async () => {
        const c = await create(), other = await f.addModel('model-' + randomUUID());
        await f.db.query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [c.agent.id, JSON.stringify({ model: 'neurocenter/' + other.id })]);
        const item = (await f.service.overview(f.request(), TRIAL_PROJECT)).items[0]; expect(item.eligibility).toMatchObject({ modelSelection: 'fixed', resolvedModelId: other.id });
        await expect(f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, expectedAgentPin: item.currentPin })).rejects.toMatchObject({ status: 409 });
        await f.db.query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [c.agent.id, JSON.stringify({ permission: { read: 'deny' } })]);
        const denied = (await f.service.overview(f.request(), TRIAL_PROJECT)).items[0];
        await expect(f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, expectedAgentPin: denied.currentPin, tool: 'project_search', toolConsent: true })).rejects.toMatchObject({ status: 409 }); expect(f.calls).toHaveLength(0);
        for (const tool of [['project_search'], ['none']]) await expect(f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, expectedAgentPin: denied.currentPin, tool, toolConsent: true })).rejects.toMatchObject({ status: 400 });
        expect((await f.db.query('SELECT id FROM agent_readiness_trials')).rows).toEqual([]); expect(f.calls).toHaveLength(0);
    });
    it('stores a failed diagnostic and requires a new request for explicit retry', async () => {
        const c = await create(); f.setProvider(async () => ({ message: { role: 'assistant', content: 'hello' }, done_reason: 'stop', usage_reported: false }));
        const initial = await c.start(); expect((await f.settle(initial.id, c.agent.id)).status).toBe('failed'); expect((await c.start()).id).toBe(initial.id); expect(f.calls).toHaveLength(1);
        const retry = await f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, requestId: randomUUID() }); expect(retry.id).not.toBe(initial.id);
        await f.settle(retry.id, c.agent.id); expect(f.calls).toHaveLength(2);
    });
    it('honors ask consent and executes one pinned readonly search with two chat calls and a separately attributed embedding', async () => {
        const c = await create({ permission: { read: 'ask' } }), embedding = await f.addModel('model-' + randomUUID(), { capability: 'embedding', dimension: 3 });
        const generation = 'initial-diagnostic', snapshot = 'd'.repeat(64);
        await f.db.query("INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation,active_snapshot) VALUES($1,1,$2,$3,3,'fixture',$4,$5)", [TRIAL_PROJECT, embedding.id, projectEmbeddingPin(embedding), generation, snapshot]);
        const item = (await f.service.overview(f.request(), TRIAL_PROJECT)).items[0];
        expect(item.eligibility.tools).toEqual([{ kind: 'project_search', available: true, requiresConsent: true }]);
        const input = { ...c.input, tool: 'project_search' };
        await expect(f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, input)).rejects.toMatchObject({ status: 409 }); expect(f.calls).toHaveLength(0);
        const search = vi.spyOn(f.service.runner.project.client, 'call').mockResolvedValue({ generation, snapshot, sources: [] });
        f.setProvider(async call => {
            if (call.endpoint === 'embed') return { embeddings: [[1, 2, 3]], usage_reported: true, prompt_eval_count: 5, eval_count: 0 };
            const last = (call.body.messages as Array<{ content: string }>).at(-1)!.content;
            const value = last.includes('Ответь только JSON: ') ? JSON.parse(last.split('Ответь только JSON: ')[1]) : { nonce: /"nonce":"([^"]+)"/.exec(last)![1], tool: 'project_search', query: 'Описание проекта' };
            return { message: { role: 'assistant', content: JSON.stringify(value) }, done_reason: 'stop', usage_reported: false };
        });
        f.models.pool.options.max = 1;
        const initial = await f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...input, toolConsent: true }), done = await f.settle(initial.id, c.agent.id);
        expect(done.status).toBe('succeeded'); expect(done.receipt.checks.map(check => check.status)).toEqual(['passed', 'passed', 'passed']);
        expect(f.calls.map(call => call.endpoint)).toEqual(['chat', 'embed', 'chat']); expect(search).toHaveBeenCalledOnce();
        expect(search.mock.calls[0].slice(0, 2)).toEqual(['search', expect.objectContaining({ projectId: TRIAL_PROJECT, generation, snapshot })]);
        const ledger = (await f.db.query('SELECT purpose,operation_id,agent_id,status FROM model_usage_calls ORDER BY started_at')).rows;
        expect(ledger).toEqual(['verification', 'project-search', 'verification'].map(purpose => ({ purpose, operation_id: done.id, agent_id: c.agent.id, status: 'success' })));
        expect(done.receipt.usage).toMatchObject({ calls: 2, reported: false, inputTokens: null, outputTokens: null });
    });
    it('recovers an expired lease without inferring or mutating a terminal receipt', async () => {
        const c = await create(), held = hold(), initial = await c.start(); await held.ready;
        await f.db.query("UPDATE agent_readiness_trials SET lease_until=now()-interval '1 second',revision=revision+1 WHERE id=$1", [initial.id]);
        const expired = await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id); expect(expired.status).toBe('interrupted'); held.release();
        expect((await c.start()).status).toBe('interrupted'); expect(f.calls).toHaveLength(1);
        await expect(f.db.query("UPDATE agent_readiness_trials SET receipt='{}',revision=revision+1 WHERE id=$1", [initial.id])).rejects.toThrow('immutable');
    });
    it('fences fresh ACL after inference and never claims success following role revocation', async () => {
        const c = await create(), held = hold(), initial = await c.start(); await held.ready;
        await f.db.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1 AND principal_name='owner@localhost'", [TRIAL_PROJECT]); held.release();
        for (let i = 0; i < 200; i++) { const row = (await f.db.query('SELECT status FROM agent_readiness_trials WHERE id=$1', [initial.id])).rows[0]; if (!['queued', 'running'].includes(row.status)) { expect(row.status).toBe('failed'); break; } await new Promise(resolve => setTimeout(resolve, 10)); }
        expect((await f.db.query('SELECT status FROM agent_readiness_trials WHERE id=$1', [initial.id])).rows[0].status).toBe('failed');
        await expect(f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id)).rejects.toMatchObject({ status: 403 });
    });
    it('bounds row-lock cancellation and shutdown, preserving the lease for truthful recovery after a failed terminal write', async () => {
        const c = await create(), held = hold(), initial = await c.start(); await held.ready;
        const blocker = await f.db.connect();
        try {
            await blocker.query('BEGIN'); await blocker.query('SELECT id FROM agent_readiness_trials WHERE id=$1 FOR UPDATE', [initial.id]);
            const running = await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id);
            await expect(f.service.cancel(f.request(), TRIAL_PROJECT, c.agent.id, initial.id, { expectedRevision: running.revision })).rejects.toMatchObject({ code: '55P03' });
            const started = performance.now(); await f.service.onApplicationShutdown(); expect(performance.now() - started).toBeLessThan(4500);
            const blocked = (await blocker.query('SELECT status,lease_until FROM agent_readiness_trials WHERE id=$1', [initial.id])).rows[0];
            expect(blocked.status).toBe('running'); expect(blocked.lease_until).not.toBeNull();
            await blocker.query('COMMIT'); held.release();
            await f.db.query("UPDATE agent_readiness_trials SET lease_until=now()-interval '1 second',revision=revision+1 WHERE id=$1", [initial.id]);
            expect((await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id)).status).toBe('interrupted'); expect(f.calls).toHaveLength(1);
        } finally { await blocker.query('ROLLBACK'); blocker.release(); held.release(); }
    }, 8000);
    it.each(['disabled-account', 'revoked-admin', 'removed-grant', 'downgraded-grant'])('rechecks authoritative SQL after a stale actor was accepted: %s', async change => {
        const c = await create(), req = change === 'revoked-admin' ? f.request('admin@localhost') : f.request();
        vi.mocked(fetch).mockImplementationOnce(async () => {
            if (change === 'disabled-account') await f.db.query("UPDATE platform_users SET enabled=false WHERE email='owner@localhost'");
            if (change === 'revoked-admin') await f.db.query("UPDATE platform_users SET is_main_admin=false WHERE email='admin@localhost'");
            if (change === 'removed-grant') await f.db.query("DELETE FROM project_members WHERE project_id=$1 AND principal_name='owner@localhost'", [TRIAL_PROJECT]);
            if (change === 'downgraded-grant') await f.db.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1 AND principal_name='owner@localhost'", [TRIAL_PROJECT]);
            return new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 });
        });
        try {
            await expect(f.service.start(req, TRIAL_PROJECT, c.agent.id, c.input)).rejects.toMatchObject({ status: 403 });
            expect((await f.db.query('SELECT id FROM agent_readiness_trials')).rows).toEqual([]); expect(f.calls).toHaveLength(0);
        } finally {
            await f.db.query("UPDATE platform_users SET enabled=true WHERE email='owner@localhost'; UPDATE platform_users SET is_main_admin=true WHERE email='admin@localhost'");
            if (change === 'removed-grant') await f.db.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'owner@localhost','owner@localhost','Owner','Разработчик')", [TRIAL_PROJECT]);
        }
    });
    it('lets the current main administrator start their own diagnostic without exposing somebody else’s result', async () => {
        const c = await create(), req = f.request('admin@localhost'), initial = await f.service.start(req, TRIAL_PROJECT, c.agent.id, c.input);
        expect((await f.settle(initial.id, c.agent.id, req)).status).toBe('succeeded');
        await expect(f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id)).rejects.toMatchObject({ status: 404 });
    });
    it.each(['missing', 'removed', 'archived'])('does not create or run a diagnostic for an unavailable assignment: %s', async unavailable => {
        const c = await create();
        if (unavailable === 'removed') await f.db.query('UPDATE project_agents SET removed=true,enabled=false WHERE agent_id=$1', [c.agent.id]);
        if (unavailable === 'archived') await f.db.query('UPDATE agent_catalog SET archived_at=now() WHERE id=$1', [c.agent.id]);
        await expect(f.service.start(f.request(), TRIAL_PROJECT, unavailable === 'missing' ? 'agent-missing' : c.agent.id, c.input)).rejects.toMatchObject({ status: 404 });
        if (unavailable === 'archived') expect((await f.service.overview(f.request(), TRIAL_PROJECT)).items[0].eligibility).toMatchObject({ canRun: false, reason: expect.stringContaining('Агент') });
        expect((await f.db.query('SELECT id FROM agent_readiness_trials')).rows).toEqual([]); expect(f.calls).toHaveLength(0);
    });
    it('shows actionable unavailable models for both inherited and fixed selectors without starting a probe', async () => {
        const c = await create(); await f.db.query('DELETE FROM project_models WHERE project_id=$1', [TRIAL_PROJECT]);
        expect((await f.service.overview(f.request(), TRIAL_PROJECT)).items[0].eligibility).toMatchObject({ canRun: false, modelSelection: 'choose', models: [], reason: expect.stringContaining('Добавьте') });
        await f.db.query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [c.agent.id, JSON.stringify({ model: 'neurocenter/model-no-longer-assigned' })]);
        expect((await f.service.overview(f.request(), TRIAL_PROJECT)).items[0].eligibility).toMatchObject({ canRun: false, modelSelection: 'fixed', models: [], reason: expect.stringContaining('Закреплённая') });
        expect(f.calls).toHaveLength(0);
    });
    it('returns an honest not-yet-synchronized search choice and rejects a changed index before embedding', async () => {
        const c = await create({ permission: { read: 'allow' } }), embedding = await f.addModel('model-' + randomUUID(), { capability: 'embedding', dimension: 3 });
        await f.db.query("INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation) VALUES($1,1,$2,$3,3,'fixture','initial-diagnostic')", [TRIAL_PROJECT, embedding.id, projectEmbeddingPin(embedding)]);
        expect((await f.service.overview(f.request(), TRIAL_PROJECT)).items[0].eligibility.tools[0]).toMatchObject({ available: false, reason: expect.stringContaining('синхронизированный') });
        await f.db.query('UPDATE project_embedding_settings SET active_snapshot=$2 WHERE project_id=$1', [TRIAL_PROJECT, 'd'.repeat(64)]);
        const held = hold(), search = vi.spyOn(f.service.runner.project.client, 'call');
        const initial = await f.service.start(f.request(), TRIAL_PROJECT, c.agent.id, { ...c.input, tool: 'project_search' }); await held.ready;
        await f.db.query('UPDATE project_embedding_settings SET active_snapshot=$2 WHERE project_id=$1', [TRIAL_PROJECT, 'e'.repeat(64)]); held.release();
        const result = await f.settle(initial.id, c.agent.id);
        expect(result).toMatchObject({ status: 'failed', current: false }); expect(f.calls.map(call => call.endpoint)).toEqual(['chat']); expect(search).not.toHaveBeenCalled();
    });
    it('keeps a completed receipt unchanged when cancellation or a stale terminal write arrives late', async () => {
        const c = await create(), initial = await c.start(), done = await f.settle(initial.id, c.agent.id);
        expect(await f.service.cancel(f.request(), TRIAL_PROJECT, c.agent.id, done.id, { expectedRevision: done.revision })).toEqual(done);
        const row = (await f.db.query('SELECT * FROM agent_readiness_trials WHERE id=$1', [done.id])).rows[0];
        await expect(f.service.repository.transaction(db => f.service.repository.save(db, row, 'succeeded', row.receipt, 'late duplicate'))).rejects.toMatchObject({ status: 409 });
        expect(await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, done.id)).toEqual(done); expect(f.calls).toHaveLength(1);
    });
    it('keeps raw provider failures out of the durable user-facing receipt', async () => {
        const c = await create(); f.setProvider(async () => { throw new Error('https://private-provider.invalid?api_key=secret-key'); });
        const initial = await c.start(), result = await f.settle(initial.id, c.agent.id);
        expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toContain('secret-key'); expect(JSON.stringify(result)).not.toContain('private-provider');
        expect((await f.db.query('SELECT status FROM model_usage_calls WHERE operation_id=$1', [result.id])).rows).toEqual([{ status: 'error' }]);
    });
    it('marks an actually timed-out attempt interrupted without waiting for an uncooperative provider or retrying it', async () => {
        const c = await create(), timeout = new AbortController(), nativeTimeout = AbortSignal.timeout.bind(AbortSignal), held = hold();
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => milliseconds === 90000 ? timeout.signal : nativeTimeout(milliseconds));
        const initial = await c.start(); await held.ready; timeout.abort(new DOMException('Diagnostic timeout', 'TimeoutError'));
        try { expect(await f.settle(initial.id, c.agent.id)).toMatchObject({ status: 'interrupted', message: expect.stringContaining('Время'), canCancel: false }); expect(f.calls).toHaveLength(1); }
        finally { held.release(); }
    });
    it('distinguishes storage outages from semantic staleness and rejects a foreign owner even in a trusted borrowed-row call', async () => {
        const c = await create(), initial = await c.start(); await f.settle(initial.id, c.agent.id);
        const row = (await f.db.query('SELECT * FROM agent_readiness_trials WHERE id=$1', [initial.id])).rows[0];
        await expect(f.service.repository.transaction(db => f.service.policy.assertCurrent(f.request('other@localhost'), row, db))).rejects.toMatchObject({ status: 403 });
        const outage = new Error('database unavailable'), guard = vi.spyOn(f.service.policy, 'assertCurrent').mockRejectedValueOnce(outage);
        try { await expect(f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id)).rejects.toBe(outage); }
        finally { guard.mockRestore(); }
        expect((await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id)).current).toBe(true);
    });
    it('keeps default inherited selection scoped to assigned catalog models and rejects an empty project without creating work', async () => {
        const c = await create(), assignment = await f.service.policy.assignment(TRIAL_PROJECT, c.agent.id);
        expect((await f.service.policy.model(f.request(), TRIAL_PROJECT, assignment, c.model.id)).id).toBe(c.model.id);
        const emptyProject = 'prj-' + randomUUID();
        await f.db.query("INSERT INTO projects(id,name) VALUES($1,'Empty project');", [emptyProject]);
        await f.db.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'owner@localhost','owner@localhost','Owner','Разработчик')", [emptyProject]);
        await expect(f.service.start(f.request(), emptyProject, 'agent-missing', { ...c.input, expectedRevision: 0 })).rejects.toMatchObject({ status: 404 });
        expect(f.calls).toHaveLength(0); expect((await f.db.query('SELECT id FROM agent_readiness_trials')).rows).toEqual([]);
    });
    it('does not claim readiness for a stale verified card whose server connection is absent', async () => {
        const c = await create(); await f.db.query('DELETE FROM model_remote_connections WHERE model_id=$1', [c.model.id]);
        const runtime = new ModelRuntime({ infer: async () => { throw new Error('Unexpected local inference'); } } as never, new RemoteConnectionService(f.models), f.usage);
        const service = new AgentReadinessService(f.models, runtime);
        try {
            await service.onModuleInit(); const initial = await service.start(f.request(), TRIAL_PROJECT, c.agent.id, c.input), done = await f.settle(initial.id, c.agent.id);
            expect(done.status).toBe('failed'); expect(done.receipt.checks[0].status).toBe('not_run'); expect(f.calls).toHaveLength(0);
            expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).includes('/internal/feature-flags/'))).toBe(true);
        } finally { await service.onApplicationShutdown(); }
    });
    it('waits for in-flight worker cleanup after durable shutdown interruption instead of returning early', async () => {
        const c = await create(), held = hold(), initial = await c.start(); await held.ready;
        let releaseCleanup!: () => void, cleanupEntered!: () => void;
        const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; }), entered = new Promise<void>(resolve => { cleanupEntered = resolve; });
        const original = f.service.repository.stop.bind(f.service.repository);
        const stop = vi.spyOn(f.service.repository, 'stop').mockImplementation(async (...args) => {
            await original(...args); if (args[2] === 'cancelled') { cleanupEntered(); await cleanup; }
        });
        let finished = false; const shutdown = f.service.onApplicationShutdown().then(() => { finished = true; });
        try {
            await entered; await new Promise<void>(resolve => setImmediate(resolve)); expect(finished).toBe(false);
            releaseCleanup(); await shutdown;
            expect((await f.service.read(f.request(), TRIAL_PROJECT, c.agent.id, initial.id)).status).toBe('interrupted');
        } finally { releaseCleanup(); held.release(); await shutdown; stop.mockRestore(); }
    });
});
