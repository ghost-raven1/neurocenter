import { BadRequestException, ConflictException, ForbiddenException, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { ModelsService } from '../models/models.service';
import { ProjectChatInferenceService } from '../project-chat-inference/project-chat-inference.service';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { ProjectChatPolicy, type ProjectChatActor } from './project-chat.policy';
import { ProjectChatRepository } from './project-chat.repository';
import { ProjectChatRunner } from './project-chat.runner';
import { resolveProjectChatProject } from './project-chat-project';
import { projectChatRoomView, type ProjectChatDb, type ProjectChatDetail, type ProjectChatMessage, type ProjectChatMessageRow, type ProjectChatReceipt, type ProjectChatRoomRow } from './project-chat.types';
import { projectChatBody, projectChatPage, projectChatParticipants, projectChatSend, projectChatUuid, projectChatWatch } from './project-chat.validation';

/** Project membership shares a room; private model chats keep their existing owner boundary. */
@Injectable()
export class ProjectChatService implements OnModuleInit, OnApplicationShutdown {
    readonly policy = new ProjectChatPolicy();
    readonly repository: ProjectChatRepository;
    readonly runner: ProjectChatRunner;
    constructor(private readonly models: ModelsService, private readonly inference: ProjectChatInferenceService) {
        this.repository = new ProjectChatRepository(models.pool, this.policy); this.runner = new ProjectChatRunner(this.repository, inference);
    }
    async onModuleInit(): Promise<void> { await this.models.ready(); await this.runner.start(); }
    async onApplicationShutdown(): Promise<void> { await this.runner.stop(); }
    private async project(req: Request, id: string) {
        const actor = this.policy.input(req), project = await resolveProjectChatProject(this.models, this.models.pool, req, id);
        return { actor, projectId: project.id };
    }
    private view(row: ProjectChatMessageRow, actor: ProjectChatActor): ProjectChatMessage {
        const manage = actor.level >= 2 && row.kind === 'user' && (row.author_email === actor.email || actor.level >= 3);
        return { id: row.id, position: String(row.position), kind: row.kind, content: row.content,
            author: row.author_email ? { email: row.author_email, displayName: row.author_name || row.author_email } : null,
            agent: row.snapshot ? { id: row.snapshot.agentId, name: row.snapshot.name, slug: row.snapshot.slug, modelId: row.snapshot.modelId, modelPin: row.snapshot.modelPin } : null,
            replyToId: row.reply_to_id, sourceMessageId: row.source_message_id, status: row.status,
            ...(row.error ? { error: row.error } : {}), createdAt: new Date(row.created_at).toISOString(),
            canRetry: manage && actor.writable && row.target_agent_ids.length > 0 && ['failed', 'cancelled'].includes(row.status),
            canCancel: manage && ['queued', 'running'].includes(row.status) };
    }
    private async receipt(db: ProjectChatDb, room: ProjectChatRoomRow, actor: ProjectChatActor, source: ProjectChatMessageRow): Promise<ProjectChatReceipt> {
        const slots = (await this.repository.children(db, room.project_id, source.id)).slice(0, 9);
        return { message: this.view(source, actor), messages: [source, ...slots].map(row => this.view(row, actor)), roomRevision: Number(room.revision) };
    }
    async read(req: Request, id: string, rawWatch?: string): Promise<ProjectChatDetail> {
        const watch = projectChatWatch(rawWatch);
        const { actor, projectId } = await this.project(req, id);
        return this.repository.scoped(projectId, actor, 1, false, async (db, room, current) => {
            const page = await this.repository.page(db, projectId);
            const watched = watch.length ? (await db.query<ProjectChatMessageRow>('SELECT * FROM project_chat_messages WHERE project_id=$1 AND id=ANY($2::uuid[])', [projectId, watch])).rows : [];
            const messages = [...new Map([...page.messages, ...watched].map(row => [row.id, row])).values()].sort((a, b) => BigInt(a.position) < BigInt(b.position) ? -1 : BigInt(a.position) > BigInt(b.position) ? 1 : 0);
            const members = (await db.query<{ email: string; displayName: string; role: string }>(`SELECT lower(pm.principal_name) AS email,COALESCE(NULLIF(u.display_name,''),pm.display_name,pm.principal_name) AS "displayName",pm.role
                FROM project_members pm JOIN platform_users u ON u.email=lower(pm.principal_name) AND u.enabled WHERE pm.project_id=$1 ORDER BY pm.display_name,pm.principal_name`, [projectId])).rows;
            return { room: projectChatRoomView(room), members, agents: await this.inference.roster(req, projectId, room, db),
                messages: messages.map(row => this.view(row, current)), history: page.history, canPost: current.writable && current.level >= 2, canConfigure: current.writable && current.level >= 3 };
        });
    }
    async history(req: Request, id: string, before?: string, rawLimit?: string) {
        const page = projectChatPage(before, rawLimit), { actor, projectId } = await this.project(req, id);
        return this.repository.scoped(projectId, actor, 1, false, async (db, room, current) => {
            const result = await this.repository.page(db, projectId, page.before, page.limit);
            return { messages: result.messages.map(row => this.view(row, current)), history: result.history, roomRevision: Number(room.revision) };
        });
    }
    async participants(req: Request, id: string, raw: unknown): Promise<ProjectChatDetail> {
        const input = projectChatParticipants(raw), { actor, projectId } = await this.project(req, id);
        await this.repository.scoped(projectId, actor, 3, true, async (db, room) => {
            if (Number(room.revision) !== input.expectedRevision) throw new ConflictException('Чат уже изменился. Обновите настройки; введённый вариант можно сохранить после проверки.');
            const introduces = input.agentIds.some(agentId => !room.agent_ids.includes(agentId))
                || input.agentIds.length > 0 && (input.modelId !== room.model_id || input.modelPin !== room.model_pin);
            if (introduces || !room.revision) await requireFeaturesEnabled(['project_chat', ...(input.agentIds.length ? ['group_chat' as const] : [])]);
            const next = { ...room, agent_ids: input.agentIds, model_id: input.modelId, model_pin: input.modelPin };
            if (input.agentIds.length && introduces) await this.inference.resolve(req, projectId, next, input.agentIds, db);
            await this.repository.ensure(db, room);
            await db.query('UPDATE project_chat_rooms SET agent_ids=$2,model_id=$3,model_pin=$4 WHERE project_id=$1', [projectId, input.agentIds, input.modelId, input.modelPin]);
            await this.repository.bump(db, room);
        });
        return this.read(req, projectId);
    }
    async send(req: Request, id: string, raw: unknown) {
        const input = projectChatSend(raw), { actor, projectId } = await this.project(req, id);
        const result = await this.repository.scoped(projectId, actor, 2, true, async (db, room, current) => {
            const prior = await this.repository.prior(db, projectId, current.email, input.requestKey);
            if (prior) {
                if (prior.request_hash !== input.hash) throw new ConflictException('Ключ отправки уже относится к другому сообщению.');
                return this.receipt(db, room, current, prior);
            }
            if (!current.writable) throw new ForbiddenException('Проект доступен только для чтения. Ранее отправленные сообщения сохранены.');
            await requireFeaturesEnabled(['project_chat']);
            if (input.replyToId) {
                const parent = await this.repository.message(db, projectId, input.replyToId);
                if (parent.kind !== 'user' && (parent.kind !== 'agent' || parent.status !== 'done' || !parent.content.trim())) throw new ConflictException('Ответьте на сообщение пользователя или на готовый ответ агента.');
            }
            const targets = input.targetAgentIds ?? [];
            if (targets.some(agentId => !room.agent_ids.includes(agentId))) throw new BadRequestException('Выберите агентов из состава этого чата.');
            if (targets.length) await this.repository.assertQueueCapacity(db, projectId, current.email);
            if (targets.length) await requireFeaturesEnabled(['group_chat']);
            const snapshots = targets.length ? await this.inference.resolve(req, projectId, room, targets, db) : [];
            await this.repository.ensure(db, room);
            const source = await this.repository.add(db, room, current, input, snapshots);
            return this.receipt(db, room, current, source);
        }, true);
        // The receipt is already durable; disconnecting this HTTP request cannot discard accepted work.
        this.runner.schedule(projectId); return result;
    }
    async retry(req: Request, id: string, messageId: string, raw: unknown) {
        projectChatUuid(messageId); const input = projectChatBody(raw, ['requestKey']), key = projectChatUuid(input.requestKey), { actor, projectId } = await this.project(req, id);
        const result = await this.repository.scoped(projectId, actor, 2, true, async (db, room, current) => {
            const source = await this.repository.message(db, projectId, messageId);
            this.manage(source, current);
            const previous = (await db.query<{ message_id: string }>('SELECT message_id FROM project_chat_retry_requests WHERE project_id=$1 AND actor_email=$2 AND request_key=$3', [projectId, actor.email, key])).rows[0];
            if (previous) {
                if (previous.message_id !== messageId) throw new ConflictException('Ключ повторения уже относится к другому сообщению.');
                return this.receipt(db, room, current, source);
            }
            if (!current.writable) throw new ForbiddenException('Проект доступен только для чтения. Ранее принятые ответы сохранены.');
            if (!['failed', 'cancelled'].includes(source.status) || !source.target_agent_ids.length) throw new ConflictException('Повторить можно недостающие ответы прерванного сообщения.');
            const unfinished = (await this.repository.children(db, projectId, messageId)).filter(row => row.kind === 'agent' && row.status !== 'done');
            if (!unfinished.length) throw new ConflictException('Все ответы уже получены.');
            if (unfinished.some(row => !row.snapshot || !room.agent_ids.includes(row.snapshot.agentId))) throw new ConflictException('Агент исключён из чата. Отправьте новый вопрос текущему составу; готовые ответы сохранены.');
            await this.repository.assertQueueCapacity(db, projectId, source.author_email!);
            await requireFeaturesEnabled(['project_chat', 'group_chat']);
            for (const response of unfinished) await this.inference.assert(req, projectId, response.snapshot!, db);
            const generation = randomUUID();
            await db.query("UPDATE project_chat_messages SET status='queued',generation=$3,lease_until=NULL,error=NULL WHERE project_id=$1 AND (id=$2 OR source_message_id=$2) AND (kind<>'agent' OR status<>'done')", [projectId, messageId, generation]);
            await db.query('INSERT INTO project_chat_retry_requests(project_id,actor_email,request_key,message_id) VALUES($1,$2,$3,$4)', [projectId, actor.email, key, messageId]);
            await this.repository.bump(db, room);
            return this.receipt(db, room, current, await this.repository.message(db, projectId, messageId));
        }, true);
        this.runner.schedule(projectId); return result;
    }
    async cancel(req: Request, id: string, messageId: string, raw: unknown) {
        projectChatUuid(messageId); projectChatBody(raw ?? {}, []); const { actor, projectId } = await this.project(req, id);
        const result = await this.repository.scoped(projectId, actor, 2, true, async (db, room, current) => {
            const source = await this.repository.message(db, projectId, messageId); this.manage(source, current);
            if (['queued', 'running'].includes(source.status)) {
                await db.query("UPDATE project_chat_messages SET status='cancelled',lease_until=NULL,error='Обработка остановлена. Готовые ответы сохранены.' WHERE project_id=$1 AND (id=$2 OR source_message_id=$2) AND status IN ('queued','running')", [projectId, messageId]);
                await this.repository.bump(db, room);
            }
            return this.receipt(db, room, current, await this.repository.message(db, projectId, messageId));
        }, true);
        this.runner.cancel(messageId); return result;
    }
    private manage(source: ProjectChatMessageRow, actor: ProjectChatActor): void {
        if (source.kind !== 'user' || source.author_email !== actor.email && actor.level < 3) throw new ForbiddenException('Остановить или повторить ответ может автор сообщения или администратор проекта.');
    }
}
