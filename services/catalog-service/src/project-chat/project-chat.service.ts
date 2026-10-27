import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { ModelsService } from '../models/models.service';
import { ProjectChatInferenceService } from '../project-chat-inference/project-chat-inference.service';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { ProjectChatPolicy, type ProjectChatActor } from './project-chat.policy';
import { ProjectChatRepository } from './project-chat.repository';
import {ProjectChatDialogs, canManageProjectChatRoom} from './project-chat-dialogs';
import {assertProjectChatRoomAccess,projectChatMembers, projectChatPrivateMembers, projectChatRoomEmails} from './project-chat-room-access';
import { ProjectChatRunner } from './project-chat.runner';
import { resolveProjectChatProject } from './project-chat-project';
import { DEFAULT_PROJECT_CHAT_ROOM, projectChatRoomId, projectChatRoomView, type ProjectChatDb, type ProjectChatDetail, type ProjectChatMessage, type ProjectChatMessageRow, type ProjectChatReceipt, type ProjectChatRoomRow } from './project-chat.types';
import { projectChatBody, projectChatPage, projectChatParticipants, projectChatSend, projectChatUuid, projectChatWatch } from './project-chat.validation';
import {ProjectChatActivityService} from '../chat-activity/project-chat-activity';
import type {ChatAgentSnapshot} from '../model-chat/chat-group.types';
import type {ProjectChatTransport} from './project-chat.types';
import {projectChatMethodWorkflows,projectChatMethodWorkflowPage} from '../agent-method-workflows/chat-workflows';

