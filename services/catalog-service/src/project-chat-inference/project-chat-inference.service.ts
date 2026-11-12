import { AgentToolsService } from '../agent-tools/agent-tools.service';
import { agentToolContext } from '../agent-tools/agent-tools.validation';
import { ModelChatProjectContext } from '../model-chat/chat-project-context';
import type { IPreparedProjectContext } from '../model-chat/chat-project-context.interfaces';
import { modelPlanningOptions } from '../models/model-planning-options';
import { automaticModelOptions } from '../models/model-runtime-options';
import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import type { Request } from 'express';
import { projectLevel } from '../access/access.model';
import { isDeepStrictEqual } from 'node:util';
import { ProjectAgentRepository } from '../agents/project-agent.repository';
import { ChatGroup } from '../model-chat/chat-group';
import type { IChatAgentSnapshot, IChatParticipant } from '../model-chat/chat-group.interfaces';
import {
    chatContext,
    chatUsage,
    managedChatContextWindow,
    type IChatContextSettings,
} from '../model-chat/chat-context';
import type { IConversationRow } from '../model-chat/chat.interfaces';
import { withModelUsage } from '../model-usage/model-usage.context';
import { ModelsService } from '../models/models.service';
import { ModelRuntime } from '../models/model-runtime';
import { modelInferenceBody } from '../models/inference.controller';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import type { IModel } from '../models/model.interfaces';
import { assertProjectChatRoomAccess } from '../project-chat/project-chat-room-access';
import { DEFAULT_PROJECT_CHAT_ROOM } from '../project-chat/project-chat.constants';
import type {
    TProjectChatDb,
    IProjectChatInference,
    IProjectChatMessageRow,
    IProjectChatRoomRow,
    TProjectChatTransport,
} from '../project-chat/project-chat.interfaces';
import { projectChatContext } from './project-chat-context';
import { projectChatModels } from './project-chat-models';
import { projectChatSequentialContext, type IProjectChatSequentialAnswer } from './project-chat-sequential';
import {
    projectChatRoomsContext,
    projectChatSharedContext,
    type IProjectChatAddressableRoom,
    type IProjectChatSharedItem,
} from './project-chat-shared-context';

