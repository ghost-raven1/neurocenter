import { ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { IModel } from '../models/model.types';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { chatChanged } from '../model-chat/chat-validation';
import { assertPendingChatInference } from '../model-chat/chat-inference-admission';
import type { ChatDb, ChatRepository } from '../model-chat/chat.repository';
import type { ChatMessage, ConversationRow, TurnRow } from '../model-chat/chat.types';
import type { PreparedProjectContext } from '../model-chat/chat-project-context.types';
import type { IChatContextSettings } from '../model-chat/chat-context';
import type { AgentToolsService } from './agent-tools.service';

/** The existing personal chat remains the authority for identity, lease and final answer ownership. */
export async function runModelChatAgentTools(
    tools: AgentToolsService | undefined,
    repository: ChatRepository,
    req: Request,
    scope: { owner: string; actorRole: string; row: ConversationRow; authorize(pin?: boolean): Promise<IModel> },
    turn: TurnRow,
    model: IModel,
    messages: ChatMessage[],
    settings: IChatContextSettings,
    signal: AbortSignal,
    project: PreparedProjectContext,
) {
    if (!tools) throw new ServiceUnavailableException('Инструменты агентов недоступны.');
    const assertCurrent = async (db?: ChatDb) => {
        await scope.authorize(true);
        await assertPendingChatInference(repository, scope.row.id, turn, signal);
        await project.assertCurrent();
        if (db) {
            const current = await repository.priorTurn(db, scope.row.id, turn.request_id);
            if (!current || current.status !== 'pending' || current.removed_at) throw chatChanged();
        }
    };
    const result = await tools.run(
        req,
        {
            owner: {
                kind: 'model-chat',
                originId: scope.row.id,
                turnId: turn.id,
                recipientId: turn.id,
                generation: turn.request_id,
                ownerEmail: scope.owner,
                actorRole: scope.actorRole,
                projectId: scope.row.project_id!,
                agentId: null,
                modelId: model.id,
                modelPin: projectEmbeddingPin(model),
                grant: turn.agent_tools_request!,
            },
            messages,
            settings,
            signal,
            assertCurrent,
            assertAuthorized: async () => {
                signal.throwIfAborted();
                await scope.authorize(true);
                await project.assertCurrent();
            },
        },
        project,
        turn.input_text,
    );
    return { ...result, projectSources: [], externalSources: [], limitReached: false };
}