/** Project membership shares a room; private model chats keep their existing owner boundary. */
@Injectable()
export class ProjectChatService implements OnModuleInit, OnApplicationShutdown {
    readonly policy = new ProjectChatPolicy();
    readonly repository: ProjectChatRepository;
    readonly runner: ProjectChatRunner;
    readonly dialogs: ProjectChatDialogs;
    readonly activity: ProjectChatActivityService;
    constructor(private readonly models: ModelsService, private readonly inference: ProjectChatInferenceService) {
        this.repository = new ProjectChatRepository(models.pool, this.policy); this.dialogs = new ProjectChatDialogs(this.repository); this.runner = new ProjectChatRunner(this.repository, inference);
        this.activity = new ProjectChatActivityService(this.repository);
    }
    async onModuleInit(): Promise<void> { await this.models.ready(); await this.runner.start(); }
    async onApplicationShutdown(): Promise<void> { await this.runner.stop(); }
    private async project(req: Request, id: string) {
        const actor = this.policy.input(req), project = await resolveProjectChatProject(this.models, this.models.pool, req, id);
        return { actor, projectId: project.id };
    }
    private view(row: ProjectChatMessageRow, actor: ProjectChatActor): ProjectChatMessage {
        const manage = actor.level >= 2 && row.kind === 'user' && (row.author_email === actor.email || actor.level >= 3);
        return { id: row.id, roomId: row.room_id ?? DEFAULT_PROJECT_CHAT_ROOM, position: String(row.position), kind: row.kind, content: row.content,
            author: row.author_email ? { email: row.author_email, displayName: row.author_name || row.author_email } : null,
            agent: row.snapshot ? { id: row.snapshot.agentId, name: row.snapshot.name, slug: row.snapshot.slug, modelId: row.snapshot.modelId, modelPin: row.snapshot.modelPin } : null,
            replyToId: row.reply_to_id, sourceMessageId: row.source_message_id, status: row.status,...(row.agent_tools_request?{agentTools:row.agent_tools_request}:{}),
            ...(row.kind === 'agent' && row.status === 'done' && row.learning ? { learning: {
                status: row.learning.status, projectId: row.learning.projectId, agentId: row.learning.agentId,
                ...(row.learning.revision === undefined ? {} : { revision: row.learning.revision }),
                ...(row.learning.digest === undefined ? {} : { digest: row.learning.digest }),
                entries: row.learning.entries.map(({ id, key, version, sha256 }) => ({ id, key, version, sha256 })),
            } } : {}),
            ...(row.error ? { error: row.error } : {}), createdAt: new Date(row.created_at).toISOString(),
            canRetry: manage && actor.writable && row.target_agent_ids.length > 0 && ['failed', 'cancelled'].includes(row.status),
            canCancel: manage && ['queued', 'running'].includes(row.status) };
    }
    private async receipt(db: ProjectChatDb, room: ProjectChatRoomRow, actor: ProjectChatActor, source: ProjectChatMessageRow): Promise<ProjectChatReceipt> {
        const slots = (await this.repository.children(db, room.project_id, source.id, projectChatRoomId(room))).slice(0, 9);
        const messages=await this.views(db,room,actor,[source,...slots]);
        return { message: messages[0], messages, roomRevision: Number(room.revision) };
    }
    private async views(db:ProjectChatDb,room:ProjectChatRoomRow,actor:ProjectChatActor,rows:ProjectChatMessageRow[]):Promise<ProjectChatMessage[]>{
        const receipts=await projectChatMethodWorkflows(db,room.project_id,projectChatRoomId(room),rows.filter(row=>row.kind==='user').map(row=>row.id),actor);
        return rows.map(row=>{const page=receipts.get(row.id);return {...this.view(row,actor),...(page?{methodWorkflows:page.items,methodWorkflowsHistory:{hasMore:page.hasMore,nextCursor:page.nextCursor}}:{})};});
    }
    async methodWorkflows(req:Request,id:string,messageId:string,before?:string,rawLimit?:string,roomId=DEFAULT_PROJECT_CHAT_ROOM){
        projectChatUuid(roomId);projectChatUuid(messageId);if(before!==undefined)projectChatUuid(before);
        const limit=rawLimit===undefined?8:Number(rawLimit);if(!Number.isSafeInteger(limit)||limit<1||limit>8)throw new BadRequestException('Размер страницы задач: от 1 до 8.');
        const {actor,projectId}=await this.project(req,id);
        return this.repository.scoped(projectId,actor,1,false,async(db,_room,current)=>{
            const source=await this.repository.message(db,projectId,messageId,roomId);
            if(source.kind!=='user')throw new NotFoundException('Сообщение пользователя не найдено.');
            return projectChatMethodWorkflowPage(db,projectId,roomId,messageId,current,before,limit);
        },false,roomId);
    }
    private async assertQueueCapacity(req: Request, db: ProjectChatDb, projectId: string, author: string, snapshots: ChatAgentSnapshot[]): Promise<void> {
        const transports = new Set<ProjectChatTransport>();
        for (const snapshot of snapshots) transports.add(await this.inference.transport(req, projectId, snapshot, db));
        await this.repository.assertQueueCapacity(db, projectId, author, [...transports]);
    }
    async read(req: Request, id: string, rawWatch?: string, roomId = DEFAULT_PROJECT_CHAT_ROOM): Promise<ProjectChatDetail> {
        projectChatUuid(roomId); const watch = projectChatWatch(rawWatch);
        const { actor, projectId } = await this.project(req, id);
        return this.repository.scoped(projectId, actor, 1, false, async (db, room, current) => {
            const page = await this.repository.page(db, projectId, undefined, 50, roomId);
            const watched = watch.length ? (await db.query<ProjectChatMessageRow>('SELECT * FROM project_chat_messages WHERE project_id=$1 AND id=ANY($2::uuid[]) AND room_id=$3', [projectId, watch, roomId])).rows : [];
            const messages = [...new Map([...page.messages, ...watched].map(row => [row.id, row])).values()].sort((a, b) => BigInt(a.position) < BigInt(b.position) ? -1 : BigInt(a.position) > BigInt(b.position) ? 1 : 0);
            const memberEmails = await projectChatRoomEmails(db, room), members = room.visibility === 'PRIVATE' ? await projectChatPrivateMembers(db, projectId, memberEmails) : await projectChatMembers(db, projectId);
            return { room: {...projectChatRoomView(room), memberEmails, canManage: canManageProjectChatRoom(room, current)}, members, agents: await this.inference.roster(req, projectId, room, db),
                messages: await this.views(db,room,current,messages), history: page.history, canPost: current.writable && current.level >= 2, canConfigure: current.writable && (current.level >= 3 || roomId !== DEFAULT_PROJECT_CHAT_ROOM && room.creator_email === current.email && current.level >= 2) };
        }, false, roomId);
    }
    async history(req: Request, id: string, before?: string, rawLimit?: string, roomId = DEFAULT_PROJECT_CHAT_ROOM) {
        projectChatUuid(roomId); const page = projectChatPage(before, rawLimit), { actor, projectId } = await this.project(req, id);
        return this.repository.scoped(projectId, actor, 1, false, async (db, room, current) => {
            const result = await this.repository.page(db, projectId, page.before, page.limit, roomId);
            return { messages: await this.views(db,room,current,result.messages), history: result.history, roomRevision: Number(room.revision) };
        }, false, roomId);
    }
    async participants(req: Request, id: string, raw: unknown, roomId = DEFAULT_PROJECT_CHAT_ROOM): Promise<ProjectChatDetail> {
        projectChatUuid(roomId); const input = projectChatParticipants(raw), { actor, projectId } = await this.project(req, id);
        await this.repository.scoped(projectId, actor, roomId === DEFAULT_PROJECT_CHAT_ROOM ? 3 : 2, true, async (db, room, current) => {
            if (current.level < 3 && room.creator_email !== current.email) throw new ForbiddenException('Настроить агентов может создатель диалога или администратор проекта.');
            if (Number(room.revision) !== input.expectedRevision) throw new ConflictException('Чат уже изменился. Обновите настройки; введённый вариант можно сохранить после проверки.');
            const introduces = input.agentIds.some(agentId => !room.agent_ids.includes(agentId))
                || input.agentIds.length > 0 && (input.modelId !== room.model_id || input.modelPin !== room.model_pin);
            if (introduces || !room.revision) await requireFeaturesEnabled(['project_chat', ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const]), ...(input.agentIds.length ? ['group_chat' as const] : [])]);
            const next = { ...room, agent_ids: input.agentIds, model_id: input.modelId, model_pin: input.modelPin };
            if (input.agentIds.length && introduces) await this.inference.resolve(req, projectId, next, input.agentIds, db);
            await this.repository.ensure(db, room);
            await db.query('UPDATE project_chat_rooms SET agent_ids=$2,model_id=$3,model_pin=$4 WHERE project_id=$1 AND id=$5', [projectId, input.agentIds, input.modelId, input.modelPin, roomId]);
            await this.repository.bump(db, room);
        }, false, roomId);
        return this.read(req, projectId, undefined, roomId);
    }
    async send(req: Request, id: string, raw: unknown, roomId = DEFAULT_PROJECT_CHAT_ROOM) {
        projectChatUuid(roomId); const {actor,projectId}=await this.project(req,id),input=projectChatSend(raw,projectId);
        const result = await this.repository.scoped(projectId, actor, 2, true, async (db, room, current) => {
            const prior = await this.repository.prior(db, projectId, current.email, input.requestKey, roomId);
            if (prior) {
                if (prior.request_hash !== input.hash) throw new ConflictException('Ключ отправки уже относится к другому сообщению.');
                return this.receipt(db, room, current, prior);
            }
            if (!current.writable) throw new ForbiddenException('Проект доступен только для чтения. Ранее отправленные сообщения сохранены.');
            await requireFeaturesEnabled(['project_chat', ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const])]);
            if (input.replyToId) {
                const parent = await this.repository.message(db, projectId, input.replyToId, roomId);
                if (parent.kind !== 'user' && (parent.kind !== 'agent' || parent.status !== 'done' || !parent.content.trim())) throw new ConflictException('Ответьте на сообщение пользователя или на готовый ответ агента.');
            }
            const targets = input.targetAgentIds ?? [];
            if(input.agentTools){if(!targets.length)throw new BadRequestException('Выберите агента для работы с инструментами.');await requireFeaturesEnabled(['project_agent_tools']);}
            if (targets.some(agentId => !room.agent_ids.includes(agentId))) throw new BadRequestException('Выберите агентов из состава этого чата.');
            if (targets.length) await requireFeaturesEnabled(['group_chat']);
            const snapshots = targets.length ? await this.inference.resolve(req, projectId, room, targets, db) : [];
            if (snapshots.length) await this.assertQueueCapacity(req, db, projectId, current.email, snapshots);
            await this.repository.ensure(db, room);
            const source = await this.repository.add(db, room, current, input, snapshots);
            return this.receipt(db, room, current, source);
        }, true, roomId);
        // The receipt is already durable; disconnecting this HTTP request cannot discard accepted work.
        this.runner.schedule(projectId, roomId); return result;
    }
    async retry(req: Request, id: string, messageId: string, raw: unknown, roomId = DEFAULT_PROJECT_CHAT_ROOM) {
        projectChatUuid(roomId); projectChatUuid(messageId); const input = projectChatBody(raw, ['requestKey']), key = projectChatUuid(input.requestKey), { actor, projectId } = await this.project(req, id);
        const result = await this.repository.scoped(projectId, actor, 2, true, async (db, room, current) => {
            const source = await this.repository.message(db, projectId, messageId, roomId);
            this.manage(source, current);
            const previous = (await db.query<{ message_id: string }>('SELECT message_id FROM project_chat_retry_requests WHERE project_id=$1 AND actor_email=$2 AND request_key=$3 AND room_id=$4', [projectId, actor.email, key, roomId])).rows[0];
            if (previous) {
                if (previous.message_id !== messageId) throw new ConflictException('Ключ повторения уже относится к другому сообщению.');
                return this.receipt(db, room, current, source);
            }
            if (!current.writable) throw new ForbiddenException('Проект доступен только для чтения. Ранее принятые ответы сохранены.');
            if (!['failed', 'cancelled'].includes(source.status) || !source.target_agent_ids.length) throw new ConflictException('Повторить можно недостающие ответы прерванного сообщения.');
            const unfinished = (await this.repository.children(db, projectId, messageId, roomId)).filter(row => row.kind === 'agent' && row.status !== 'done');
            if (!unfinished.length) throw new ConflictException('Все ответы уже получены.');
            if (unfinished.some(row => !row.snapshot || !room.agent_ids.includes(row.snapshot.agentId))) throw new ConflictException('Агент исключён из чата. Отправьте новый вопрос текущему составу; готовые ответы сохранены.');
            await requireFeaturesEnabled(['project_chat', 'group_chat', ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const])]);
            const executor={email:source.author_email!,activeRole:source.author_role!};
            try{
                await this.policy.authorize(db,projectId,executor,2,true);
                await assertProjectChatRoomAccess(db,room,executor.email);
            }catch(error){
                if(error instanceof ForbiddenException||error instanceof NotFoundException)throw new ConflictException('Доступ автора или его исходной роли изменился. Отправьте новый вопрос от своего имени; готовые ответы сохранены.');
                throw error;
            }
            const executionRequest=this.policy.request(executor);
            for (const response of unfinished) await this.inference.assert(executionRequest, projectId, response.snapshot!, db);
            await this.assertQueueCapacity(executionRequest, db, projectId, source.author_email!, unfinished.map(row => row.snapshot!));
            const generation = randomUUID();
            await db.query("UPDATE project_chat_messages SET status='queued',generation=$3,lease_until=NULL,error=NULL WHERE project_id=$1 AND (id=$2 OR source_message_id=$2) AND (kind<>'agent' OR status<>'done')", [projectId, messageId, generation]);
            await db.query('INSERT INTO project_chat_retry_requests(project_id,actor_email,request_key,message_id,room_id) VALUES($1,$2,$3,$4,$5)', [projectId, actor.email, key, messageId, roomId]);
            await this.repository.bump(db, room);
            return this.receipt(db, room, current, await this.repository.message(db, projectId, messageId, roomId));
        }, true, roomId);
        this.runner.schedule(projectId, roomId); return result;
    }
    async cancel(req: Request, id: string, messageId: string, raw: unknown, roomId = DEFAULT_PROJECT_CHAT_ROOM) {
        projectChatUuid(roomId); projectChatUuid(messageId); projectChatBody(raw ?? {}, []); const { actor, projectId } = await this.project(req, id);
        const result = await this.repository.scoped(projectId, actor, 2, true, async (db, room, current) => {
            const source = await this.repository.message(db, projectId, messageId, roomId); this.manage(source, current);
            if (['queued', 'running'].includes(source.status)) {
                await db.query("UPDATE project_chat_messages SET status='cancelled',lease_until=NULL,error='Обработка остановлена. Готовые ответы сохранены.' WHERE project_id=$1 AND (id=$2 OR source_message_id=$2) AND status IN ('queued','running')", [projectId, messageId]);
                await this.repository.bump(db, room);
            }
            return this.receipt(db, room, current, await this.repository.message(db, projectId, messageId, roomId));
        }, true, roomId);
        this.runner.cancel(messageId); return result;
    }
    async rooms(req: Request, id: string) {const {actor, projectId} = await this.project(req, id); return this.dialogs.list(projectId, actor);}
    async readActivity(req: Request, id: string, messageIds?: string, roomId = DEFAULT_PROJECT_CHAT_ROOM) {const {actor, projectId} = await this.project(req, id); return this.activity.read(projectId, actor, messageIds, roomId);}
    async updateActivity(req: Request, id: string, raw: unknown, roomId = DEFAULT_PROJECT_CHAT_ROOM) {const {actor, projectId} = await this.project(req, id); return this.activity.update(projectId, actor, raw, roomId);}
    async createRoom(req: Request, id: string, raw: unknown) {const {actor, projectId} = await this.project(req, id); return this.dialogs.create(projectId, actor, raw);}
    async updateRoom(req: Request, id: string, roomId: string, raw: unknown) {const {actor, projectId} = await this.project(req, id); return this.dialogs.update(projectId, actor, roomId, raw);}
    private manage(source: ProjectChatMessageRow, actor: ProjectChatActor): void {
        if (source.kind !== 'user' || source.author_email !== actor.email && actor.level < 3) throw new ForbiddenException('Остановить или повторить ответ может автор сообщения или администратор проекта.');
    }
}
