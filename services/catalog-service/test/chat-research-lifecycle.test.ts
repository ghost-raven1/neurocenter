import 'reflect-metadata';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { buildPackage } from '../src/catalog/bundle-package';
import { ChatResearchExecutor, type ResearchScope } from '../src/model-chat/chat-research';
import type { ChatResearchTools } from '../src/model-chat/chat-research-tools';
import type { ChatResearchStep, FinishResearchStep, StartResearchStep } from '../src/model-chat/chat-research.types';
import type { ChatRepository, ChatDb } from '../src/model-chat/chat.repository';
import type { ConversationRow } from '../src/model-chat/chat.types';
import type { ModelChatProjectContext } from '../src/model-chat/chat-project-context';
import type { IModel } from '../src/models/model.types';

const model: IModel = { id: 'model-research-lifecycle', name: 'Research', description: '', capability: 'chat', runtime: 'ollama', model: 'test:research',
    manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
const pkg = buildPackage({ id: 'research-test', name: 'Research', kind: 'mcp', version: 1 }, [], '2026-10-22', { transport: 'stdio', args: [], extra: {} });
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
let flags = defaultFeatureFlags();
beforeEach(() => { flags = defaultFeatureFlags(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Research external-call lifecycle fences', () => {
    const fixture = (holdFinal = false) => {
        const gateEntered = deferred(), gateRelease = deferred(), abort = new AbortController();
        let metadataDone = false, holdNextGate = holdFinal, allowed = true, packageCurrent = true;
        vi.stubGlobal('fetch', vi.fn(async () => {
            if (metadataDone && holdNextGate) { holdNextGate = false; gateEntered.release(); await gateRelease.promise; }
            return new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 });
        }));
        const row = { id: randomUUID(), project_id: 'prj-research-lifecycle', mode: 'model', model_id: model.id } as ConversationRow;
        const turn = { id: randomUUID(), request_id: randomUUID(), status: 'pending', removed_at: null, lease_until: new Date(Date.now() + 60000),
            research_request: { project: false, external: { assetId: pkg.plugin.id, version: 1, manifest: pkg.manifest.sha256 } } } as ResearchScope['turn'];
        const authorize = vi.fn(async () => { if (!allowed) throw new ForbiddenException('Access revoked'); });
        const db = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } as unknown as ChatDb;
        const repository = { pool: db, priorTurn: vi.fn(async () => turn), stage: vi.fn(async () => undefined), bump: vi.fn(async () => undefined),
            owned: async <T>(_owner: string, _id: string, current: (db: ChatDb) => Promise<unknown>, action: (db: ChatDb, row: ConversationRow) => Promise<T>) => {
                await current(db); const result = await action(db, row); await current(db); return result;
            } } as unknown as ChatRepository;
        const tools = { resolve: vi.fn(async () => { if (!packageCurrent) throw new ConflictException('MCP assignment changed'); return pkg; }) } as unknown as ChatResearchTools;
        let plannerCalls = 0;
        const runtime = { infer: vi.fn(async () => ({ message: { role: 'assistant', content: JSON.stringify(++plannerCalls === 1
            ? { kind: 'external_search', query: 'user question', objective: 'verify' } : { kind: 'finish' }) }, done_reason: 'stop' })) };
        const executor = new ChatResearchExecutor(repository, runtime, tools, {} as ModelChatProjectContext);
        const list = vi.spyOn(executor.client, 'list').mockImplementation(async () => { metadataDone = true; return []; });
        const call = vi.spyOn(executor.client, 'call').mockResolvedValue({ text: 'Verified external evidence', sources: [{ url: 'https://example.org/docs' }] });
        // These controlled receipts expose executor ordering only; SQL immutability is covered by the existing PostgreSQL suites.
        const steps: ChatResearchStep[] = [];
        vi.spyOn(executor.receipts, 'start').mockImplementation(async (db: ChatDb, input: StartResearchStep) => {
            const step = { ...input, id: randomUUID(), status: 'pending', output: '', sources: [], error: null } as unknown as ChatResearchStep;
            steps.push(step); return step;
        });
        vi.spyOn(executor.receipts, 'finish').mockImplementation(async (db: ChatDb, input: FinishResearchStep) => {
            const step = steps.find(item => item.id === input.id)!;
            Object.assign(step, { status: input.status, output: input.output ?? '', sources: input.sources ?? [], error: input.error ?? null }); return step;
        });
        const scope: ResearchScope = { req: { headers: {} } as Request, owner: 'owner@example.test', row, turn, model, messages: [{ role: 'user', content: 'Question' }],
            settings: { contextWindowTokens: 131072 }, signal: abort.signal, budget: { externalCalls: 0 }, assertCurrent: authorize };
        return { executor, scope, turn, runtime, steps, list, call, gateEntered, gateRelease, abort,
            revokePackage: () => { packageCurrent = false; }, revokeAccess: () => { allowed = false; } };
    };
    it.each(['assignment', 'actor', 'turn'] as const)('does not disclose a query after %s is revoked while final feature admission waits', async change => {
        const f = fixture(true), pending = f.executor.run(f.scope), result = pending.catch(error => error);
        try {
            await f.gateEntered.promise;
            if (change === 'assignment') f.revokePackage(); else if (change === 'actor') f.revokeAccess(); else f.turn.status = 'cancelled';
            f.gateRelease.release(); expect(await result).toMatchObject({ status: change === 'actor' ? 403 : 409 });
            expect(f.call).not.toHaveBeenCalled(); expect(f.runtime.infer).toHaveBeenCalledOnce();
            expect(f.scope.budget.externalCalls).toBe(0);
        } finally { f.gateRelease.release(); await pending.catch(() => undefined); }
    });
    it('retains a received tool receipt after OFF, and does not start another planner call', async () => {
        const f = fixture(); f.call.mockImplementation(async () => { flags.research_tools = false; return { text: 'Paid tool evidence', sources: [] }; });
        await expect(f.executor.run(f.scope)).rejects.toMatchObject({ status: 403 });
        expect(f.steps).toHaveLength(1); expect(f.steps[0]).toMatchObject({ status: 'done', output: 'Paid tool evidence' });
        expect(f.call).toHaveBeenCalledOnce(); expect(f.runtime.infer).toHaveBeenCalledOnce();
    });
    it('does not silently retry an external call with an unknown ACK and records only a safe failure', async () => {
        const f = fixture(); f.call.mockRejectedValue(new Error('PRIVATE provider token and address'));
        await expect(f.executor.run(f.scope)).rejects.toThrow('PRIVATE provider token and address');
        expect(f.call).toHaveBeenCalledOnce(); expect(f.runtime.infer).toHaveBeenCalledOnce();
        expect(f.steps[0]).toMatchObject({ status: 'failed', output: '', sources: [] }); expect(f.steps[0].error).not.toContain('PRIVATE');
    });
    it('stops before tool execution if cancellation arrives during tool metadata discovery', async () => {
        const f = fixture(), entered = deferred(), held = deferred();
        f.list.mockImplementation(async () => { entered.release(); await held.promise; return []; });
        const pending = f.executor.run(f.scope), result = pending.catch(error => error);
        try {
            await entered.promise; f.abort.abort(new Error('cancelled')); held.release();
            expect(await result).toBe(f.abort.signal.reason); expect(f.call).not.toHaveBeenCalled(); expect(f.scope.budget.externalCalls).toBe(0);
        } finally { held.release(); await pending.catch(() => undefined); }
    });
    it('stops before tool execution if its package changes during metadata discovery', async () => {
        const f = fixture(); f.list.mockImplementation(async () => { f.revokePackage(); return []; });
        await expect(f.executor.run(f.scope)).rejects.toMatchObject({ status: 409 }); expect(f.call).not.toHaveBeenCalled();
    });
    it('executes one admitted tool and preserves its source receipt on the normal path', async () => {
        const f = fixture(), result = await f.executor.run(f.scope);
        expect(f.call).toHaveBeenCalledOnce(); expect(f.runtime.infer).toHaveBeenCalledTimes(2); expect(f.steps.map(step => step.status)).toEqual(['done', 'done']);
        expect(result.externalSources).toEqual([{ url: 'https://example.org/docs' }]); expect(f.scope.budget.externalCalls).toBe(1);
    });
});
