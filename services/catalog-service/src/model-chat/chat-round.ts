import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { requireFeatureEnabled } from '../features/require-feature-enabled';
import { withModelUsage } from '../model-usage/model-usage.context';
import { modelInferenceBody } from '../models/inference.controller';
import type { IModel } from '../models/model.types';
import type { IModelInferenceRuntime } from '../models/model-runtime';
import { chatContext, chatUsage } from './chat-context';
import type { ChatGroup } from './chat-group';
import { unknownGroupUsage, type ChatRoundBudget } from './chat-group.types';
import type { ChatDb, ChatRepository } from './chat.repository';
import type { ChatMessage, ConversationRow, TurnRow } from './chat.types';
import type { ChatResearchExecutor, ResearchRoundBudget } from './chat-research';
import { researchEvidence } from './chat-research-evidence';
import type { PreparedProjectContext } from './chat-project-context.types';
import type { PreparedChatRound } from './chat-round-preflight';
import { assertPendingChatInference } from './chat-inference-admission';

export interface ChatRoundScope { owner: string; row: ConversationRow; model: IModel; authorize(pin?: boolean): Promise<IModel> }
export interface ChatRoundHooks {
    compact(model: IModel, overhead: ChatMessage[], assertCurrent: (db?: ChatDb) => Promise<void>, budget: ChatRoundBudget, responseId: string, beforeInference?: () => Promise<void>): Promise<ChatMessage[]>;
    localContextWindow: number | null;
    research: ChatResearchExecutor; researchBudget: ResearchRoundBudget;
    prepared: PreparedChatRound;
}

