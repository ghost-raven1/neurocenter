import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { chatContext } from '../src/model-chat/chat-context';
import { ChatResearchExecutor } from '../src/model-chat/chat-research';
import type { ChatRepository } from '../src/model-chat/chat.repository';
import type { ChatResearchTools } from '../src/model-chat/chat-research-tools';
import type { ModelChatProjectContext } from '../src/model-chat/chat-project-context';
import type { ChatMessage, ConversationRow, TurnRow } from '../src/model-chat/chat.types';
import type { IModel } from '../src/models/model.types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Research planner admission and actual output budget', () => {
    it.each([64, 1024])('uses the smaller of the configured %i tokens and its internal 512-token cap', async configured => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'research-budget-unit-only');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(defaultFeatureFlags())))));
        const row = { id: randomUUID(), project_id: 'prj-budget', mode: 'model' } as ConversationRow;
        const turn = { id: randomUUID(), request_id: randomUUID(), status: 'pending', research_request: { project: true },
            lease_until: new Date(Date.now() + 60000) } as TurnRow;
        const queryDb = { query: vi.fn() };
        // Only persistence is doubled: the real executor builds, admits and dispatches the planner request.
        const repository = { pool: queryDb, priorTurn: vi.fn(async () => turn), stage: vi.fn(), bump: vi.fn(),
            owned: async (_owner: string, _id: string, authorize: (db: typeof queryDb) => Promise<void>, action: (db: typeof queryDb, row: ConversationRow) => Promise<unknown>) => {
                await authorize(queryDb); return action(queryDb, row);
            } } as unknown as ChatRepository;
        const runtime = { infer: vi.fn(async (_model: IModel, _endpoint: string, _body: Record<string, unknown>) => ({
            message: { role: 'assistant', content: '{"kind":"finish"}' }, done_reason: 'stop' })) };
        const executor = new ChatResearchExecutor(repository, runtime, {} as ChatResearchTools, {} as ModelChatProjectContext);
        vi.spyOn(executor.receipts, 'start').mockImplementation(async (_db, input) => ({ ...input, id: randomUUID(), status: 'pending' }) as never);
        vi.spyOn(executor.receipts, 'finish').mockImplementation(async (_db, input) => input as never);
        const messages: ChatMessage[] = [{ role: 'user', content: 'Проверь факт.' }], expected = Math.min(configured, 512);
        const estimate = chatContext([...executor.overhead(turn.research_request), ...messages]).estimatedInputTokens;
        const settings = { contextWindowTokens: estimate + Math.max(configured, expected), reservedOutputTokens: configured };
        expect(() => executor.assertFits(messages, settings, turn.research_request)).not.toThrow();
        await executor.run({ req: {} as Request, owner: 'owner@localhost', row, turn, model: { id: 'model-budget' } as IModel,
            messages, settings, signal: new AbortController().signal, budget: { externalCalls: 0 }, assertCurrent: async () => undefined });
        expect(runtime.infer).toHaveBeenCalledOnce();
        const body = runtime.infer.mock.calls[0][2];
        expect(body.options).toEqual({ num_predict: expected });
        expect(chatContext(body.messages as ChatMessage[], { ...settings, reservedOutputTokens: expected }).exceeded).toBe(false);
    });
});
