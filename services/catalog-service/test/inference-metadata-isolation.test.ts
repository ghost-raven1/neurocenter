import 'reflect-metadata';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { ModelApiAdmission } from '../src/model-api-admission/model-api-admission';
import { createModelDispatchMetrics, withModelDispatchMetrics } from '../src/model-usage/model-dispatch-metrics';
import { currentModelUsage, withModelUsage } from '../src/model-usage/model-usage.context';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import { ModelUsageRepository } from '../src/model-usage/model-usage.repository';
import type { IModel } from '../src/models/model.types';
import type { ModelsService } from '../src/models/models.service';
import { RemoteConnectionService } from '../src/models/remote-connection.service';
import type { IRemoteConnectionRow } from '../src/models/remote-connection.repository';
import { RemoteModelClient, RemoteModelError } from '../src/models/remote-model-client';
import {anonymousProviderAccess} from './remote-provider.fixture';

vi.mock('../src/models/model-events', () => ({ notifyModelCatalogChange: vi.fn(async () => undefined) }));
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: vi.fn(async () => undefined) }));
const model = { id: 'metadata-model', name: 'Metadata model', capability: 'chat', runtime: 'remote-openai', model: 'fixture', revision: 1,
    verificationSha256: 'a'.repeat(64) } as IModel;
const row = { model_id: model.id, revision: 1, base_url: 'http://127.0.0.1:1/v1', request_dimensions: false, credential_kind: 'none',
    credential: null, credential_env: null, options: {}, timeout_ms: 90000, semantic_sha: model.verificationSha256,
    verified_at: null, failure_message: null, revoked_at: null } satisfies IRemoteConnectionRow;
const answer = { message: { content: 'completed provider answer' } };
function remote() {
    const service = new RemoteConnectionService({ pool: {} } as ModelsService,undefined,undefined,anonymousProviderAccess);
    const pinned = vi.spyOn(service.repository, 'pinned').mockResolvedValue(row);
    const failure = vi.spyOn(service.repository, 'failure').mockRejectedValue(new Error('private SQL failure'));
    const infer = vi.spyOn(RemoteModelClient.prototype, 'infer').mockResolvedValue(answer);
    return { service, pinned, failure, infer };
}
function barrier() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
beforeEach(() => {
    const flags = defaultFeatureFlags(); flags.model_rate_limits = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Optional remote connection diagnostics do not replace provider outcomes', () => {
    it('returns the completed personal answer without writing a common credential-health state', async () => {
        const f = remote();
        await expect(f.service.infer(model, 'chat', {})).resolves.toBe(answer);
        expect(f.infer).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
        expect(f.pinned).toHaveBeenCalledTimes(2);
    });
    it('preserves the sanitized personal error without blocking other users through common health', async () => {
        const f = remote(); f.infer.mockRejectedValue(new RemoteModelError('response', 'Безопасная ошибка провайдера.'));
        const error = await f.service.infer(model, 'chat', {}).catch(error => error);
        expect(error.getStatus()).toBe(503); expect(error.message).toBe('Безопасная ошибка провайдера.');
        expect(f.failure).not.toHaveBeenCalled();
        expect(f.infer).toHaveBeenCalledOnce();
    });
    it('preserves a failed probe outcome when the diagnostic write fails', async () => {
        const f = remote(), cause = new RemoteModelError('response', 'Безопасная ошибка проверки.');
        vi.spyOn(f.service.repository, 'head').mockResolvedValue(row); f.infer.mockRejectedValue(cause);
        await expect(f.service.check(model, 'admin@example.test', async () => undefined)).rejects.toBe(cause);
        expect(f.infer).toHaveBeenCalledOnce();
    });
    it('still rejects a changed pin after the provider responds and does not clear health', async () => {
        const f = remote(); f.pinned.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, revision: 2 });
        await expect(f.service.infer(model, 'chat', {})).rejects.toBeInstanceOf(ConflictException);
        expect(f.infer).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
    });
    it('retains fresh inherited authorization immediately before a physical request', async () => {
        const f = remote(), action = vi.fn(), denied = new ForbiddenException('Access revoked');
        f.infer.mockImplementation(async () => { await currentModelUsage().beforeInference?.(); action(); return answer; });
        await expect(withModelUsage({ purpose: 'chat', beforeInference: async () => { throw denied; } }, () => f.service.infer(model, 'chat', {}))).rejects.toBe(denied);
        expect(action).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
    });
});

