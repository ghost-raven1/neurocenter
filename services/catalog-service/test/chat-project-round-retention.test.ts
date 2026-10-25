import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import { executeChatRound } from '../src/model-chat/chat-round';
import { ModelRuntime } from '../src/models/model-runtime';
import { ProjectEmbeddingRepository } from '../src/models/project-embedding.repository';
import type { OllamaClient } from '../src/models/ollama-client';
import type { RemoteConnectionService } from '../src/models/remote-connection.service';
import type { ChatResponseRow } from '../src/model-chat/chat-group.types';
import type { ChatMessage, TurnRow } from '../src/model-chat/chat.types';
import { embeddingModel, projectContextPort } from './helpers/project-context-port';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const noop = async () => undefined;

/** The real round and RAG owners use controlled durable/model ports; successful response commits remain observable. */
async function fixture(searchEnabled = true) {
    const state = { searchEnabled };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(evaluateFeatureFlags({ ...defaultFeatureFlags(), project_search: state.searchEnabled }))));
    const p = projectContextPort(() => ({ infer: async () => { await currentModelUsage().beforeInference?.(); return { embeddings: [[1, 2, 3]] }; } }));
    const project = await p.prepare(), model = { ...embeddingModel, id: 'model-chat', capability: 'chat' as const, dimension: null };
    const row = { id: 'conversation', project_id: p.project.id, owner_email: 'owner@example.test' };
    const turn = { id: 'turn', conversation_id: row.id, request_id: 'request', input_text: 'Question', status: 'pending', removed_at: null,
        lease_until: new Date(Date.now() + 60000) } as TurnRow;
    const responses: ChatResponseRow[] = ['a', 'b'].map(id => ({ id, conversation_id: row.id, turn_id: turn.id, request_id: turn.request_id,
        agent_id: 'agent-' + id, status: 'pending', processing_stage: 'responding', answer: null, error: null,
        snapshot: { agentId: 'agent-' + id, name: id, slug: id, version: 1, manifest: 'e'.repeat(64), definition: { description: '', prompt: 'Persona ' + id, mode: 'all', permission: {} },
            modelId: model.id, modelName: model.name, modelPin: 'f'.repeat(64), sha256: id.repeat(64) } }));
    const db = { query: vi.fn(async () => ({ rows: [{}], rowCount: 1 })) };
    const repository = { pool: db, priorTurn: async () => turn, stage: noop, bump: noop, fail: vi.fn(), finish: vi.fn(),
        owned: async (_owner: string, _id: string, authorize: (db: unknown) => Promise<unknown>, work: (db: unknown, row: unknown) => Promise<unknown>) => {
            await authorize(db); const result = await work(db, row); await authorize(db); return result;
        } };
    const groups = { responses: async () => responses, assert: async () => model, aggregate: (items: ChatResponseRow[]) => items.map(item => item.answer?.content ?? '').join('\n'),
        status: async (_db: unknown, _row: unknown, _turn: unknown, response: ChatResponseRow, status: ChatResponseRow['status'], answer: ChatResponseRow['answer']) => Object.assign(response, { status, answer }) };
    const learning = { messages: [], receipt: { status: 'disabled', projectId: row.project_id, agentId: 'agent', entries: [] }, requiredFeatures: [], beforeInference: noop, assertAuthorized: noop };
    const prepared = new Map(responses.map(response => [response.id, { model, settings: { contextWindowTokens: 131072 }, learning }]));
    const hooks = { prepared, localContextWindow: null, researchBudget: { externalCalls: 0 },
        compact: async (_model: unknown, _overhead: unknown, _check: unknown, _budget: unknown, _id: unknown, before?: () => Promise<void>): Promise<ChatMessage[]> => {
            await before?.(); return [{ role: 'user', content: 'Question' }];
        }, research: { overhead: () => [], run: async (scope: { messages: ChatMessage[]; assertCurrent(): Promise<void> }) => ({ messages: scope.messages,
            projectSources: [], externalSources: [], assertCurrent: scope.assertCurrent }) } };
    const scope = { owner: row.owner_email, actorRole: 'Разработчик', row, model, authorize: async () => model };
    const calls: string[] = []; let provider = async () => ({ message: { role: 'assistant', content: 'Response' }, done_reason: 'stop' });
    const local = { infer: async () => { calls.push(String(currentModelUsage().agentId)); return provider(); } };
    const runtime = new ModelRuntime(local as unknown as OllamaClient, {} as RemoteConnectionService);
    return { p, project, state, turn, responses, calls, hooks, runtime, setProvider(value: typeof provider) { provider = value; },
        start: () => executeChatRound(p.request, scope as never, turn, p.abort.signal, project, groups as never, repository as never, runtime, hooks as never) };
}

