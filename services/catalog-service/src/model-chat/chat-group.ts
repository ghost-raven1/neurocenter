import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { ProjectAgentRepository } from '../agents/project-agent.repository';
import { ModelsService } from '../models/models.service';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import type { IModel } from '../models/model.types';
import type { ChatDb } from './chat.repository';
import type { ConversationRow, TurnRow, ChatTurn } from './chat.types';
import { chatHash } from './chat-validation';
import type { ChatAgentSnapshot, ChatParticipant, ChatResolvedAgent, ChatResponseRow } from './chat-group.types';
import { LearningRepository } from '../learning/learning.repository';
import { ModelChatLearningContext } from './chat-learning-context';
import { resolveAgentChatModel } from '../models/resolve-agent-chat-model';

/** Stable IDs are mandatory; display names and OpenCode provider strings never select an ambiguous model. */
export function chatAgentIds(raw: unknown, allowEmpty = false): string[] {
    if (
        !Array.isArray(raw) ||
        raw.length > 8 ||
        (!allowEmpty && !raw.length) ||
        raw.some((id) => typeof id !== 'string' || !/^agent-[a-z0-9][a-z0-9-]{0,120}$/.test(id)) ||
        new Set(raw).size !== raw.length
    )
        throw new BadRequestException('Выберите до восьми разных проектных агентов.');
    return [...raw];
}
export class ChatGroup {
    readonly learning: ModelChatLearningContext;
    constructor(
        private readonly models: ModelsService,
        private readonly agents: ProjectAgentRepository,
    ) {
        this.learning = new ModelChatLearningContext(models, new LearningRepository(agents.pool));
    }
    async roster(
        req: Request,
        projectId: string,
        fallback: IModel,
        db: ChatDb = this.agents.pool,
    ): Promise<{ items: ChatParticipant[]; resolved: ChatResolvedAgent[] }> {
        await this.models.resolveProject(req, projectId, 2);
        const assignments = await this.agents.assignments(projectId, db),
            catalog = await this.models.list(req, projectId),
            items: ChatParticipant[] = [],
            resolved: ChatResolvedAgent[] = [];
        for (const assignment of assignments) {
            const item: ChatParticipant = {
                agentId: assignment.agentId,
                name: assignment.card.name,
                slug: assignment.card.slug,
                status: assignment.removed ? 'removed' : assignment.enabled ? 'active' : 'disabled',
            };
            if (item.status !== 'active') {
                item.reason = assignment.removed ? 'Агент удалён из проекта.' : 'Агент выключен в настройках проекта.';
                items.push(item);
                continue;
            }
            try {
                const model = await resolveAgentChatModel(
                    this.models,
                    req,
                    projectId,
                    assignment.effective.model,
                    fallback,
                    catalog,
                    db,
                );
                const body = {
                    agentId: item.agentId,
                    name: item.name,
                    slug: item.slug,
                    version: assignment.version,
                    manifest: assignment.manifest,
                    definition: assignment.effective,
                    modelId: model.id,
                    modelName: model.name,
                    modelPin: projectEmbeddingPin(model),
                };
                resolved.push({ snapshot: { ...body, sha256: chatHash(body) }, model });
                item.modelId = model.id;
                item.modelName = model.name;
            } catch (error) {
                item.status = 'blocked';
                item.reason =
                    error instanceof ConflictException ? error.message : 'Модель агента больше недоступна в проекте.';
            }
            items.push(item);
        }
        return { items, resolved };
    }
    async selected(req: Request, row: ConversationRow, fallback: IModel, db?: ChatDb): Promise<ChatParticipant[]> {
        if (row.mode !== 'group') return [];
        const roster = await this.roster(req, row.project_id!, fallback, db);
        return row.agent_ids.map(
            (id) =>
                roster.items.find((item) => item.agentId === id) ?? {
                    agentId: id,
                    name: id,
                    slug: id,
                    status: 'removed',
                    reason: 'Агент больше не добавлен в проект.',
                },
        );
    }
    async plan(
        req: Request,
        row: ConversationRow,
        fallback: IModel,
        targets?: string[],
        db?: ChatDb,
    ): Promise<ChatResolvedAgent[]> {
        const ids = targets?.length ? targets : row.agent_ids;
        if (!ids.length || ids.some((id) => !row.agent_ids.includes(id)))
            throw new BadRequestException('Адресаты должны входить в состав этого чата.');
        const roster = await this.roster(req, row.project_id!, fallback, db);
        return ids.map((id) => {
            const selected = roster.resolved.find((item) => item.snapshot.agentId === id);
            if (!selected)
                throw new ConflictException(
                    roster.items.find((item) => item.agentId === id)?.reason ?? 'Агент больше недоступен в проекте.',
                );
            return selected;
        });
    }
    async assert(
        req: Request,
        row: ConversationRow,
        fallback: IModel,
        snapshot: ChatAgentSnapshot,
        db?: ChatDb,
    ): Promise<IModel> {
        const plan = await this.plan(req, row, fallback, [snapshot.agentId], db);
        if (plan[0].snapshot.sha256 !== snapshot.sha256)
            throw new ConflictException(
                'Настройки, промпт или модель агента изменились. Этот ответ сохранён как прерванный.',
            );
        return plan[0].model;
    }
    async add(db: ChatDb, row: ConversationRow, turn: TurnRow, plan: ChatResolvedAgent[]): Promise<void> {
        for (const agent of plan)
            await db.query(
                `INSERT INTO model_chat_agent_responses(id,conversation_id,turn_id,agent_id,snapshot,request_id,status)
            VALUES($1,$2,$3,$4,$5::jsonb,$6,'pending')`,
                [
                    randomUUID(),
                    row.id,
                    turn.id,
                    agent.snapshot.agentId,
                    JSON.stringify(agent.snapshot),
                    turn.request_id,
                ],
            );
    }
    async responses(db: ChatDb, conversation: string, turnIds: string[]): Promise<ChatResponseRow[]> {
        return (
            await db.query<ChatResponseRow>(
                'SELECT r.* FROM model_chat_agent_responses r JOIN model_chat_turns t ON t.id=r.turn_id WHERE r.conversation_id=$1 AND r.turn_id=ANY($2::uuid[]) ORDER BY t.position,array_position(t.target_agent_ids,r.agent_id),r.id',
                [conversation, turnIds],
            )
        ).rows;
    }
    async retry(db: ChatDb, conversation: string, turn: TurnRow): Promise<void> {
        await db.query(
            "UPDATE model_chat_agent_responses SET status='pending',error=NULL,request_id=$3,updated_at=now() WHERE conversation_id=$1 AND turn_id=$2 AND status<>'done'",
            [conversation, turn.id, turn.request_id],
        );
    }
    async status(
        db: ChatDb,
        row: ConversationRow,
        turn: TurnRow,
        response: ChatResponseRow,
        status: ChatResponseRow['status'],
        answer?: ChatTurn['answer'],
        error?: string,
    ): Promise<void> {
        const changed = await db.query(
            `UPDATE model_chat_agent_responses r SET status=$5,answer=$6::jsonb,error=$7,updated_at=now() WHERE conversation_id=$1 AND turn_id=$2 AND id=$3 AND request_id=$4 AND status='pending'
            AND EXISTS(SELECT 1 FROM model_chat_turns t WHERE t.id=r.turn_id AND t.status='pending' AND t.request_id=$4 AND t.lease_until>now() AND t.removed_at IS NULL)`,
            [
                row.id,
                turn.id,
                response.id,
                turn.request_id,
                status,
                answer ? JSON.stringify(answer) : null,
                error ?? null,
            ],
        );
        if (!changed.rowCount) throw new ConflictException('Раунд уже остановлен или завершён.');
    }
    /** Historical model attribution is part of the compaction source, not a new system instruction. */
    aggregate(responses: ChatResponseRow[]): string {
        return responses
            .map(
                (response) =>
                    `[Ответ агента ${response.snapshot.name} (@${response.snapshot.slug}); модель ${response.snapshot.modelName}; pin ${response.snapshot.modelPin}]\n` +
                    (response.status === 'done' ? response.answer!.content : `[Ответ не получен: ${response.status}]`),
            )
            .join('\n\n');
    }
    async partial(db: ChatDb, row: ConversationRow, turn: TurnRow): Promise<ChatResponseRow[]> {
        const responses = await this.responses(db, row.id, [turn.id]);
        if (!responses.length) throw new NotFoundException('Раунд агентов не найден.');
        return responses;
    }
}
