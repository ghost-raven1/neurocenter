import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IModel } from '../models/model.types';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { chatHash } from './chat-validation';
import { unknownGroupUsage, type ChatAgentSnapshot, type ChatResolvedAgent, type ChatAgentResponse } from './chat-group.types';
import { ChatRepository, type ChatDb } from './chat.repository';
import type { ChatMessage, TurnRow } from './chat.types';
import { DISCUSSION_LIMITS, type DiscussionPhase, type DiscussionRun, type DiscussionStep } from './chat-discussion.types';

/** A paid step is journaled once before dispatch. Reopening an uncertain step never authorizes a replay. */
export class ChatDiscussionRepository {
    constructor(private readonly chats: ChatRepository) {}
    async create(db: ChatDb, turn: TurnRow, actorRole: string, model: IModel, roster: ChatResolvedAgent[]): Promise<void> {
        const deadline = new Date(Date.now() + DISCUSSION_LIMITS.deadlineMs);
        await db.query(`INSERT INTO model_chat_discussions(turn_id,request_id,actor_role,model,roster,deadline_at)
            VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)`, [turn.id, turn.request_id, actorRole, JSON.stringify(model), JSON.stringify(roster), deadline]);
        await db.query("UPDATE model_chat_turns SET lease_until=$2 WHERE id=$1 AND status='pending'", [turn.id, deadline]);
    }
    async get(db: ChatDb, turnId: string): Promise<DiscussionRun | undefined> {
        return (await db.query<DiscussionRun>('SELECT * FROM model_chat_discussions WHERE turn_id=$1', [turnId])).rows[0];
    }
    async runs(db: ChatDb, conversation: string, turnIds: string[]): Promise<DiscussionRun[]> {
        return (await db.query<DiscussionRun>(`SELECT run.* FROM model_chat_discussions run JOIN model_chat_turns turn ON turn.id=run.turn_id
            WHERE turn.conversation_id=$1 AND run.turn_id=ANY($2::uuid[])`, [conversation, turnIds])).rows;
    }
    async steps(db: ChatDb, conversation: string, turnIds: string[]): Promise<DiscussionStep[]> {
        return (await db.query<DiscussionStep>(`SELECT step.*,CASE WHEN step.status='pending' AND EXISTS(SELECT 1 FROM model_usage_calls call
            WHERE call.turn_id=step.turn_id AND call.operation_id=step.id AND call.status='pending' AND call.dispatch_count>0
            AND call.provider_latency_ms IS NULL AND call.lease_until>now()) THEN 'running' ELSE 'waiting' END AS execution_state
            FROM model_chat_discussion_steps step JOIN model_chat_turns turn ON turn.id=step.turn_id
            WHERE turn.conversation_id=$1 AND step.turn_id=ANY($2::uuid[]) ORDER BY turn.position,step.sequence`, [conversation, turnIds])).rows;
    }
    private async pending(db: ChatDb, turn: TurnRow): Promise<void> {
        if (!(await db.query(`SELECT 1 FROM model_chat_turns WHERE id=$1 AND conversation_id=$2 AND request_id=$3
            AND status='pending' AND removed_at IS NULL AND lease_until>now()`, [turn.id, turn.conversation_id, turn.request_id])).rowCount) throw new ConflictException('Обсуждение уже остановлено или завершено.');
    }
    async begin(owner: string, conversation: string, turn: TurnRow, phase: DiscussionPhase, key: string, model: IModel,
        snapshot: ChatAgentSnapshot | null, messages: ChatMessage[], authorize: (db?: ChatDb) => Promise<unknown>): Promise<DiscussionStep> {
        return this.chats.owned(owner, conversation, authorize, async db => {
            await this.pending(db, turn);
            const run = await this.get(db, turn.id);
            if (!run || run.request_id !== turn.request_id || new Date(run.deadline_at).getTime() <= Date.now()) throw new ConflictException('Срок или владелец обсуждения изменился.');
            const previous = (await db.query<DiscussionStep>('SELECT * FROM model_chat_discussion_steps WHERE turn_id=$1 AND step_key=$2', [turn.id, key])).rows[0];
            if (previous) throw new ConflictException('Этот шаг уже принят. Неизвестный исход не запускается повторно.');
            // Every non-final paid operation leaves one slot for synthesis, including RAG embedding.
            const maximum = phase === 'synthesis' ? DISCUSSION_LIMITS.calls : DISCUSSION_LIMITS.calls - 1;
            const reserved = (await db.query<{ calls_started: number }>(`UPDATE model_chat_discussions SET calls_started=calls_started+1
                WHERE turn_id=$1 AND request_id=$2 AND calls_started<$3 RETURNING calls_started`, [turn.id, turn.request_id, maximum])).rows[0];
            if (!reserved) throw new ConflictException('Достигнут бюджет обсуждения. Сохранённые ответы не теряются.');
            return (await db.query<DiscussionStep>(`INSERT INTO model_chat_discussion_steps(id,turn_id,request_id,sequence,step_key,phase,model_id,model_pin,snapshot,input_hash)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`, [randomUUID(), turn.id, turn.request_id, reserved.calls_started, key, phase,
                model.id, projectEmbeddingPin(model), snapshot ? JSON.stringify(snapshot) : null, chatHash(messages)])).rows[0];
        });
    }
    async current(db: ChatDb, turn: TurnRow, step: DiscussionStep): Promise<void> {
        await this.pending(db, turn);
        if (!(await db.query(`SELECT 1 FROM model_chat_discussion_steps WHERE id=$1 AND turn_id=$2 AND request_id=$3 AND status='pending'`, [step.id, turn.id, turn.request_id])).rowCount) throw new ConflictException('Шаг обсуждения уже остановлен или завершён.');
    }
    async finish(owner: string, conversation: string, turn: TurnRow, step: DiscussionStep, status: 'done' | 'failed', output: string | null, finishReason: 'stop' | 'length' | null,
        authorize: (db?: ChatDb) => Promise<unknown>): Promise<void> {
        await this.chats.owned(owner, conversation, authorize, async (db, row) => {
            await this.current(db, turn, step);
            const updated = await db.query(`UPDATE model_chat_discussion_steps SET status=$2,output=$3,error=$4,finish_reason=$5,finished_at=now()
                WHERE id=$1 AND status='pending'`, [step.id, status, output, status === 'failed' ? 'Ответ шага недоступен. Готовые ответы сохранены; автоматического повтора нет.' : null, finishReason]);
            if (!updated.rowCount) throw new ConflictException('Ответ шага уже сохранён или остановлен.');
            await this.chats.bump(db, row);
        });
    }
    /** Safe terminal metadata may be written after revocation; it can never publish model content. */
    async cancel(db: ChatDb, turnIds: string[], message: string): Promise<void> {
        await db.query(`UPDATE model_chat_discussion_steps SET status='cancelled',error=$2,finished_at=now()
            WHERE turn_id=ANY($1::uuid[]) AND status='pending'`, [turnIds, message]);
    }
}