describe('Project-search admission and paid agent-round retention', () => {
    it('retains the first paid answer after search turns off and blocks the next sibling dispatch', async () => {
        const f = await fixture(); let started!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
        f.setProvider(async () => { started(); await held; return { message: { role: 'assistant', content: 'PAID ANSWER' }, done_reason: 'stop' }; });
        const work = f.start().catch(error => error);
        try { await waiting; f.state.searchEnabled = false; release(); expect(await work).toMatchObject({ status: 403 }); }
        finally { release(); await work; }
        expect(f.calls).toEqual(['agent-a']); expect(f.responses[0]).toMatchObject({ status: 'done', answer: { content: 'PAID ANSWER' } });
        expect(f.responses[1]).toMatchObject({ status: 'pending', answer: null });
    });
    it('blocks a new dispatch when search is revoked while the compaction boundary waits', async () => {
        const f = await fixture();
        f.hooks.compact = async (_model, _overhead, _check, _budget, _id, before) => { f.state.searchEnabled = false; await before?.(); return []; };
        await expect(f.start()).rejects.toMatchObject({ status: 403 }); expect(f.calls).toEqual([]);
        expect(f.responses.every(response => response.answer === null)).toBe(true);
    });
    it('rechecks search-off after the real runtime admission waits for unchanged index identity', async () => {
        const f = await fixture(); let started!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
        const infer = f.runtime.infer.bind(f.runtime);
        vi.spyOn(f.runtime, 'infer').mockImplementationOnce((...args) => {
            vi.mocked(ProjectEmbeddingRepository.prototype.read).mockImplementationOnce(async () => { started(); await held; return f.p.selected; });
            return infer(...args);
        });
        const work = f.start().catch(error => error);
        try { await waiting; f.state.searchEnabled = false; release(); expect(await work).toMatchObject({ status: 403 }); }
        finally { release(); await work; }
        expect(f.calls).toEqual([]); expect(f.responses.every(response => response.answer === null)).toBe(true);
    });
    it('gates explicit project research even when automatic context was prepared with search disabled', async () => {
        const f = await fixture(false); f.turn.research_request = { project: true }; f.state.searchEnabled = true;
        expect(f.project.requiredFeatures).toEqual([]);
        let started!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
        const infer = f.runtime.infer.bind(f.runtime);
        vi.spyOn(f.runtime, 'infer').mockImplementationOnce((...args) => {
            f.p.models.resolveProject.mockImplementationOnce(async () => { started(); await held; return { ...f.p.project }; });
            return infer(...args);
        });
        const work = f.start().catch(error => error);
        try { await waiting; f.state.searchEnabled = false; release(); expect(await work).toMatchObject({ status: 403 }); }
        finally { release(); await work; }
        expect(f.calls).toEqual([]); expect(f.responses.every(response => response.answer === null)).toBe(true);
    });
    it('still discards a paid response whose index snapshot changed during the provider wait', async () => {
        const f = await fixture(); let started!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
        f.setProvider(async () => { started(); await held; return { message: { role: 'assistant', content: 'STALE ANSWER' }, done_reason: 'stop' }; });
        const work = f.start().catch(error => error);
        try { await waiting; f.p.selected.activeSnapshot = 'c'.repeat(64); release(); expect(await work).toMatchObject({ status: 409 }); }
        finally { release(); await work; }
        expect(f.calls).toEqual(['agent-a']); expect(f.responses.every(response => response.answer === null)).toBe(true);
    });
});
