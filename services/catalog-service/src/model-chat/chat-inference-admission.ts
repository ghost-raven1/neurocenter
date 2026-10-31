import { ConflictException } from '@nestjs/common';
import type { ChatRepository } from './chat.repository';
import type { TurnRow } from './chat.types';

/** A rate waiter may outlive a cancelled/retried lease; only its exact pending generation can dispatch. */
export async function assertPendingChatInference(
    repository: ChatRepository,
    conversationId: string,
    turn: TurnRow,
    signal: AbortSignal,
    responseId?: string,
): Promise<void> {
    signal.throwIfAborted();
    const pending = await repository.priorTurn(repository.pool, conversationId, turn.request_id);
    if (
        !pending ||
        pending.id !== turn.id ||
        pending.status !== 'pending' ||
        pending.removed_at ||
        pending.request_id !== turn.request_id ||
        !pending.lease_until ||
        new Date(pending.lease_until).getTime() <= Date.now()
    )
        throw new ConflictException('Запрос уже остановлен или завершён.');
    if (
        responseId &&
        !(
            await repository.pool.query(
                "SELECT 1 FROM model_chat_agent_responses WHERE id=$1 AND turn_id=$2 AND request_id=$3 AND status='pending'",
                [responseId, turn.id, turn.request_id],
            )
        ).rowCount
    )
        throw new ConflictException('Ответ агента уже остановлен или завершён.');
    signal.throwIfAborted();
}