describe('Admission preserves results when activity recording rejects', () => {
    const gate = () => new ModelApiAdmission({ acquire: vi.fn() } as never);
    it('handles an active write rejection before a delayed provider completes', async () => {
        const held = barrier(), entered = barrier(), metrics = createModelDispatchMetrics();
        const progress = vi.fn(async (_active: boolean) => { entered.release(); throw new Error('metadata write failed'); }); metrics.progress = progress;
        const action = vi.fn(async () => { await held.promise; return answer; });
        const result = withModelDispatchMetrics(metrics, () => gate().run(model, undefined, action));
        await entered.promise; held.release();
        await expect(result).resolves.toBe(answer);
        expect(progress.mock.calls.map(args => args[0])).toEqual([true, false]); expect(action).toHaveBeenCalledOnce();
    });
    it('keeps the original provider rejection when both progress writes fail', async () => {
        const metrics = createModelDispatchMetrics(), provider = new Error('provider failure');
        metrics.progress = vi.fn(async () => { throw new Error('metadata failure'); });
        const action = vi.fn(async () => { throw provider; });
        await expect(withModelDispatchMetrics(metrics, () => gate().run(model, undefined, action))).rejects.toBe(provider);
        expect(action).toHaveBeenCalledOnce();
    });
    it('does not lose an already dispatched result when a progress callback throws synchronously', async () => {
        const metrics = createModelDispatchMetrics(); metrics.progress = () => { throw new Error('synchronous activity failure'); };
        const action = vi.fn(async () => answer);
        await expect(withModelDispatchMetrics(metrics, () => gate().run(model, undefined, action))).resolves.toBe(answer);
        expect(action).toHaveBeenCalledOnce();
    });
    it('retains active-before-settled ordering without changing the counted provider action', async () => {
        const metrics = createModelDispatchMetrics(), entered = barrier(), active = barrier(), calls: boolean[] = [];
        metrics.progress = async value => { calls.push(value); if (value) { entered.release(); await active.promise; } };
        const action = vi.fn(async () => answer), result = withModelDispatchMetrics(metrics, () => gate().run(model, undefined, action));
        await entered.promise; expect(calls).toEqual([true]); active.release();
        await expect(result).resolves.toBe(answer); expect(calls).toEqual([true, false]); expect(action).toHaveBeenCalledOnce();
    });
});

