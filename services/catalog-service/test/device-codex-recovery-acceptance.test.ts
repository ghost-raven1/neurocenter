import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { completeDeviceJob, type DeviceCompletion } from '../src/devices/device-completion';
import { DEVICE_CODEX_JOB, DEVICE_CODEX_PROTOCOL } from '../../shared/device-codex-inference.cjs';

const jobId = '10000000-0000-4000-8000-000000000001';
const callId = '20000000-0000-4000-8000-000000000002';
const deviceId = '30000000-0000-4000-8000-000000000003';
const lease = '40000000-0000-4000-8000-000000000004';
const privateText = 'Ответ с приватным содержимым, которое не должно попасть в общий журнал.';
const receipt = (content = privateText) => ({
    protocol: DEVICE_CODEX_PROTOCOL, callId,
    response: { model: 'codex-fixture', done: true, done_reason: 'stop', message: { role: 'assistant', content },
        prompt_eval_count: 4, eval_count: 8, usage_reported: true },
});
const completion = (result: Record<string, unknown> = receipt()): DeviceCompletion => ({
    lease, state: 'succeeded', message: 'Недоверенное сообщение моста: секрет из локального провайдера', result,
});

/** Real completion/validation code uses an isolated transactional storage port; no PostgreSQL or provider runs. */
function harness(state = 'reconciling') {
    const initial = {
        job: { id: jobId, device_id: deviceId, email: 'owner@example.test', project_id: 'project', role: 'Администратор',
            kind: DEVICE_CODEX_JOB, state, percent: 0, lease, lease_until: new Date(0), result: null as unknown,
            payload: { protocol: DEVICE_CODEX_PROTOCOL, callId, modelId: 'local-model' } },
        call: { id: callId, job_id: jobId, runtime_model: 'codex-fixture', dispatched_at: new Date(0) as Date | null,
            response_digest: null as string | null, result: null as unknown },
    };
    let saved = structuredClone(initial), transaction: typeof saved | undefined;
    let writes = 0;
    const release = vi.fn();
    let failJobWrite = false;
    const query = vi.fn(async (sql: string, args: unknown[] = []) => {
        if (sql === 'BEGIN') { transaction = structuredClone(saved); return { rows: [] }; }
        if (sql === 'COMMIT') { saved = transaction!; transaction = undefined; return { rows: [] }; }
        if (sql === 'ROLLBACK') { transaction = undefined; return { rows: [] }; }
        const data = transaction ?? saved;
        if (sql.startsWith('SELECT * FROM bridge_jobs')) {
            return { rows: args[0] === data.job.id && args[1] === data.job.device_id && args[2] === data.job.lease ? [data.job] : [] };
        }
        if (sql.startsWith('SELECT id,runtime_model')) return { rows: args[0] === data.call.job_id ? [data.call] : [] };
        if (sql.startsWith('UPDATE device_model_calls')) {
            writes++; data.call.result = JSON.parse(String(args[1])); data.call.response_digest = String(args[2]); return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('UPDATE bridge_jobs')) {
            if (failJobWrite) throw new Error('controlled storage failure');
            writes++; data.job.state = String(args[1]); data.job.percent = Number(args[2]); data.job.result = JSON.parse(String(args[4]));
            return { rows: [], rowCount: 1 };
        }
        throw new Error('Unexpected storage operation: ' + sql);
    });
    const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    return {
        pool, query, release, initial,
        read: () => structuredClone(saved), writes: () => writes,
        edit: (change: (data: typeof initial) => void) => change(saved),
        failJobWrite: () => { failJobWrite = true; },
    };
}

