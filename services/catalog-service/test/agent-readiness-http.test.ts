import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { AgentReadinessController } from '../src/agent-readiness/agent-readiness.controller';
import { AgentReadinessService } from '../src/agent-readiness/agent-readiness.service';
import { FeaturePolicyGuard } from '../src/features/feature-policy.guard';
import type { StartAgentTrial } from '../src/agent-readiness/agent-readiness.types';
import { createAgentReadinessFixture, TRIAL_PROJECT } from './agent-readiness-postgres.fixture';

const connection = process.env.AGENT_READINESS_TEST_PG_URL;
const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };

/** Actual Nest HTTP, feature lookup, ACL, SQL/CAS and ledger; the model provider is an isolated deterministic peer. */
describe.skipIf(!connection).sequential('Agent trial HTTP → actual service and owned PostgreSQL', () => {
    let f: Awaited<ReturnType<typeof createAgentReadinessFixture>>, app: INestApplication, origin: string;
    let flags = defaultFeatureFlags(), flagsStatus = 200;
    const previousFlagsUrl = process.env.FEATURE_FLAGS_SERVICE_URL;
    const flagsServer = createServer((req, res) => {
        const valid = req.url === '/internal/feature-flags/evaluated' && req.headers['x-neurocenter-internal'] === 'agent-trial-fixture-only';
        res.writeHead(valid ? flagsStatus : 403, { 'content-type': 'application/json' });
        res.end(JSON.stringify(valid ? evaluateFeatureFlags(flags) : { message: 'Wrong fixture authority.' }));
    });
    const root = `/api/projects/${TRIAL_PROJECT}/agents`;
    const headers = (email = 'owner@localhost', role?: string) => ({ 'content-type': 'application/json', ...f.request(email, role).headers }) as Record<string, string>;
    const http = async (path: string, method = 'GET', body?: unknown, email?: string, role?: string) => {
        const response = await fetch(origin + path, { method, headers: headers(email, role), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, value: await response.json() };
    };
    const setup = async () => {
        const model = await f.addModel('model-' + randomUUID()), agent = await f.addAgent();
        const overview = await http(root + '/readiness'); expect(overview.status).toBe(200);
        const item = overview.value.items.find((row: { agentId: string }) => row.agentId === agent.id);
        const selected = item.eligibility.models.find((row: { id: string }) => row.id === model.id);
        const input: StartAgentTrial = { requestId: randomUUID(), expectedRevision: item.projectRevision, expectedAgentPin: item.currentPin,
            modelId: model.id, expectedModelPin: selected.pin, tool: 'none' };
        return { model, agent, input, start: root + '/' + agent.id + '/readiness-trials' };
    };
    beforeAll(async () => {
        flagsServer.listen(0, '127.0.0.1'); await once(flagsServer, 'listening');
        const address = flagsServer.address(); if (!address || typeof address === 'string') throw new Error('Missing own flag service port.');
        process.env.FEATURE_FLAGS_SERVICE_URL = 'http://127.0.0.1:' + address.port;
        f = await createAgentReadinessFixture(connection!);
        const delegate = { overview: f.service.overview.bind(f.service), start: f.service.start.bind(f.service),
            read: f.service.read.bind(f.service), cancel: f.service.cancel.bind(f.service) };
        Reflect.defineMetadata('design:paramtypes', [AgentReadinessService], AgentReadinessController);
        class HttpFixture {}
        Module({ controllers: [AgentReadinessController], providers: [{ provide: AgentReadinessService, useValue: delegate }] })(HttpFixture);
        app = await NestFactory.create(HttpFixture, { logger: false }); app.useGlobalGuards(new FeaturePolicyGuard());
        await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
    });
    beforeEach(() => {
        flags = defaultFeatureFlags(); flagsStatus = 200;
        f.setProvider(async call => {
            const nonce = /"nonce":"([^"]+)"/.exec((call.body.messages as Array<{ content: string }>).at(-1)!.content)![1];
            return { message: { role: 'assistant', content: JSON.stringify({ nonce, sum: 42 }) }, done_reason: 'stop', usage_reported: true, prompt_eval_count: 31, eval_count: 13 };
        });
    });
    afterAll(async () => {
        await app?.close(); await f?.close(); flagsServer.closeAllConnections();
        await new Promise<void>(resolve => flagsServer.close(() => resolve()));
        if (previousFlagsUrl === undefined) delete process.env.FEATURE_FLAGS_SERVICE_URL; else process.env.FEATURE_FLAGS_SERVICE_URL = previousFlagsUrl;
    });
    it('metadata reads never infer; an explicit 202 attempt uses the saved prompt, then returns an attributed durable receipt', async () => {
        const before = f.calls.length, s = await setup();
        await http(root + '/readiness'); expect(f.calls).toHaveLength(before);
        const queued = await http(s.start, 'POST', s.input); expect(queued.status).toBe(202); expect(queued.value.executionSurface).toBe('server_chat');
        const done = await f.settle(queued.value.id, s.agent.id);
        expect(done).toMatchObject({ status: 'succeeded', current: true, canCancel: false, receipt: { modelId: s.model.id,
            checks: [{ kind: 'prompt_sent', status: 'passed' }, { kind: 'model_response', status: 'passed' }] } });
        expect(f.calls).toHaveLength(before + 1); expect((f.calls.at(-1)!.body.messages as Array<{ role: string; content: string }>)[0]).toEqual({ role: 'system', content: s.agent.definition.prompt });
        expect((await http(s.start + '/' + done.id)).value).toEqual(done);
        expect((await f.db.query('SELECT purpose,agent_id,operation_id,status FROM model_usage_calls WHERE operation_id=$1', [done.id])).rows)
            .toEqual([{ purpose: 'verification', agent_id: s.agent.id, operation_id: done.id, status: 'success' }]);
    });
    it('replays a completed lost acknowledgement while flags are off and rejects fresh paid work with zero extra calls', async () => {
        const s = await setup(), queued = await http(s.start, 'POST', s.input), done = await f.settle(queued.value.id, s.agent.id), before = f.calls.length;
        flags.agents = false; flags.model_hosting = false;
        expect((await http(s.start, 'POST', s.input))).toMatchObject({ status: 202, value: { id: done.id, status: 'succeeded' } });
        expect((await http(s.start, 'POST', { ...s.input, requestId: randomUUID() })).status).toBe(403);
        expect((await http(s.start, 'POST', { ...s.input, modelId: 'model-changed' })).status).toBe(409);
        expect((await http(s.start + '/' + done.id)).status).toBe(200); expect(f.calls).toHaveLength(before);
    });
    it('keeps a receipt private from another member, another administrator and device identities', async () => {
        const s = await setup(), queued = await http(s.start, 'POST', s.input); await f.settle(queued.value.id, s.agent.id);
        const detail = s.start + '/' + queued.value.id;
        expect((await http(detail, 'GET', undefined, 'other@localhost')).status).toBe(404);
        expect((await http(detail, 'GET', undefined, 'admin@localhost')).status).toBe(404);
        expect((await http(detail, 'GET', undefined, 'observer@localhost')).status).toBe(403);
        const response = await fetch(origin + detail, { headers: { ...headers(), 'x-neurocenter-device-id': 'fixture-device' } });
        expect(response.status).toBe(403);
        const other = await http(root + '/readiness', 'GET', undefined, 'other@localhost');
        expect(other.value.items.every((item: { latestTrial: unknown }) => item.latestTrial === null)).toBe(true);
    });
    it('cancels by owner and exact revision even after flags are disabled, without starting another paid attempt', async () => {
        const s = await setup(), entered = gate(), hold = gate();
        f.setProvider(async call => { entered.release(); await Promise.race([hold.promise, new Promise<void>(resolve => call.signal?.addEventListener('abort', () => resolve(), { once: true }))]); call.signal?.throwIfAborted(); return {}; });
        try {
            const queued = await http(s.start, 'POST', s.input); await entered.promise;
            const running = await http(s.start + '/' + queued.value.id), before = f.calls.length; flags.agents = false;
            expect((await http(s.start + '/' + queued.value.id + '/cancel', 'POST', { expectedRevision: running.value.revision }, 'other@localhost')).status).toBe(404);
            expect((await http(s.start + '/' + queued.value.id + '/cancel', 'POST', { expectedRevision: running.value.revision - 1 })).status).toBe(409);
            expect((await http(s.start + '/' + queued.value.id + '/cancel', 'POST', { expectedRevision: running.value.revision }))).toMatchObject({ status: 201, value: { status: 'cancelled', canCancel: false } });
            expect((await f.settle(queued.value.id, s.agent.id)).status).toBe('cancelled'); expect(f.calls).toHaveLength(before);
        } finally { hold.release(); }
    });
    it('rejects unsupported payloads and malformed JSON before provider admission', async () => {
        const s = await setup(), before = f.calls.length;
        for (const extra of [{ prompt: 'override persona' }, { tool: 'bash' }, { tool: ['project_search'] }, { expectedModelPin: 'wrong' }, { expectedRevision: -1 }]) {
            expect((await http(s.start, 'POST', { ...s.input, ...extra })).status).toBe(400);
        }
        expect((await fetch(origin + s.start, { method: 'POST', headers: headers(), body: '{' })).status).toBe(400);
        expect((await http(s.start + '/not-a-uuid')).status).toBe(400);
        expect((await http(s.start + '/' + randomUUID() + '/retry', 'POST', {})).status).toBe(404);
        expect(f.calls).toHaveLength(before);
    });
    it('fails closed when the feature authority is unavailable and rejects a forged internal caller', async () => {
        const s = await setup(), before = f.calls.length; flagsStatus = 503;
        expect((await http(root + '/readiness')).status).toBe(503);
        expect((await http(s.start, 'POST', s.input)).status).toBe(503);
        expect((await fetch(origin + s.start, { method: 'POST', headers: { ...headers(), 'x-neurocenter-internal': 'forged' }, body: JSON.stringify(s.input) })).status).toBe(403);
        expect(f.calls).toHaveLength(before);
    });
    it('freshly revoked project access blocks historical reads and exact replay', async () => {
        const s = await setup(), queued = await http(s.start, 'POST', s.input); await f.settle(queued.value.id, s.agent.id);
        const before = f.calls.length;
        await f.db.query('DELETE FROM project_members WHERE principal_name=$1', ['owner@localhost']);
        try {
            expect((await http(root + '/readiness')).status).toBe(403);
            expect((await http(s.start + '/' + queued.value.id)).status).toBe(403);
            expect((await http(s.start, 'POST', s.input)).status).toBe(403);
            expect(f.calls).toHaveLength(before);
        } finally {
            await f.db.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'owner@localhost','owner@localhost','owner','Разработчик')", [TRIAL_PROJECT]);
        }
    });
});