/** Reuses effective project agents and the existing model dispatcher, without reading private chat history. */
@Injectable()
export class ProjectChatInferenceService implements IProjectChatInference {
    private readonly assignments: ProjectAgentRepository;
    private readonly groups: ChatGroup;
    private readonly localContextWindow = managedChatContextWindow();
    constructor(
        private readonly models: ModelsService,
        private readonly runtime: ModelRuntime,
        @Optional() private readonly agentTools?: AgentToolsService,
    ) {
        this.assignments = new ProjectAgentRepository(models.pool);
        this.groups = new ChatGroup(projectChatModels(models, models.pool), this.assignments);
    }
    async roster(
        req: Request,
        projectId: string,
        room: IProjectChatRoomRow,
        db: TProjectChatDb = this.models.pool,
    ): Promise<IChatParticipant[]> {
        await projectChatModels(this.models, db).resolveProject(req, projectId, 1);
        const assignments = await this.assignments.assignments(projectId, db);
        const items: IChatParticipant[] = assignments.map((item) => ({
            agentId: item.agentId,
            name: item.card.name,
            slug: item.card.slug,
            status: item.removed ? 'removed' : item.enabled ? 'active' : 'disabled',
            ...(!item.enabled || item.removed ? { reason: 'Агент выключен или удалён из проекта.' } : {}),
        }));
        const actor = await this.models.actor(req);
        if (projectLevel(actor.claims, actor.activeRole, projectId) < 2) return items;
        if (!room.model_id || !room.model_pin) return items;
        try {
            const model = await this.base(req, projectId, room.model_id, room.model_pin, db);
            return (await this.group(db).roster(req, projectId, model, db)).items;
        } catch {
            // Missing model permissions or readiness cannot make shared human history unavailable.
            return items.map((item) =>
                item.status === 'active'
                    ? { ...item, status: 'blocked', reason: 'Проверьте модель и доступ к ней в настройках чата.' }
                    : item,
            );
        }
    }
    async resolve(
        req: Request,
        projectId: string,
        room: IProjectChatRoomRow,
        ids: string[],
        db: TProjectChatDb = this.models.pool,
    ): Promise<IChatAgentSnapshot[]> {
        if (!ids.length) return [];
        if (!room.model_id || !room.model_pin)
            throw new ConflictException('Администратор проекта должен выбрать модель и агентов в настройках чата.');
        const model = await this.base(req, projectId, room.model_id, room.model_pin, db);
        await db.query(
            'SELECT agent_id FROM project_agents WHERE project_id=$1 AND agent_id=ANY($2::text[]) FOR SHARE',
            [projectId, ids],
        );
        return (await this.group(db).plan(req, this.scope(projectId, room.agent_ids, model), model, ids, db)).map(
            (item) => item.snapshot,
        );
    }
    async assert(
        req: Request,
        projectId: string,
        snapshot: IChatAgentSnapshot,
        db: TProjectChatDb = this.models.pool,
    ): Promise<void> {
        const model = await this.base(req, projectId, snapshot.modelId, snapshot.modelPin, db);
        await db.query('SELECT agent_id FROM project_agents WHERE project_id=$1 AND agent_id=$2 FOR SHARE', [
            projectId,
            snapshot.agentId,
        ]);
        const current = (
            await this.group(db).plan(
                req,
                this.scope(projectId, [snapshot.agentId], model),
                model,
                [snapshot.agentId],
                db,
            )
        )[0];
        if (!isDeepStrictEqual(current.snapshot, snapshot))
            throw new ConflictException('Профиль или модель агента изменились. Проверьте настройки перед повтором.');
    }
    async transport(
        req: Request,
        projectId: string,
        snapshot: IChatAgentSnapshot,
        db: TProjectChatDb = this.models.pool,
    ): Promise<TProjectChatTransport> {
        return (await this.base(req, projectId, snapshot.modelId, snapshot.modelPin, db)).runtime === 'device-codex'
            ? 'device-codex'
            : 'server';
    }
    async infer({ req, projectId, source, response, signal }: Parameters<IProjectChatInference['infer']>[0]) {
        const snapshot = response.snapshot;
        if (
            !snapshot ||
            source.project_id !== projectId ||
            response.project_id !== projectId ||
            response.source_message_id !== source.id ||
            (source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM) !== (response.room_id ?? DEFAULT_PROJECT_CHAT_ROOM)
        )
            throw new ConflictException('Ответ относится к другому сообщению проекта.');
        const actor = await this.models.actor(req);
        if (actor.email !== source.author_email) throw new ConflictException('Автор принятого запроса изменился.');
        const learning = await this.groups.learning.prepare(
            req,
            { project_id: projectId, owner_email: actor.email },
            snapshot.agentId,
            signal,
        );
        let privateRoomId: string | undefined;
        const authorize = async (beforeCall = true, db: TProjectChatDb = this.models.pool, publication = false) => {
            signal.throwIfAborted();
            await this.assert(req, projectId, snapshot, db);
            if (beforeCall) await learning.beforeInference();
            else await learning.assertAuthorized(db);
            const room = (
                await db.query<IProjectChatRoomRow>('SELECT * FROM project_chat_rooms WHERE project_id=$1 AND id=$2', [
                    projectId,
                    source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM,
                ])
            ).rows[0];
            if (!room) throw new ConflictException('Диалог недоступен.');
            await assertProjectChatRoomAccess(db, room, actor.email);
            privateRoomId = room.visibility === 'PRIVATE' ? source.room_id : undefined;
            if (!room?.agent_ids.includes(snapshot.agentId))
                throw new ConflictException('Агент исключён из общей комнаты. Готовые ответы сохранены.');
            const active = await db.query(
                `SELECT 1 FROM project_chat_messages s JOIN project_chat_messages r ON r.project_id=s.project_id AND r.room_id=s.room_id AND r.source_message_id=s.id
                WHERE s.project_id=$1 AND s.id=$2 AND r.id=$3 AND s.generation=$4 AND r.generation=$4
                AND s.status='running' AND s.lease_until>now() AND ((r.status='running' AND r.lease_until>now()) OR ($5 AND r.status='done'))`,
                [projectId, source.id, response.id, response.generation, publication],
            );
            if (!active.rowCount)
                throw new ConflictException('Обработка этого сообщения уже остановлена или завершена.');
            signal.throwIfAborted();
        };
        await authorize();
        const model = await this.base(req, projectId, snapshot.modelId, snapshot.modelPin),
            settings = await this.settings(model);
        const ancestors = await this.ancestors(projectId, source);
        const sequential = projectChatSequentialContext(await this.sequential(projectId, source, response.generation));
        const shared = [
            ...projectChatRoomsContext(await this.roomsForAgent(projectId, snapshot.agentId)),
            ...projectChatSharedContext(await this.shared(projectId, source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM)),
        ];
        let messages = projectChatContext(
            snapshot.definition.prompt,
            source,
            ancestors,
            learning.messages,
            settings,
            sequential,
            shared,
        );
        let toolsCurrent: (db?: TProjectChatDb) => Promise<void> = (db) => authorize(false, db, true);
        if (source.agent_tools_request) {
            if (!this.agentTools) throw new BadRequestException('Инструменты агентов недоступны.');
            if (
                chatContext([...agentToolContext(projectId, source.agent_tools_request), ...messages], settings)
                    .exceeded
            )
                throw new BadRequestException('Сообщение и инструменты не помещаются в окно модели.');
            await this.agentTools.admit(req, projectId, source.agent_tools_request);
            const none = { status: 'none' as const, sources: [] };
            const project: IPreparedProjectContext = source.agent_tools_request.rag
                ? await withModelUsage(
                      {
                          purpose: 'project-search',
                          actorEmail: actor.email,
                          actorRole: actor.activeRole,
                          projectId,
                          turnId: source.id,
                          agentId: snapshot.agentId,
                          privateProjectChatRoomId: privateRoomId,
                          requiredFeatures: ['project_agent_tools'],
                          beforeInference: () => authorize(),
                      },
                      () =>
                          new ModelChatProjectContext(this.models, this.runtime).prepare(
                              req,
                              projectId,
                              source.content,
                              signal,
                              () => authorize(),
                          ),
                  )
                : {
                      messages: [],
                      evidence: none,
                      requiredFeatures: [],
                      assertCurrent: (db) => authorize(false, db, true),
                      beforeInference: () => authorize(),
                      fit: (history) => ({ messages: history, evidence: none }),
                  };
            const fitted = project.fit(messages, settings);
            const toolResult = await this.agentTools.run(
                req,
                {
                    owner: {
                        kind: 'project-chat',
                        originId: source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM,
                        turnId: source.id,
                        recipientId: response.id,
                        generation: response.generation,
                        ownerEmail: actor.email,
                        actorRole: actor.activeRole,
                        projectId,
                        agentId: snapshot.agentId,
                        modelId: model.id,
                        modelPin: projectEmbeddingPin(model),
                        grant: source.agent_tools_request,
                    },
                    messages: fitted.messages,
                    settings,
                    signal,
                    assertAuthorized: (db) => authorize(false, db, true),
                    assertCurrent: (db) => authorize(false, db),
                },
                project,
                source.content,
            );
            messages = toolResult.messages;
            toolsCurrent = (db) => toolResult.assertCurrent(db);
        }
        const options = automaticModelOptions(
            model,
            {},
            {
                ...(snapshot.definition.temperature === undefined
                    ? {}
                    : { temperature: snapshot.definition.temperature }),
                ...(snapshot.definition.topP === undefined ? {} : { top_p: snapshot.definition.topP }),
                ...(model.runtime === 'ollama' && this.localContextWindow !== null
                    ? { num_ctx: this.localContextWindow }
                    : {}),
            },
        );
        const result = await withModelUsage(
            {
                purpose: 'agent',
                privateProjectChatRoomId: privateRoomId,
                actorEmail: actor.email,
                actorRole: actor.activeRole,
                projectId,
                agentId: snapshot.agentId,
                turnId: source.id,
                operationId: response.id,
                requiredFeatures: [
                    'project_chat',
                    'group_chat',
                    ...((source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM) === DEFAULT_PROJECT_CHAT_ROOM
                        ? []
                        : ['project_chat_dialogs' as const]),
                    ...learning.requiredFeatures,
                    ...(source.agent_tools_request ? ['project_agent_tools' as const] : []),
                ],
                beforeInference: async () => {
                    await toolsCurrent();
                    await authorize();
                },
            },
            () =>
                this.runtime.infer(
                    model,
                    'chat',
                    modelInferenceBody('chat', { messages, stream: false, options }),
                    signal,
                ),
        );
        await authorize(false);
        await toolsCurrent();
        const message = result.message as Record<string, unknown> | undefined;
        if (
            !message ||
            message.role !== 'assistant' ||
            typeof message.content !== 'string' ||
            !message.content.trim() ||
            Buffer.byteLength(message.content) > 128 * 1024 ||
            !['stop', 'length'].includes(String(result.done_reason))
        )
            throw new BadRequestException('Агент не вернул допустимый ответ. Остальные ответы и сообщения сохранены.');
        return {
            content:
                message.content +
                (result.done_reason === 'length'
                    ? '\n\n[Ответ ограничен лимитом модели. Можно задать уточняющий вопрос.]'
                    : ''),
            usage: chatUsage(result),
            learning: learning.receipt,
            ...(source.agent_tools_request ? { assertCurrent: toolsCurrent } : {}),
        };
    }
    private group(db: TProjectChatDb): ChatGroup {
        return new ChatGroup(projectChatModels(this.models, db), this.assignments);
    }
    private async base(
        req: Request,
        projectId: string,
        id: string,
        pin: string,
        db: TProjectChatDb = this.models.pool,
    ): Promise<IModel> {
        const model = await projectChatModels(this.models, db).getUsable(id, req, projectId);
        if (
            model.capability === 'embedding' ||
            !(model.runtime === 'ollama' ? model.manifestSha256 : model.verificationSha256) ||
            projectEmbeddingPin(model) !== pin
        )
            throw new ConflictException('Модель чата изменилась или недоступна. Проверьте настройки.');
        return model;
    }
    private scope(projectId: string, ids: string[], model: IModel): IConversationRow {
        return {
            id: projectId,
            owner_email: '',
            project_id: projectId,
            model_id: model.id,
            model_pin: projectEmbeddingPin(model),
            mode: 'group',
            agent_ids: ids,
            title: '',
            revision: 0,
            created_at: '',
            updated_at: '',
        };
    }
    private async settings(model: IModel): Promise<IChatContextSettings> {
        if (model.runtime === 'ollama') return { contextWindowTokens: this.localContextWindow };
        const row = { options: await modelPlanningOptions(this.models.pool, model) };
        return {
            contextWindowTokens: row?.options.contextWindow ?? null,
            reservedOutputTokens: row?.options.maxOutputTokens ?? null,
        };
    }
    /**
     * FR-302: published (non-private) answers of previous executors, with provenance
     * (id/author/order/version), available to the next executor before its call.
     * A sibling answer on the same task from a different generation is the handover case;
     * an earlier position is the sequential chain case.
     */
    private async sequential(
        projectId: string,
        source: IProjectChatMessageRow,
        responseGeneration: string,
    ): Promise<IProjectChatSequentialAnswer[]> {
        const rows = (
            await this.models.pool.query<{
                id: string;
                position: string;
                content: string;
                generation: string;
                agent_id: string | null;
                name: string | null;
            }>(
                `SELECT m.id, m.position::text AS position, m.content, m.generation,
                    m.snapshot->>'agentId' AS agent_id, m.snapshot->>'name' AS name
                 FROM project_chat_messages m
                 JOIN project_chat_rooms r ON r.project_id=m.project_id AND r.id=m.room_id
                 WHERE m.project_id=$1 AND m.room_id=$2 AND m.kind='agent' AND m.status='done'
                   AND r.visibility <> 'PRIVATE'
                   AND (m.position < $3 OR (m.source_message_id = $4 AND m.generation <> $5))
                 ORDER BY m.position DESC
                 LIMIT 8`,
                [
                    projectId,
                    source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM,
                    source.position,
                    source.id,
                    responseGeneration,
                ],
            )
        ).rows;
        return rows
            .filter(
                (
                    row,
                ): row is {
                    id: string;
                    position: string;
                    content: string;
                    generation: string;
                    agent_id: string;
                    name: string;
                } => !!row.agent_id && !!row.name,
            )
            .map((row) => ({
                id: row.id,
                position: row.position,
                agentId: row.agent_id,
                name: row.name,
                generation: row.generation,
                content: row.content,
            }));
    }
    /**
     * FR-309: context elements shared into this room, with per-item provenance
     * (sharing agent, referenced source, version, SHA, time), available before the call.
     */
    private async shared(projectId: string, roomId: string): Promise<IProjectChatSharedItem[]> {
        const rows = (
            await this.models.pool.query<{
                item_id: string;
                kind: string;
                content: string;
                ref_message_id: string | null;
                source_room_id: string;
                source_agent_id: string;
                source_agent_name: string | null;
                source_generation: string;
                content_sha: string;
                created_at: Date;
            }>(
                `SELECT item_id, kind, content, ref_message_id, source_room_id, source_agent_id, source_agent_name,
                    source_generation, content_sha, created_at
                 FROM project_chat_shared_items
                 WHERE project_id=$1 AND room_id=$2
                 ORDER BY created_at DESC, item_id DESC
                 LIMIT 8`,
                [projectId, roomId],
            )
        ).rows;
        return rows.reverse().map((row) => ({
            itemId: row.item_id,
            kind: row.kind,
            content: row.content,
            refMessageId: row.ref_message_id,
            sourceRoomId: row.source_room_id,
            sourceAgentId: row.source_agent_id,
            sourceAgentName: row.source_agent_name,
            sourceGeneration: row.source_generation,
            contentSha: row.content_sha,
            createdAt: row.created_at,
        }));
    }
    /** FR-309: rooms the agent participates in, so it can address context sharing by room ID. */
    private async roomsForAgent(projectId: string, agentId: string): Promise<IProjectChatAddressableRoom[]> {
        const rows = (
            await this.models.pool.query<IProjectChatAddressableRoom>(
                'SELECT id, title, visibility FROM project_chat_rooms WHERE project_id=$1 AND $2 = ANY(agent_ids) ORDER BY id LIMIT 8',
                [projectId, agentId],
            )
        ).rows;
        return rows.map((row) => ({ id: String(row.id), title: row.title, visibility: row.visibility }));
    }
    private async ancestors(projectId: string, source: IProjectChatMessageRow): Promise<IProjectChatMessageRow[]> {
        const rows: IProjectChatMessageRow[] = [],
            visited = new Set<string>();
        let id = source.reply_to_id;
        while (id && visited.size < 8 && !visited.has(id)) {
            visited.add(id);
            const row = (
                await this.models.pool.query<IProjectChatMessageRow>(
                    'SELECT * FROM project_chat_messages WHERE project_id=$1 AND id=$2 AND position<$3 AND room_id=$4',
                    [projectId, id, source.position, source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM],
                )
            ).rows[0];
            if (!row) break;
            if (row.content && (row.kind === 'user' || (row.kind === 'agent' && row.status === 'done'))) rows.push(row);
            id = row.reply_to_id;
        }
        return rows.reverse();
    }
}
