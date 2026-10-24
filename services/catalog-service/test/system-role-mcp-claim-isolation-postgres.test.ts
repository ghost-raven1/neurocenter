import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemRoleMcpRepository } from '../src/system-role-mcp/system-role-mcp.repository';
import { assertBlockedBy, createMcpFixture, deferred, gatewayUrl, outputResult, owner, project, request, token, type McpFixture } from './system-role-mcp-postgres.fixture';

const features = vi.hoisted(() => ({ unavailable: false, disabled: false }));
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: async () => {
    if (features.unavailable) throw new ServiceUnavailableException('Owned feature peer is unavailable');
    if (features.disabled) throw new ForbiddenException('Owned feature is disabled');
} }));
const connection = process.env.SYSTEM_ROLE_MCP_TEST_ADMIN_URL;

/** Real SQL, current package authority and private leases; no MCP process or model is launched. */
describe.skipIf(!connection).sequential('Private MCP claim isolation on caller-owned PostgreSQL', () => {
    let fixture: McpFixture;
    beforeAll(async () => { fixture = await createMcpFixture(connection); }, 60_000);
    beforeEach(async () => {
        features.unavailable = false; features.disabled = false;
        vi.stubEnv('CATALOG_PG_URL', 'postgresql://forbidden:forbidden@127.0.0.1:1/forbidden');
        vi.stubEnv('API_GATEWAY_URL', gatewayUrl); vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'native-fixture-internal');
        vi.stubGlobal('fetch', fixture.fetchBoundary); await fixture.reset();
    });
    afterEach(async () => {
        await fixture?.stop(); expect(fixture?.transportViolations).toEqual([]);
        vi.unstubAllGlobals(); vi.unstubAllEnvs();
    });
    afterAll(async () => { await fixture?.close(); });

    async function siblings() {
        const staleTarget = fixture.target('device', fixture.configured);
        const view = await fixture.service.discover(request(), { projectId: project, target: staleTarget, requestId: randomUUID() });
        const stale = (await fixture.service.repository.discovery(view.id, owner))!;
        const target = fixture.target('device'), { row } = await fixture.run(target), healthy = await fixture.enqueue(row, target);
        const ordered = (await fixture.pool.query("SELECT id FROM system_role_mcp_sessions WHERE state='open' ORDER BY created_at,id")).rows;
        expect(ordered.map(value => value.id)).toEqual([stale.session_id, healthy.session.id]);
        return { stale, healthy, row };
    }

    for (const denial of ['assignment', 'configuration'] as const) it('runs the healthy sibling after only the oldest ' + denial + ' is revoked', async () => {
        const { stale, healthy, row } = await siblings();
        const generalJobs = (await fixture.pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows;
        if (denial === 'assignment') {
            await fixture.pool.query('DELETE FROM project_assets WHERE project_id=$1 AND asset_id=$2', [project, fixture.configured.plugin.id]);
        } else {
            // Remove the old status receipt: the current required-secret configuration is no longer confirmed.
            await fixture.pool.query("DELETE FROM bridge_jobs WHERE kind='get-mcp-configuration-status'");
        }
        const afterRevocation = (await fixture.pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows;
        const claim = await fixture.service.channel.claim(token);
        expect(claim).toMatchObject({ id: healthy.session.id, lease: healthy.session.worker_lease });
        const rejected = await fixture.service.repository.session(stale.session_id);
        expect(rejected.state).toBe('closed'); expect(rejected.claimed_at).toBeNull();
        const staleCall = await fixture.service.repository.call(stale.call_id);
        expect(staleCall.state).toBe('failed'); expect(staleCall.dispatched_at).toBeNull();
        expect(staleCall.result).toMatchObject({ state: 'failed', message: expect.any(String) });
        expect((await fixture.service.discovery(request(), stale.id)).state).toBe('failed');
        const input = { jobId: claim!.id, lease: claim!.lease, callId: healthy.call.id };
        await fixture.service.channel.dispatch(token, input);
        await expect(fixture.service.channel.dispatch(token, input)).rejects.toHaveProperty('status', 409);
        await fixture.service.channel.result(token, { ...input, result: outputResult('Healthy sibling evidence') });
        expect(await fixture.service.calls(request(), row.id)).toEqual([expect.objectContaining({ state: 'succeeded', output: outputResult('Healthy sibling evidence').value })]);
        expect((await fixture.pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows).toEqual(afterRevocation);
        if (denial === 'assignment') expect(afterRevocation).toEqual(generalJobs);
        expect(fixture.executions).toHaveLength(0);
    });

    it('preserves both queued receipts when global availability fails transiently', async () => {
        const { stale, healthy } = await siblings(); features.unavailable = true;
        await expect(fixture.service.channel.claim(token)).rejects.toHaveProperty('status', 503);
        for (const id of [stale.session_id, healthy.session.id]) {
            expect(await fixture.service.repository.session(id)).toMatchObject({ state: 'open', claimed_at: null });
        }
        for (const id of [stale.call_id, healthy.call.id]) expect(await fixture.service.repository.call(id)).toMatchObject({ state: 'queued', dispatched_at: null });
    });

    it('retains readable failed discovery when new tool work is explicitly disabled', async () => {
        const { stale, healthy } = await siblings(); features.disabled = true;
        expect(await fixture.service.channel.claim(token)).toBeNull();
        for (const id of [stale.session_id, healthy.session.id]) expect(await fixture.service.repository.session(id)).toMatchObject({ state: 'closed', claimed_at: null });
        for (const id of [stale.call_id, healthy.call.id]) expect(await fixture.service.repository.call(id)).toMatchObject({ state: 'failed', dispatched_at: null });
        expect(await fixture.service.discovery(request(), stale.id)).toMatchObject({ state: 'failed', tools: [] });
    });

    it('does not retire a different claim that wins while a stale candidate is being rejected', async () => {
        const { stale } = await siblings();
        const entered = deferred<number>(), release = deferred(); let matched = false;
        let writer: PoolClient | undefined, retirement: Promise<unknown> | undefined;
        const watchdog = setTimeout(() => { release.resolve(); entered.reject(new Error('Claim row-lock barrier was not reached')); }, 4000);
        fixture.setHook(async event => {
            if (matched || !event.sql.includes('SET claimed_at=')) return;
            matched = true; entered.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
            await release.promise;
        });
        const claiming = fixture.service.channel.claim(token); void claiming.catch(() => undefined);
        try {
            const blocker = await entered.promise; writer = await fixture.pool.connect();
            const waiting = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const client = writer;
            const borrowed = new Proxy(client, { get(db, key) {
                if (key === 'release') return () => undefined;
                const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value;
            } });
            const repository = new SystemRoleMcpRepository({ connect: async () => borrowed } as unknown as Pool);
            retirement = repository.close(stale.session_id, true); void retirement.catch(() => undefined);
            await assertBlockedBy(fixture.pool, waiting, blocker);
            release.resolve(); const first = await claiming; await retirement;
            expect(first!.id).toBe(stale.session_id);
            expect(await fixture.service.repository.session(stale.session_id)).toMatchObject({ state: 'open', worker_lease: first!.lease });
            expect((await fixture.service.repository.call(stale.call_id)).state).toBe('queued');
        } finally {
            clearTimeout(watchdog); release.resolve(); fixture.setHook();
            await Promise.allSettled([claiming, ...(retirement ? [retirement] : [])]); writer?.release();
        }
    });
});