describe('Independent terminal receipt recovery', () => {
    it('continues to the second receipt when the first receipt remains unavailable, without repeating either provider', async () => {
        const service = new ModelUsageService({} as ModelsService);
        const action = vi.fn(async () => answer);
        vi.spyOn(service.repository, 'begin').mockResolvedValue(undefined);
        const finish = vi.spyOn(service.repository, 'finish').mockRejectedValue(new Error('terminal acknowledgement unknown'));
        try {
            await service.observe(model, 'chat', action); await service.observe(model, 'chat', action);
            const [first, second] = finish.mock.calls.map(args => args[0]);
            finish.mockImplementation(async id => { if (id === first) throw new Error('first receipt is still locked'); });
            await expect((service as unknown as { flush(): Promise<void> }).flush()).resolves.toBeUndefined();
            expect(finish.mock.calls.slice(2).map(args => args[0])).toEqual([first, second]);
            finish.mockClear();
            await (service as unknown as { flush(): Promise<void> }).flush();
            expect(finish.mock.calls.map(args => args[0])).toEqual([first]);
            expect(action).toHaveBeenCalledTimes(2);
        } finally { await service.pool.end(); }
    });
    it('still recovers expired receipts when renewing this worker metadata fails', async () => {
        const service = new ModelUsageService({} as ModelsService);
        const renew = vi.spyOn(service.repository, 'renew').mockRejectedValue(new Error('one worker renewal is locked'));
        const recover = vi.spyOn(service.repository, 'recover').mockResolvedValue(undefined);
        try {
            await expect((service as unknown as { maintain(): Promise<void> }).maintain()).resolves.toBeUndefined();
            expect(renew).toHaveBeenCalledExactlyOnceWith(service.workerId); expect(recover).toHaveBeenCalledOnce();
        } finally { await service.pool.end(); }
    });
    it('bounds each recovery batch and rotates failed receipts so later outcomes get their turn', async () => {
        const service = new ModelUsageService({} as ModelsService), action = vi.fn(async () => answer);
        vi.spyOn(service.repository, 'begin').mockResolvedValue(undefined);
        const finish = vi.spyOn(service.repository, 'finish').mockRejectedValue(new Error('receipt is unavailable'));
        try {
            for (let index = 0; index < 6; index++) await service.observe(model, 'chat', action);
            const ids = finish.mock.calls.map(args => args[0]); finish.mockClear();
            await (service as unknown as { flush(): Promise<void> }).flush();
            expect(finish.mock.calls.map(args => args[0])).toEqual(ids.slice(0, 5)); finish.mockClear();
            await (service as unknown as { flush(): Promise<void> }).flush();
            expect(finish.mock.calls.map(args => args[0])).toEqual([ids[5], ...ids.slice(0, 4)]);
            expect(action).toHaveBeenCalledTimes(6);
        } finally { await service.pool.end(); }
    });
    it('renews active leases and recovers expired rows before attempting queued writebacks', async () => {
        const service = new ModelUsageService({} as ModelsService), order: string[] = [];
        vi.spyOn(service.repository, 'renew').mockImplementation(async () => { order.push('renew'); });
        vi.spyOn(service.repository, 'recover').mockImplementation(async () => { order.push('recover'); });
        vi.spyOn(service as unknown as { flush(): Promise<void> }, 'flush').mockImplementation(async () => { order.push('flush'); });
        try { await (service as unknown as { maintain(): Promise<void> }).maintain(); expect(order).toEqual(['renew', 'recover', 'flush']); }
        finally { await service.pool.end(); }
    });
    it('does not let optional writes bypass an already queued mandatory reservation', async () => {
        const pool = { waitingCount: 1, query: vi.fn(async (_query: unknown) => ({ rows: [] })) }, repository = new ModelUsageRepository(pool as never);
        await expect(repository.dispatchProgress('receipt', 'worker', 1, null, null)).rejects.toThrow();
        await expect(repository.finish('receipt', 'worker', { status: 'success', inputTokens: null, outputTokens: null, latencyMs: 1 })).rejects.toThrow();
        expect(pool.query).not.toHaveBeenCalled();
        await repository.begin({ id: 'receipt', workerId: 'worker', model, endpoint: 'chat', purpose: 'direct' });
        expect(pool.query).toHaveBeenCalledOnce(); expect(pool.query.mock.calls[0][0]).toContain('INSERT INTO model_usage_calls');
    });
    it('stops shutdown after a full failed receipt pass without repeating either provider', async () => {
        const service = new ModelUsageService({} as ModelsService), action = vi.fn(async () => answer);
        vi.spyOn(service.repository, 'begin').mockResolvedValue(undefined);
        const finish = vi.spyOn(service.repository, 'finish').mockRejectedValue(new Error('Receipt store remains unavailable'));
        vi.spyOn(service.repository, 'interrupt').mockResolvedValue(undefined);
        for (let index = 0; index < 6; index++) await service.observe(model, 'chat', action);
        const ids = finish.mock.calls.map(args => args[0]); finish.mockClear();
        await service.onApplicationShutdown();
        expect(new Set(finish.mock.calls.map(args => args[0]))).toEqual(new Set(ids));
        expect(finish.mock.calls.length).toBeLessThanOrEqual(10); expect(action).toHaveBeenCalledTimes(6);
    });
});

describe('Usage recovery startup is independent from mandatory schema readiness', () => {
    it('starts after a recovery failure, keeps paid reservation fail-closed, and retries recovery during maintenance', async () => {
        const service = new ModelUsageService({ ready: async () => undefined } as unknown as ModelsService);
        const recover = vi.spyOn(service.repository, 'recover').mockRejectedValueOnce(new Error('recovery row is locked')).mockResolvedValue(undefined);
        vi.spyOn(service.repository, 'renew').mockResolvedValue(undefined);
        vi.spyOn(service.repository, 'interrupt').mockResolvedValue(undefined);
        vi.spyOn(service.repository, 'begin').mockRejectedValue(new Error('durable receipt is unavailable'));
        const action = vi.fn(async () => answer);
        try {
            await expect(service.onModuleInit()).resolves.toBeUndefined();
            await expect(service.observe(model, 'chat', action)).rejects.toMatchObject({ status: 503 });
            expect(action).not.toHaveBeenCalled();
            await (service as unknown as { maintain(): Promise<void> }).maintain();
            expect(recover).toHaveBeenCalledTimes(2);
        } finally { await service.onApplicationShutdown(); }
    });
    it('still rejects mandatory model/schema readiness before attempting optional recovery', async () => {
        const required = new Error('mandatory catalog schema is unavailable');
        const service = new ModelUsageService({ ready: async () => { throw required; } } as unknown as ModelsService);
        const recover = vi.spyOn(service.repository, 'recover').mockResolvedValue(undefined);
        try { await expect(service.onModuleInit()).rejects.toBe(required); expect(recover).not.toHaveBeenCalled(); }
        finally { await service.pool.end(); }
    });
});
