import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import type { UsageTerminal } from '../src/model-usage/model-usage.types';
import type { IModel } from '../src/models/model.types';
import type { ModelsService } from '../src/models/models.service';
import { RemoteConnectionService } from '../src/models/remote-connection.service';
import type { IRemoteConnectionRow } from '../src/models/remote-connection.repository';
import { RemoteModelClient, RemoteModelError } from '../src/models/remote-model-client';
import { remoteVerificationDigest } from '../src/models/remote-model-validation';
import { notifyModelCatalogChange } from '../src/models/model-events';

// Exercise the real usage reservation/cancellation path without opening SQL or contacting a provider.
vi.mock('../src/database/pool', () => ({ createPool: () => ({ end: vi.fn(async () => undefined) }) }));
vi.mock('../src/models/model-events', () => ({ notifyModelCatalogChange: vi.fn(async () => undefined) }));
const model: IModel = { id: 'model-remote-admission', name: 'Remote', description: '', capability: 'chat', runtime: 'remote-openai',
    model: 'fixture-model', modelVersion: 'v1', manifestSha256: null, verificationSha256: null, dimension: null,
    source: 'custom', revision: 4, createdAt: '', updatedAt: '' };
const row: IRemoteConnectionRow = { model_id: model.id, revision: 2, base_url: 'https://provider.example.test/v1', request_dimensions: false,
    options: {}, timeout_ms: 90000, credential_kind: 'none', credential: null, credential_env: null, semantic_sha: null,
    verified_at: null, failure_message: null, revoked_at: null };
