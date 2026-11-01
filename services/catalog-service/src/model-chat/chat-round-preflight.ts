import { agentToolContext } from '../agent-tools/agent-tools.validation';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { IModel } from '../models/model.interfaces';
import { chatContext, type IChatContextSettings } from './chat-context';
import type { ChatGroup } from './chat-group';
import type { IChatResponseRow } from './chat-group.interfaces';
import type { IPreparedLearningContext } from './chat-learning-context.interfaces';
import type { ChatRepository } from './chat.repository';
import type { ChatResearchExecutor } from './chat-research';
import type { IChatRoundScope } from './chat-round';
import type { IChatMessage, ITurnRow } from './chat.interfaces';

export interface IPreparedChatRecipient {
    model: IModel;
    settings: IChatContextSettings;
    learning: IPreparedLearningContext;
}
export type TPreparedChatRound = Map<string, IPreparedChatRecipient>;

/** Reject impossible recipients before shared RAG can spend an embedding call; preserve independently viable siblings. */
export async function prepareChatRound(
    req: Request,
    scope: IChatRoundScope,
    turn: ITurnRow,
    signal: AbortSignal,
    groups: ChatGroup,
    repository: ChatRepository,
    settings: (model: IModel) => Promise<IChatContextSettings>,
    research: Pick<ChatResearchExecutor, 'assertFits'>,
): Promise<TPreparedChatRound> {
    const responses = await groups.responses(repository.pool, scope.row.id, [turn.id]),
        prepared: TPreparedChatRound = new Map();
    const fail = async (response: IChatResponseRow, error: unknown) => {
        signal.throwIfAborted();
        if (error instanceof ForbiddenException) throw error;
        await repository.owned(
            scope.owner,
            scope.row.id,
            () => scope.authorize(true),
            async (db, row) => {
                await groups.status(
                    db,
                    row,
                    turn,
                    response,
                    'failed',
                    undefined,
                    error instanceof BadRequestException || error instanceof ConflictException
                        ? error.message
                        : 'Не удалось подготовить контекст агента. Проверьте доступность функций и повторите.',
                );
                await repository.bump(db, row);
            },
        );
    };
    for (const response of responses) {
        if (response.status === 'done') continue;
        try {
            signal.throwIfAborted();
            const model = await groups.assert(req, scope.row, await scope.authorize(true), response.snapshot),
                allocation = await settings(model);
            const learning = await groups.learning.prepare(req, scope.row, response.agent_id, signal);
            const base: IChatMessage[] = [
                { role: 'system', content: response.snapshot.definition.prompt },
                ...(turn.agent_tools_request ? agentToolContext(scope.row.project_id!, turn.agent_tools_request) : []),
                ...learning.messages,
                { role: 'user', content: turn.input_text },
            ];
            if (chatContext(base, allocation).exceeded)
                throw new BadRequestException(
                    'Одобренные знания агента вместе с сообщением не помещаются в окно модели. Выберите модель с большим окном или уменьшите активный контекст знаний.',
                );
            research.assertFits(base, allocation, turn.research_request);
            prepared.set(response.id, { model, settings: allocation, learning });
        } catch (error) {
            await fail(response, error);
        }
    }
    // A later recipient may have taken time to prepare: revalidate every survivor immediately before shared retrieval admission.
    for (const response of responses) {
        const item = prepared.get(response.id);
        if (!item) continue;
        try {
            await item.learning.beforeInference();
        } catch (error) {
            prepared.delete(response.id);
            await fail(response, error);
        }
    }
    return prepared;
}