describe('Codex: completion crosses the public queue/private receipt boundary', () => {
    it('recovers a completed response after lease expiry and keeps output out of public job data', async () => {
        const fixture = harness();
        const outcome = await completeDeviceJob(fixture.pool, deviceId, jobId, completion());
        expect(outcome).toEqual({ ok: true, repeated: false });
        expect(fixture.read().call.result).toEqual(receipt());
        expect(fixture.read().job).toMatchObject({ state: 'succeeded', percent: 100, result: {
            callId, responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/), status: 'succeeded',
        } });
        const publicWrite = fixture.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE bridge_jobs'));
        expect(JSON.stringify(publicWrite)).not.toContain(privateText);
        expect(JSON.stringify(publicWrite)).not.toContain('секрет из локального провайдера');
        expect(Object.keys(fixture.read().job.result as object).sort()).toEqual(['callId', 'responseDigest', 'status']);
        expect(fixture.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
        expect(fixture.release).toHaveBeenCalledOnce();
    });

    it('replays a lost result ACK without a second write or a new execution job', async () => {
        const fixture = harness();
        await completeDeviceJob(fixture.pool, deviceId, jobId, completion()); // The network discards this ACK.
        const accepted = fixture.read(), writes = fixture.writes();
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion())).resolves.toEqual({ ok: true, repeated: true });
        expect(fixture.read()).toEqual(accepted);
        expect(fixture.writes()).toBe(writes);
        expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    });

    it('an object key-order change on redelivery still refers to the same accepted response', async () => {
        const fixture = harness();
        await completeDeviceJob(fixture.pool, deviceId, jobId, completion());
        const first = receipt();
        const reordered = { response: { usage_reported: true, eval_count: 8, prompt_eval_count: 4,
            message: { content: privateText, role: 'assistant' }, done_reason: 'stop', done: true, model: 'codex-fixture' },
            callId: first.callId, protocol: first.protocol };
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion(reordered))).resolves.toMatchObject({ repeated: true });
        expect(fixture.writes()).toBe(2);
    });

    it('a conflicting redelivery cannot replace an accepted private response', async () => {
        const fixture = harness();
        await completeDeviceJob(fixture.pool, deviceId, jobId, completion());
        const accepted = fixture.read();
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion(receipt('Другой ответ')))).rejects.toMatchObject({ status: 409 });
        expect(fixture.read()).toEqual(accepted);
        expect(fixture.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    });

    it.each(['cancelled', 'failed'])('retains a late dispatched receipt for an already %s job', async state => {
        const fixture = harness(state);
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion())).resolves.toMatchObject({ ok: true });
        expect(fixture.read().call.result).toEqual(receipt());
        if (state === 'cancelled') expect(fixture.read().job.state).toBe('cancelled');
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion())).resolves.toMatchObject({ repeated: true });
    });

    it('a useful response above the generic 10 kB job limit is stored only in the private receipt', async () => {
        const fixture = harness();
        const result = receipt('私'.repeat(8000));
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion(result))).resolves.toMatchObject({ ok: true });
        expect(fixture.read().call.result).toEqual(result);
        expect(JSON.stringify(fixture.read().job.result).length).toBeLessThan(300);
    });

    it('a success without a committed dispatch cannot claim a provider response', async () => {
        const fixture = harness('running');
        fixture.edit(data => { data.call.dispatched_at = null; });
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion())).rejects.toMatchObject({ status: 409 });
        expect(fixture.read().call.result).toBeNull();
        expect(fixture.writes()).toBe(0);
    });

    it('a response for another exact runtime model cannot verify this connection', async () => {
        const fixture = harness();
        const wrong = receipt(); wrong.response.model = 'another-model';
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion(wrong))).rejects.toMatchObject({ status: 409 });
        expect(fixture.writes()).toBe(0);
    });

    it('a queued job cannot become successful solely by receiving a receipt', async () => {
        const fixture = harness('queued');
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion())).rejects.toMatchObject({ status: 409 });
        expect(fixture.writes()).toBe(0);
    });

    it.each(['device', 'lease'])('an unrelated %s cannot read or alter a private receipt', async changed => {
        const fixture = harness();
        await expect(completeDeviceJob(fixture.pool, changed === 'device' ? 'other-device' : deviceId, jobId,
            { ...completion(), ...(changed === 'lease' ? { lease: 'other-lease' } : {}) })).rejects.toMatchObject({ status: 409 });
        expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('SELECT id,runtime_model'))).toBe(false);
        expect(fixture.writes()).toBe(0);
    });

    it('private write and public receipt roll back together if the public write fails', async () => {
        const fixture = harness(), before = fixture.read();
        fixture.failJobWrite();
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, completion())).rejects.toThrow('controlled storage failure');
        expect(fixture.read()).toEqual(before);
        expect(fixture.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
        expect(fixture.release).toHaveBeenCalledOnce();
    });

    it('a bounded unknown-after-send failure is accepted without raw provider details', async () => {
        const fixture = harness();
        const result = { protocol: DEVICE_CODEX_PROTOCOL, callId, error: { code: 'unknown-after-send' } };
        await expect(completeDeviceJob(fixture.pool, deviceId, jobId, { ...completion(result), state: 'failed' })).resolves.toMatchObject({ ok: true });
        expect(fixture.read().call.result).toEqual(result);
        expect(fixture.read().job).toMatchObject({ state: 'failed', result: { status: 'failed' } });
        expect(JSON.stringify(fixture.read().job.result)).not.toContain('unknown-after-send');
    });
});
