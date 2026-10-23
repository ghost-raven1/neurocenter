import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { ModelRuntime } from '../src/models/model-runtime';
import type { IModel } from '../src/models/model.types';
import type { ModelsService } from '../src/models/models.service';
import type { OllamaClient } from '../src/models/ollama-client';
import type { RemoteConnectionService } from '../src/models/remote-connection.service';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import { withModelUsage } from '../src/model-usage/model-usage.context';
import type { UsageTerminal } from '../src/model-usage/model-usage.types';

// Admission/ledger ordering is under test; this suite never opens a PostgreSQL connection.
vi.mock('../src/database/pool', () => ({ createPool: () => ({ end: vi.fn(async () => undefined) }) }));
const model: IModel = { id: 'model-admission', name: 'Admission', description: '', capability: 'chat', runtime: 'ollama', model: 'test:admission',
    manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
const response = { message: { role: 'assistant', content: 'Already received answer' }, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3 };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
let flags = defaultFeatureFlags();
beforeEach(() => { flags = defaultFeatureFlags(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 }))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Provider admission after a delayed durable usage reservation', () => {
    const fixture = () => {
        const usage = new ModelUsageService({} as ModelsService), started = deferred(), held = deferred();
        const begin = vi.spyOn(usage.repository, 'begin').mockImplementation(async () => { started.release(); await held.promise; });
        const finish = vi.spyOn(usage.repository, 'finish').mockResolvedValue(undefined);
        vi.spyOn(usage.repository, 'interrupt').mockResolvedValue(undefined);
        const local = { infer: vi.fn(async () => response) }, remote = { infer: vi.fn(async () => response) };
        const runtime = new ModelRuntime(local as unknown as OllamaClient, remote as unknown as RemoteConnectionService, usage);
        const send = (signal?: AbortSignal, selected = model, beforeInference?: () => Promise<void>) => withModelUsage({ purpose: 'verification', actorEmail: 'owner@example.test',
            projectId: 'prj-admission', agentId: 'agent-admission', requiredFeatures: ['agents', 'model_chat', 'group_chat', 'model_hosting', 'research_tools'], beforeInference },
        () => runtime.infer(selected, 'chat', { messages: [{ role: 'user', content: 'Question' }], stream: false }, signal));
        return { usage, started, held, begin, finish, local, remote, runtime, send };
    };
    it.each(['model_hosting', 'group_chat', 'research_tools'] as const)('blocks a new provider call if %s is disabled while the ledger reservation waits', async key => {
        const f = fixture(), pending = f.send(); const result = pending.catch(error => error);
        try {
            await f.started.promise; flags[key] = false; f.held.release();
            expect(await result).toMatchObject({ status: 403 });
            expect(f.local.infer).not.toHaveBeenCalled(); expect(f.remote.infer).not.toHaveBeenCalled();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId,
                expect.objectContaining({ status: 'error', inputTokens: null, outputTokens: null }));
        } finally { f.held.release(); await pending.catch(() => undefined); await f.usage.onApplicationShutdown(); }
    });
    it('fails closed and finalizes the reservation when the post-wait flag service is unavailable', async () => {
        const f = fixture(), pending = f.send(); const result = pending.catch(error => error);
        try {
            await f.started.promise; vi.mocked(fetch).mockRejectedValue(new Error('private unavailable address')); f.held.release();
            expect(await result).toBeInstanceOf(ServiceUnavailableException); expect(f.local.infer).not.toHaveBeenCalled();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'error' }));
        } finally { f.held.release(); await pending.catch(() => undefined); await f.usage.onApplicationShutdown(); }
    });
    it('retains the ordinary cancellation fence while waiting for the reservation', async () => {
        const f = fixture(), abort = new AbortController(), pending = f.send(abort.signal), result = pending.catch(error => error);
        try {
            await f.started.promise; abort.abort(new Error('cancelled')); f.held.release();
            expect(await result).toBe(abort.signal.reason); expect(f.local.infer).not.toHaveBeenCalled();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'cancelled' }));
        } finally { f.held.release(); await pending.catch(() => undefined); await f.usage.onApplicationShutdown(); }
    });
    it('keeps an already received paid result and its usage when the flag changes during inference', async () => {
        const f = fixture(); f.held.release(); f.local.infer.mockImplementation(async () => { flags.model_hosting = false; return response; });
        try {
            expect(await f.send()).toBe(response); expect(f.local.infer).toHaveBeenCalledOnce();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId,
                expect.objectContaining({ status: 'success', inputTokens: 7, outputTokens: 3 }));
        } finally { await f.usage.onApplicationShutdown(); }
    });
    it('does not bypass the post-reservation fence for a remote provider', async () => {
        const f = fixture(), pending = f.send(undefined, { ...model, runtime: 'remote-openai' }), result = pending.catch(error => error);
        try {
            await f.started.promise; flags.model_hosting = false; f.held.release();
            expect(await result).toMatchObject({ status: 403 }); expect(f.remote.infer).not.toHaveBeenCalled();
        } finally { f.held.release(); await pending.catch(() => undefined); await f.usage.onApplicationShutdown(); }
    });
    it('never sends a provider call if the initial durable reservation fails', async () => {
        const f = fixture(); f.begin.mockRejectedValue(new Error('private database details'));
        try {
            await expect(f.send()).rejects.toBeInstanceOf(ServiceUnavailableException);
            expect(f.local.infer).not.toHaveBeenCalled(); expect(f.finish).not.toHaveBeenCalled();
        } finally { await f.usage.onApplicationShutdown(); }
    });
    it('checks the current job generation and grants after a delayed usage reservation', async () => {
        const f = fixture(); let current = true;
        const authorize = vi.fn(async () => { if (!current) throw new Error('job revoked'); });
        const pending = f.send(undefined, model, authorize), result = pending.catch(error => error);
        try {
            await f.started.promise; expect(authorize).not.toHaveBeenCalled(); current = false; f.held.release();
            expect(await result).toMatchObject({ message: 'job revoked' }); expect(authorize).toHaveBeenCalledOnce();
            expect(f.local.infer).not.toHaveBeenCalled(); expect(f.remote.infer).not.toHaveBeenCalled();
            expect(f.finish).toHaveBeenCalledWith(expect.any(String), f.usage.workerId, expect.objectContaining({ status: 'error' }));
        } finally { f.held.release(); await pending.catch(() => undefined); await f.usage.onApplicationShutdown(); }
    });
    it('checks feature flags after the final job authorization callback has waited', async () => {
        const f = fixture(); f.held.release();
        try {
            await expect(f.send(undefined, model, async () => {flags.group_chat = false;})).rejects.toMatchObject({ status: 403 });
            expect(f.local.infer).not.toHaveBeenCalled(); expect(f.remote.infer).not.toHaveBeenCalled();
        } finally { await f.usage.onApplicationShutdown(); }
    });
    it('retries only the failed terminal write-back without repeating a provider call', async () => {
        const f = fixture(); f.held.release(); const terminals: UsageTerminal[] = [];
        f.finish.mockImplementation(async (_id, _worker, value) => { terminals.push(structuredClone(value)); if (terminals.length === 1) throw new Error('ACK lost'); });
        expect(await f.send()).toBe(response); expect(f.local.infer).toHaveBeenCalledOnce();
        await f.usage.onApplicationShutdown(); expect(f.local.infer).toHaveBeenCalledOnce();
        expect(terminals).toHaveLength(2); expect(terminals[1]).toEqual(terminals[0]); expect(terminals[1].status).toBe('success');
    });
});