const response = { model: model.model, message: { role: 'assistant', content: 'OK' }, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3 };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
let flags = defaultFeatureFlags();
beforeEach(() => { flags = defaultFeatureFlags(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 }))); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('Remote verification admission after a durable usage reservation', () => {
    const fixture = () => {
        const models = { pool: {} } as ModelsService, usage = new ModelUsageService(models), remote = new RemoteConnectionService(models, usage);
        const started = deferred(), held = deferred(), authorize = vi.fn(async () => undefined);
        const begin = vi.spyOn(usage.repository, 'begin').mockImplementation(async () => { started.release(); await held.promise; });
        const finish = vi.spyOn(usage.repository, 'finish').mockResolvedValue(undefined);
        vi.spyOn(usage.repository, 'interrupt').mockResolvedValue(undefined);
        vi.spyOn(remote.repository, 'head').mockResolvedValue(row);
        const verify = vi.spyOn(remote.repository, 'verify').mockImplementation(async (expected, _revision, digest, _dimension, _actor, current) => {
            await current(); return { ...expected, verificationSha256: digest };
        });
        const failure = vi.spyOn(remote.repository, 'failure').mockResolvedValue(undefined);
        const infer = vi.spyOn(RemoteModelClient.prototype, 'infer').mockResolvedValue(response);
        const send = (signal?: AbortSignal) => remote.check(model, 'owner@example.test', authorize, signal);
        const close = async () => { held.release(); await usage.onApplicationShutdown(); };
        return { usage, remote, started, held, authorize, begin, finish, verify, failure, infer, send, close };
    };
    it('does not start a paid probe if hosting is disabled while the usage reservation waits', async () => {
        const f = fixture(), pending = f.send(), result = pending.catch(error => error);
        try {
            await f.started.promise; flags.model_hosting = false; f.held.release();
            expect(await result).toMatchObject({ status: 403 }); expect(f.infer).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
            expect(f.failure).not.toHaveBeenCalled(); expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'error' }));
        } finally { f.held.release(); await pending.catch(() => undefined); await f.close(); }
    });
    it('fails closed when the fresh hosting decision is unavailable after the reservation', async () => {
        const f = fixture(), pending = f.send(), result = pending.catch(error => error);
        try {
            await f.started.promise; vi.mocked(fetch).mockRejectedValue(new Error('private flag endpoint')); f.held.release();
            expect(await result).toBeInstanceOf(ServiceUnavailableException); expect(f.infer).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
            expect(f.failure).not.toHaveBeenCalled(); expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'error' }));
        } finally { f.held.release(); await pending.catch(() => undefined); await f.close(); }
    });
    it('preserves the caller cancellation identity while the usage reservation waits', async () => {
        const f = fixture(), abort = new AbortController(), reason = new Error('Owned cancellation'), pending = f.send(abort.signal), result = pending.catch(error => error);
        try {
            await f.started.promise; abort.abort(reason); f.held.release(); expect(await result).toBe(reason);
            expect(f.infer).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'cancelled' }));
        } finally { f.held.release(); await pending.catch(() => undefined); await f.close(); }
    });
    it('rechecks cancellation after a pending fresh decision even if the decision later allows hosting', async () => {
        const f = fixture(), abort = new AbortController(), reason = new Error('Cancelled during admission'), decision = deferred(), atDecision = deferred(), atProvider = deferred(); let requests = 0;
        vi.mocked(fetch).mockImplementation(async () => { if (++requests === 2) { atDecision.release(); await decision.promise; } return new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 }); });
        f.infer.mockImplementation(async () => { atProvider.release(); return response; });
        const pending = f.send(abort.signal), result = pending.catch(error => error);
        try {
            await f.started.promise; f.held.release(); await Promise.race([atDecision.promise, atProvider.promise]);
            expect(f.infer).not.toHaveBeenCalled(); abort.abort(reason); decision.release(); expect(await result).toBe(reason);
            expect(f.infer).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'cancelled' }));
        } finally { decision.release(); f.held.release(); await pending.catch(() => undefined); await f.close(); }
    });
    it('does not send a paid probe after the operator role is revoked while the reservation waits', async () => {
        const f = fixture(), error = new Error('Role revoked during reservation'), pending = f.send(), result = pending.catch(cause => cause);
        try {
            await f.started.promise; f.authorize.mockRejectedValue(error); f.held.release(); expect(await result).toBe(error);
            expect(f.infer).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'error' }));
        } finally { f.held.release(); await pending.catch(() => undefined); await f.close(); }
    });
    it('does not send a paid probe if the caller cancels while fresh authorization is pending', async () => {
        const f = fixture(), abort = new AbortController(), reason = new Error('Cancelled during fresh authorization'), authorized = deferred(), heldAuthorization = deferred();
        f.authorize.mockImplementation(async () => { authorized.release(); await heldAuthorization.promise; });
        const pending = f.send(abort.signal), result = pending.catch(error => error);
        try {
            await f.started.promise; f.held.release(); await authorized.promise; expect(f.infer).not.toHaveBeenCalled();
            abort.abort(reason); heldAuthorization.release(); expect(await result).toBe(reason);
            expect(f.infer).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'cancelled' }));
        } finally { heldAuthorization.release(); f.held.release(); await pending.catch(() => undefined); await f.close(); }
    });
    it('verifies the same model/connection CAS and fresh authorization after exactly one ordinary probe', async () => {
        const f = fixture(); f.held.release();
        try {
            await f.send(); const connection = f.remote.repository.connection(row);
            expect(f.infer).toHaveBeenCalledExactlyOnceWith(model, connection, 'chat', expect.objectContaining({ options: { num_predict: 64 } }), expect.any(AbortSignal));
            expect(f.verify).toHaveBeenCalledExactlyOnceWith(model, 2, remoteVerificationDigest(model, connection, null), null, 'owner@example.test', expect.any(Function));
            expect(f.authorize).toHaveBeenCalledTimes(2); expect(notifyModelCatalogChange).toHaveBeenCalledOnce();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'success', inputTokens: 7, outputTokens: 3 }));
        } finally { await f.close(); }
    });
    it.each([
        { mode: 'modern', budget: 32, expected: 32 }, { mode: 'modern', budget: 8192, expected: 8192 }, { mode: 'modern', budget: undefined, expected: 64 },
        { mode: 'legacy', budget: 32, expected: 32 }, { mode: 'legacy', budget: 8192, expected: 64 }, { mode: 'legacy', budget: undefined, expected: 64 },
    ])('uses the explicit $mode verification budget $budget without guessing or retrying', async ({ mode, budget, expected }) => {
        const f = fixture(); f.held.release();
        vi.mocked(f.remote.repository.head).mockResolvedValue({ ...row, options: {
            ...(mode === 'modern' ? { tokenLimitParameter: 'max_completion_tokens' as const } : {}),
            ...(budget === undefined ? {} : { maxOutputTokens: budget }),
        } });
        try {
            await f.send(); expect(f.infer).toHaveBeenCalledOnce();
            expect(f.infer).toHaveBeenCalledWith(model, expect.any(Object), 'chat', expect.objectContaining({ options: { num_predict: expected } }), expect.any(AbortSignal));
            expect(f.verify).toHaveBeenCalledOnce();
        } finally { await f.close(); }
    });
    it('keeps an admitted paid result if hosting changes while the provider responds', async () => {
        const f = fixture(); f.held.release(); f.infer.mockImplementation(async () => { flags.model_hosting = false; return response; });
        try { await f.send(); expect(f.infer).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce(); expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'success' })); }
        finally { await f.close(); }
    });
    it('preserves the provider error and never retries paid verification', async () => {
        const f = fixture(), error = new RemoteModelError('authorization', 'Safe provider refusal'); f.held.release(); f.infer.mockRejectedValue(error);
        try { await expect(f.send()).rejects.toBe(error); expect(f.infer).toHaveBeenCalledOnce(); expect(f.verify).not.toHaveBeenCalled(); expect(f.failure).toHaveBeenCalledExactlyOnceWith(row, error.message); }
        finally { await f.close(); }
    });
    it('preserves late authorization refusal without republishing or repeating the completed probe', async () => {
        const f = fixture(), error = new Error('Fresh role revoked'); f.held.release();
        f.infer.mockImplementation(async () => { f.authorize.mockRejectedValue(error); return response; });
        try { await expect(f.send()).rejects.toBe(error); expect(f.infer).toHaveBeenCalledOnce(); expect(f.authorize).toHaveBeenCalledTimes(2); expect(notifyModelCatalogChange).not.toHaveBeenCalled(); }
        finally { await f.close(); }
    });
    it('retries only a lost terminal usage acknowledgement after the one completed provider call', async () => {
        const f = fixture(), terminals: UsageTerminal[] = []; f.held.release();
        f.finish.mockImplementation(async (_id, _worker, value) => { terminals.push(structuredClone(value)); if (terminals.length === 1) throw new Error('Owned terminal ACK lost'); });
        try { await f.send(); expect(f.infer).toHaveBeenCalledOnce(); await f.close(); expect(terminals).toHaveLength(2); expect(terminals[1]).toEqual(terminals[0]); expect(f.infer).toHaveBeenCalledOnce(); }
        finally { await f.close(); }
    });
});