/** Each explicitly addressed participant runs once; successful siblings survive retry, cancellation and failures. */
export async function executeChatRound(req: Request, scope: ChatRoundScope, turn: TurnRow, signal: AbortSignal, project: PreparedProjectContext,
    groups: ChatGroup, repository: ChatRepository, runtime: IModelInferenceRuntime, hooks: ChatRoundHooks): Promise<void> {
    const responses = await groups.responses(repository.pool, scope.row.id, [turn.id]), budget = { summaries: 0 };
    for (const response of responses) {
        if (response.status === 'done') continue;
        const prepared = hooks.prepared.get(response.id); if (!prepared) continue;
        signal.throwIfAborted(); await scope.authorize(true); await project.assertCurrent();
        try {
            const model = await groups.assert(req, scope.row, await scope.authorize(true), response.snapshot), settings = prepared.settings;
            const persona: ChatMessage[] = [{ role: 'system', content: response.snapshot.definition.prompt }];
            const learning = prepared.learning, base = [...persona, ...learning.messages];
            const minimal = project.fit([...base, { role: 'user', content: turn.input_text }], settings);
            const overhead = [...minimal.messages.slice(0, minimal.messages.length - base.length - 1), ...base, ...hooks.research.overhead(turn.research_request)];
            const assertCurrent = async (db?: ChatDb) => { signal.throwIfAborted(); await scope.authorize(true); await groups.assert(req, scope.row, scope.model, response.snapshot, db); await project.assertCurrent(); await learning.assertAuthorized(db); };
            const attribution = { purpose: 'agent' as const, actorEmail: scope.owner, projectId: scope.row.project_id, turnId: turn.id, agentId: response.agent_id, operationId: turn.request_id };
            const history = await withModelUsage({ ...attribution, requiredFeatures: learning.requiredFeatures }, () => hooks.compact(model, overhead, assertCurrent, budget, response.id, learning.beforeInference));
            const fitted = project.fit([...base, ...history], settings);
            const definition = response.snapshot.definition, options = {
                ...(definition.temperature === undefined ? {} : { temperature: definition.temperature }), ...(definition.topP === undefined ? {} : { top_p: definition.topP }),
                ...(model.runtime === 'ollama' && hooks.localContextWindow !== null ? { num_ctx: hooks.localContextWindow } : {}) };
            const researched = await hooks.research.run({ req, owner: scope.owner, row: scope.row, turn, responseId: response.id, agentId: response.agent_id,
                model, messages: [...persona, ...fitted.messages.slice(0, fitted.messages.length - base.length - history.length), ...learning.messages, ...history], initialProjectSources: fitted.evidence.sources, settings, signal,
                options, budget: hooks.researchBudget, assertCurrent, beforeInference: learning.beforeInference, requiredFeatures: learning.requiredFeatures });
            const messages = researched.messages;
            await repository.owned(scope.owner, scope.row.id, researched.assertCurrent, async (db, row) => {
                await repository.stage(db, row, turn, 'responding');
                await db.query("UPDATE model_chat_agent_responses SET processing_stage='responding' WHERE id=$1 AND request_id=$2 AND status='pending'", [response.id, turn.request_id]);
            });
            if (chatContext(messages, settings).exceeded) throw new BadRequestException('Сообщение и контекст проекта не помещаются в окно модели этого агента.');
            await requireFeatureEnabled('model_hosting'); if (turn.research_request) await requireFeatureEnabled('research_tools'); await researched.assertCurrent(); await learning.beforeInference();
            const result = await withModelUsage({ ...attribution, beforeInference: async () => {
                await researched.assertCurrent(); await learning.beforeInference(); await assertPendingChatInference(repository, scope.row.id, turn, signal, response.id);
            }, requiredFeatures: [...learning.requiredFeatures, ...(turn.research_request ? ['research_tools' as const] : [])] }, () => runtime.infer(model, 'chat', modelInferenceBody('chat', { messages, stream: false, options }), signal));
            signal.throwIfAborted(); await researched.assertCurrent();
            const message = result.message as Record<string, unknown> | undefined;
            if (!message || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()
                || Buffer.byteLength(JSON.stringify(message.content)) > 8 * 1024 ** 2 || !['stop', 'length'].includes(String(result.done_reason))) throw new BadRequestException('Агент не вернул допустимый ответ. Уже полученные ответы сохранены.');
            const answer = { content: message.content, finishReason: result.done_reason as 'stop' | 'length', usage: chatUsage(result), evidence: researchEvidence(fitted.evidence, researched.projectSources), learning: learning.receipt, ...(researched.externalSources.length ? { researchSources: researched.externalSources } : {}), ...(researched.limitReached ? { researchLimited: true } : {}) };
            await repository.owned(scope.owner, scope.row.id, researched.assertCurrent, async (db, row) => {
                signal.throwIfAborted(); const siblings = await groups.responses(db, row.id, [turn.id]);
                const next = siblings.map(item => item.id === response.id ? { ...item, status: 'done' as const, answer } : item);
                if (Buffer.byteLength(JSON.stringify(groups.aggregate(next))) > 8 * 1024 ** 2) throw new BadRequestException('Общий размер ответов раунда превышает 8 МиБ. Уже полученные ответы сохранены.');
                await groups.status(db, row, turn, response, 'done', answer); await repository.bump(db, row);
            });
        } catch (error) {
            signal.throwIfAborted(); await scope.authorize(true); await project.assertCurrent();
            if (error instanceof ForbiddenException) throw error;
            await repository.owned(scope.owner, scope.row.id, () => scope.authorize(true), async (db, row) => {
                await groups.status(db, row, turn, response, 'failed', undefined,
                    error instanceof BadRequestException || error instanceof ConflictException ? error.message : 'Агент не выполнил запрос. Проверьте модель и повторите.');
                await repository.bump(db, row);
            });
        }
    }
    await finishChatRound(scope, turn, signal, groups, repository, project.assertCurrent);
}

/** A preflight with no viable recipients still finalizes safely without starting retrieval or discarding completed siblings. */
export async function finishChatRound(scope: ChatRoundScope, turn: TurnRow, signal: AbortSignal, groups: ChatGroup, repository: ChatRepository,
    assertCurrent: () => Promise<void> = async () => undefined): Promise<void> {
    signal.throwIfAborted(); await assertCurrent(); await scope.authorize(true);
    const final = await groups.responses(repository.pool, scope.row.id, [turn.id]);
    if (!final.every(response => response.status === 'done')) { await repository.fail(scope.row.id, turn.id, turn.request_id, 'failed', 'Не все агенты ответили. Повторите запрос или продолжите с готовыми ответами.'); return; }
    await repository.owned(scope.owner, scope.row.id, async () => { await scope.authorize(true); await assertCurrent(); }, async (db, row) => {
        signal.throwIfAborted(); await repository.finish(db, row, turn, { content: groups.aggregate(final), finishReason: 'stop', usage: unknownGroupUsage() });
    });
}
