import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminUrl, codexGuardFixture, deviceId, lease, owner, projectId } from './device-codex-guard-races.fixture';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { requireFeaturesEnabled } from '../src/features/require-feature-enabled';
import { DEVICE_CODEX_JOB, DEVICE_CODEX_PROTOCOL } from '../../shared/device-codex-inference.cjs';

vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: vi.fn(async () => undefined) }));
vi.mock('../src/devices/device-operations', async original => ({ ...await original<typeof import('../src/devices/device-operations')>(), notifyDeviceOperations: vi.fn() }));

describe.skipIf(!adminUrl)('Codex polling completion/authorization races on an explicitly owned PostgreSQL', () => {
    let fixture: Awaited<ReturnType<typeof codexGuardFixture>>;
    let run: Awaited<ReturnType<typeof fixture.setup>>;
    beforeAll(async () => { fixture = await codexGuardFixture(); });
    beforeEach(async () => {
        vi.mocked(requireFeaturesEnabled).mockResolvedValue(undefined);
        const flags = { ...defaultFeatureFlags(), codex_connector: true, device_codex_inference: true };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(flags)))));
        run = await fixture.setup();
    });
    afterEach(async () => { await fixture?.stop(); vi.unstubAllGlobals(); });
    afterAll(async () => {
        if (!fixture) return;
        const cleanup = await fixture.dispose();
        expect(cleanup.dropped).toBe(true);
        expect(cleanup.originalDatabasesPreserved).toBe(true);
        expect(cleanup.newDatabasesRemaining).toEqual([]);
        vi.restoreAllMocks();
    });

    async function completedWhileGuardWaits() {
        const result = run.run(); await run.waiting;
        await run.complete();
        return { result };
    }
    async function onlyOneCall() {
        const counts = (await fixture.pool.query('SELECT (SELECT count(*)::int FROM bridge_jobs) AS jobs,(SELECT count(*)::int FROM device_model_calls) AS calls')).rows[0];
        expect(counts).toEqual({ jobs: 1, calls: 1 });
    }

    it('returns the paid durable answer that completes between the pending poll read and its fresh SQL guard', async () => {
        const { result } = await completedWhileGuardWaits();
        run.resume();
        await expect(result).resolves.toEqual(run.response);
        const stored = (await fixture.pool.query('SELECT j.state,c.cancelled_at,c.result FROM bridge_jobs j JOIN device_model_calls c ON c.job_id=j.id')).rows[0];
        expect(stored).toMatchObject({ state: 'succeeded', cancelled_at: null, result: { response: run.response } });
        expect(run.metrics.dispatchCount).toBe(1);
        expect(run.metrics.dispatchedAt).not.toBeNull();
        await onlyOneCall();
    });

    it('reports a durable unknown-after-send failure that arrives during the guard without inventing an ACL error or retry', async () => {
        const result = run.run(); await run.waiting;
        await run.complete('unknown-after-send'); run.resume();
        await expect(result).rejects.toThrow('Codex не завершил запрос (unknown-after-send).');
        expect(run.metrics.dispatchCount).toBe(1);
        expect((await fixture.pool.query('SELECT state FROM bridge_jobs')).rows[0].state).toBe('failed');
        await onlyOneCall();
    });

    it.each([
        ['account', 'UPDATE platform_users SET enabled=false'],
        ['project role', "UPDATE project_members SET role='Наблюдатель'"],
        ['connection revision', 'UPDATE model_device_connections SET revision=2'],
        ['connection revocation', 'UPDATE model_device_connections SET revoked_at=clock_timestamp()'],
        ['device revocation', 'UPDATE bridge_devices SET revoked=true'],
        ['device expiry', "UPDATE bridge_devices SET expires_at=clock_timestamp()-interval '1 second'"],
        ['project binding', `UPDATE bridge_devices SET report='{"bindings":[]}'::jsonb`],
        ['model identity', `UPDATE model_catalog SET descriptor='{"verificationSha256":"changed"}'::jsonb`],
        ['deadline', "UPDATE device_model_calls SET deadline_at=clock_timestamp()-interval '1 second'"],
    ])('still rejects a completed call when its current %s changed during the guard', async (_kind, sql) => {
        const { result } = await completedWhileGuardWaits();
        await fixture.pool.query(sql);
        run.resume();
        await expect(result).rejects.toMatchObject({ status: 409 });
        const stored = (await fixture.pool.query('SELECT j.state,c.result FROM bridge_jobs j JOIN device_model_calls c ON c.job_id=j.id')).rows[0];
        expect(stored).toMatchObject({ state: 'succeeded', result: { response: run.response } });
        await onlyOneCall();
    });

    it('does not swallow feature revocation merely because a successful receipt arrived', async () => {
        const { result } = await completedWhileGuardWaits();
        const rejection = new Error('Fixture feature revoked');
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(rejection);
        run.resume();
        await expect(result).rejects.toBe(rejection);
        await onlyOneCall();
    });

    it('preserves explicit cancellation when a late paid receipt arrives during the pending guard', async () => {
        const result = run.run(); await run.waiting;
        const { job_id } = await run.ids();
        // Dispatch first, then cancel, then deliver the provider's already accepted result.
        await fixture.pool.query("UPDATE bridge_jobs SET state='running' WHERE id=$1", [job_id]);
        await fixture.pool.query('UPDATE device_model_calls SET dispatched_at=clock_timestamp() WHERE job_id=$1', [job_id]);
        await run.service.cancel(job_id);
        const call = await run.ids();
        const { completeDeviceJob } = await import('../src/devices/device-completion');
        await completeDeviceJob(fixture.pool, deviceId, job_id, { lease, state: 'succeeded', message: 'Late fixture receipt',
            result: { protocol: DEVICE_CODEX_PROTOCOL, callId: call.id, response: run.response } });
        run.resume();
        await expect(result).rejects.toMatchObject({ status: 409 });
        const stored = (await fixture.pool.query('SELECT j.state,c.cancelled_at,c.result FROM bridge_jobs j JOIN device_model_calls c ON c.job_id=j.id')).rows[0];
        expect(stored.state).toBe('cancelled'); expect(stored.cancelled_at).not.toBeNull();
        expect(stored.result.response).toEqual(run.response);
        await onlyOneCall();
    });

    it('does not admit a successful-looking receipt without the durable dispatch marker', async () => {
        const { result } = await completedWhileGuardWaits();
        await fixture.pool.query('UPDATE device_model_calls SET dispatched_at=NULL');
        run.resume();
        await expect(result).rejects.toMatchObject({ status: 409 });
        await onlyOneCall();
    });

    it('keeps authorization, private-context reads and dispatch closed for an already completed call', async () => {
        const { result } = await completedWhileGuardWaits(); run.resume(); await expect(result).resolves.toEqual(run.response);
        const { id, job_id } = await run.ids(), device = { id: deviceId, email: owner } as never;
        await expect(run.service.authorizeJob(device, { id: job_id, kind: DEVICE_CODEX_JOB, lease })).rejects.toMatchObject({ status: 409 });
        await expect(run.service.context(device, { jobId: job_id, lease })).rejects.toMatchObject({ status: 409 });
        await expect(run.service.dispatch(device, { jobId: job_id, lease, callId: id })).rejects.toMatchObject({ status: 409 });
        expect((await fixture.pool.query('SELECT project_id FROM device_model_calls')).rows[0].project_id).toBe(projectId);
        await onlyOneCall();
    });

    it.each(['authorizeJob', 'context'] as const)('keeps %s strict when completion commits after its active snapshot but before its fresh SQL guard', async action => {
        const result = run.run(); await run.waiting;
        const { job_id } = await run.ids(), device = { id: deviceId, email: owner } as never;
        await fixture.pool.query("UPDATE bridge_jobs SET state='running' WHERE id=$1", [job_id]);
        const barrier = run.pauseNextGuard();
        const authorization = action === 'context' ? run.service.context(device, { jobId: job_id, lease })
            : run.service.authorizeJob(device, { id: job_id, kind: DEVICE_CODEX_JOB, lease });
        void authorization.catch(() => undefined);
        await barrier.waiting;
        await run.complete(); barrier.resume();
        await expect(authorization).rejects.toMatchObject({ status: 409 });
        run.resume(); await expect(result).resolves.toEqual(run.response);
        await onlyOneCall();
    });
});