/** Existing chat clients can render contributions and the server-owned final summary without a new action API. */
export function discussionResponses(turn: TurnRow, run: DiscussionRun, steps: DiscussionStep[]): ChatAgentResponse[] {
    const responses: ChatAgentResponse[] = steps.filter(step => step.snapshot && ['response', 'critique'].includes(step.phase)).map(step => ({
        id: step.id, agentId: step.snapshot!.agentId, name: step.snapshot!.name + (step.phase === 'critique' ? ' · проверка возражений' : ''),
        slug: step.snapshot!.slug, version: step.snapshot!.version, modelId: step.model_id, modelName: step.snapshot!.modelName, modelPin: step.model_pin,
        status: step.status, executionState: step.status === 'pending' && turn.status === 'pending' ? step.execution_state ?? 'waiting' : null,
        processingStage: 'responding', ...(step.output ? { answer: { content: step.output, finishReason: step.finish_reason!, usage: unknownGroupUsage() } } : {}),
        ...(step.error ? { error: step.error } : {}),
    }));
    if (turn.answer) responses.push({ id: turn.id, agentId: 'discussion-summary', name: 'Итог обсуждения', slug: 'discussion-summary', version: 1,
        modelId: run.model.id, modelName: run.model.name, modelPin: projectEmbeddingPin(run.model), status: 'done', processingStage: 'responding', answer: turn.answer });
    return responses;
}
