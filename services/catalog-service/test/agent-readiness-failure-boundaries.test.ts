import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowAgentReadinessRoute } from '../src/agent-readiness/agent-readiness.access';
import { AgentTrialPolicy } from '../src/agent-readiness/agent-readiness.policy';
import { AgentTrialRepository } from '../src/agent-readiness/agent-readiness.repository';
import { AgentReadinessService } from '../src/agent-readiness/agent-readiness.service';
import type { ModelsService } from '../src/models/models.service';
import type { ModelRuntime } from '../src/models/model-runtime';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('Diagnostic admission and recovery failure boundaries', () => {
    it('leaves ordinary agent routes to their existing access policy', () => {
        for (const suffix of ['agents', 'agents/connect', 'agents/agent-one', 'models/readiness']) {
            expect(allowAgentReadinessRoute(2, 'GET', suffix)).toBeUndefined();
        }
    });
    it('rejects a project alias resolving to a different permanent project ID', async () => {
        const models = { pool: {}, actor: vi.fn(async () => ({ email: 'owner@localhost' })), resolveProject: vi.fn(async () => ({ id: 'prj-real' })) } as unknown as ModelsService;
        const policy = new AgentTrialPolicy(models);
        await expect(policy.actor({ headers: {} } as Request, 'Human-readable alias')).rejects.toBeInstanceOf(ForbiddenException);
        expect(models.resolveProject).toHaveBeenCalledWith(expect.anything(), 'Human-readable alias', 2, expect.objectContaining({ email: 'owner@localhost' }));
    });
    it('retains the original database failure and releases a broken connection even when rollback itself fails', async () => {
        const failure = new Error('connection lost'), rollback = new Error('connection is already closed'), release = vi.fn();
        const query = vi.fn(async (sql: string) => { if (sql === 'ROLLBACK') throw rollback; return { rows: [] }; });
        const repository = new AgentTrialRepository({ connect: async () => ({ query, release }) } as unknown as Pool);
        await expect(repository.transaction(async () => { throw failure; })).rejects.toBe(failure);
        expect(release).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledWith('ROLLBACK');
    });
    it('recovers after a transient periodic cleanup failure without inference and stops maintenance on shutdown', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const models = { pool: {}, ready: vi.fn(async () => undefined) } as unknown as ModelsService;
        const runtime = { infer: vi.fn() } as unknown as ModelRuntime, service = new AgentReadinessService(models, runtime);
        const expire = vi.spyOn(service.repository, 'expire').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('temporary database unavailable')).mockResolvedValue(undefined);
        try {
            await service.onModuleInit(); await vi.advanceTimersByTimeAsync(20000);
            expect(expire).toHaveBeenCalledTimes(3); expect(runtime.infer).not.toHaveBeenCalled();
            await service.onApplicationShutdown(); await vi.advanceTimersByTimeAsync(10000);
            expect(expire).toHaveBeenCalledTimes(3);
        } finally { await service.onApplicationShutdown(); }
    });
});
