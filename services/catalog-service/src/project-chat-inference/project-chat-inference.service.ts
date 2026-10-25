import {AgentToolsService} from '../agent-tools/agent-tools.service';
import {agentToolContext} from '../agent-tools/agent-tools.validation';
import {ModelChatProjectContext} from '../model-chat/chat-project-context';
import type {PreparedProjectContext} from '../model-chat/chat-project-context.types';
import {modelPlanningOptions} from '../models/model-planning-options';
import {automaticModelOptions} from '../models/model-runtime-options';
import { BadRequestException, ConflictException, Injectable,Optional } from '@nestjs/common';
import type { Request } from 'express';
import { projectLevel } from '../access/access.model';
import { isDeepStrictEqual } from 'node:util';
import { ProjectAgentRepository } from '../agents/project-agent.repository';
import { ChatGroup } from '../model-chat/chat-group';
import type { ChatAgentSnapshot, ChatParticipant } from '../model-chat/chat-group.types';
import { chatContext,chatUsage, managedChatContextWindow, type IChatContextSettings } from '../model-chat/chat-context';
import type { ConversationRow } from '../model-chat/chat.types';
import { withModelUsage } from '../model-usage/model-usage.context';
import { ModelsService } from '../models/models.service';
import { ModelRuntime } from '../models/model-runtime';
import { modelInferenceBody } from '../models/inference.controller';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import type { IModel } from '../models/model.types';
import {assertProjectChatRoomAccess} from '../project-chat/project-chat-room-access';
import {DEFAULT_PROJECT_CHAT_ROOM} from '../project-chat/project-chat.types';
import type { ProjectChatDb, ProjectChatInference, ProjectChatMessageRow, ProjectChatRoomRow, ProjectChatTransport } from '../project-chat/project-chat.types';
import { projectChatContext } from './project-chat-context';
import { projectChatModels } from './project-chat-models';

/** Reuses effective project agents and the existing model dispatcher, without reading private chat history. */
@Injectable()
export class ProjectChatInferenceService implements ProjectChatInference {
    private readonly assignments: ProjectAgentRepository;
    private readonly groups: ChatGroup;
    private readonly localContextWindow = managedChatContextWindow();
    constructor(private readonly models: ModelsService, private readonly runtime: ModelRuntime,@Optional() private readonly agentTools?:AgentToolsService) {
        this.assignments = new ProjectAgentRepository(models.pool); this.groups = new ChatGroup(projectChatModels(models, models.pool), this.assignments);
    }
    async roster(req: Request, projectId: string, room: ProjectChatRoomRow, db: ProjectChatDb = this.models.pool): Promise<ChatParticipant[]> {
        await projectChatModels(this.models, db).resolveProject(req, projectId, 1);
        const assignments = await this.assignments.assignments(projectId, db);
        const items: ChatParticipant[] = assignments.map(item => ({ agentId: item.agentId, name: item.card.name, slug: item.card.slug,
            status: item.removed ? 'removed' : item.enabled ? 'active' : 'disabled',
            ...(!item.enabled || item.removed ? { reason: 'Агент выключен или удалён из проекта.' } : {}) }));
        const actor = await this.models.actor(req);
        if (projectLevel(actor.claims, actor.activeRole, projectId) < 2) return items;
        if (!room.model_id || !room.model_pin) return items;
        try {
            const model = await this.base(req, projectId, room.model_id, room.model_pin, db);
            return (await this.group(db).roster(req, projectId, model, db)).items;
        } catch {
            // Missing model permissions or readiness cannot make shared human history unavailable.
            return items.map(item => item.status === 'active' ? { ...item, status: 'blocked', reason: 'Проверьте модель и доступ к ней в настройках чата.' } : item);
        }
    }
    async resolve(req: Request, projectId: string, room: ProjectChatRoomRow, ids: string[], db: ProjectChatDb = this.models.pool): Promise<ChatAgentSnapshot[]> {
        if (!ids.length) return [];
        if (!room.model_id || !room.model_pin) throw new ConflictException('Администратор проекта должен выбрать модель и агентов в настройках чата.');
        const model = await this.base(req, projectId, room.model_id, room.model_pin, db);
        await db.query('SELECT agent_id FROM project_agents WHERE project_id=$1 AND agent_id=ANY($2::text[]) FOR SHARE', [projectId, ids]);
        return (await this.group(db).plan(req, this.scope(projectId, room.agent_ids, model), model, ids, db)).map(item => item.snapshot);
    }
    async assert(req: Request, projectId: string, snapshot: ChatAgentSnapshot, db: ProjectChatDb = this.models.pool): Promise<void> {
        const model = await this.base(req, projectId, snapshot.modelId, snapshot.modelPin, db);
        await db.query('SELECT agent_id FROM project_agents WHERE project_id=$1 AND agent_id=$2 FOR SHARE', [projectId, snapshot.agentId]);
        const current = (await this.group(db).plan(req, this.scope(projectId, [snapshot.agentId], model), model, [snapshot.agentId], db))[0];
        if (!isDeepStrictEqual(current.snapshot, snapshot)) throw new ConflictException('Профиль или модель агента изменились. Проверьте настройки перед повтором.');
    }
    async transport(req: Request, projectId: string, snapshot: ChatAgentSnapshot, db: ProjectChatDb = this.models.pool): Promise<ProjectChatTransport> {
        return (await this.base(req, projectId, snapshot.modelId, snapshot.modelPin, db)).runtime === 'device-codex' ? 'device-codex' : 'server';
    }
    async infer({ req, projectId, source, response, signal }: Parameters<ProjectChatInference['infer']>[0]) {
        const snapshot = response.snapshot;
        if (!snapshot || source.project_id !== projectId || response.project_id !== projectId || response.source_message_id !== source.id || (source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM) !== (response.room_id ?? DEFAULT_PROJECT_CHAT_ROOM)) throw new ConflictException('Ответ относится к другому сообщению проекта.');
        const actor = await this.models.actor(req);
        if (actor.email !== source.author_email) throw new ConflictException('Автор принятого запроса изменился.');
        const learning = await this.groups.learning.prepare(req, { project_id: projectId, owner_email: actor.email }, snapshot.agentId, signal);
        let privateRoomId: string | undefined;
        const authorize = async (beforeCall = true) => {
            signal.throwIfAborted(); await this.assert(req, projectId, snapshot);
            if (beforeCall) await learning.beforeInference(); else await learning.assertAuthorized();
            const room = (await this.models.pool.query<ProjectChatRoomRow>('SELECT * FROM project_chat_rooms WHERE project_id=$1 AND id=$2', [projectId, source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM])).rows[0];
            if (!room) throw new ConflictException('Диалог недоступен.');
            await assertProjectChatRoomAccess(this.models.pool, room, actor.email);
            privateRoomId = room.visibility === 'PRIVATE' ? source.room_id : undefined;
            if (!room?.agent_ids.includes(snapshot.agentId)) throw new ConflictException('Агент исключён из общей комнаты. Готовые ответы сохранены.');
            const active = await this.models.pool.query(`SELECT 1 FROM project_chat_messages s JOIN project_chat_messages r ON r.project_id=s.project_id AND r.room_id=s.room_id AND r.source_message_id=s.id
                WHERE s.project_id=$1 AND s.id=$2 AND r.id=$3 AND s.generation=$4 AND r.generation=$4
                AND s.status='running' AND r.status='running' AND s.lease_until>now() AND r.lease_until>now()`,
                [projectId, source.id, response.id, response.generation]);
            if (!active.rowCount) throw new ConflictException('Обработка этого сообщения уже остановлена или завершена.');
            signal.throwIfAborted();
        };
        await authorize();
        const model = await this.base(req, projectId, snapshot.modelId, snapshot.modelPin), settings = await this.settings(model);
        const ancestors = await this.ancestors(projectId, source);
        let messages=projectChatContext(snapshot.definition.prompt,source,ancestors,learning.messages,settings);
        let toolsCurrent:()=>Promise<void>=()=>authorize(false);
        if(source.agent_tools_request){
            if(!this.agentTools)throw new BadRequestException('Инструменты агентов недоступны.');
            if(chatContext([...agentToolContext(projectId,source.agent_tools_request),...messages],settings).exceeded)throw new BadRequestException('Сообщение и инструменты не помещаются в окно модели.');
            await this.agentTools.admit(req,projectId,source.agent_tools_request);
            const none={status:'none' as const,sources:[]};
            const project:PreparedProjectContext=source.agent_tools_request.rag?await withModelUsage({purpose:'project-search',actorEmail:actor.email,actorRole:actor.activeRole,projectId,turnId:source.id,agentId:snapshot.agentId,privateProjectChatRoomId:privateRoomId,requiredFeatures:['project_agent_tools'],beforeInference:()=>authorize()},()=>new ModelChatProjectContext(this.models,this.runtime).prepare(req,projectId,source.content,signal,()=>authorize())):{messages:[],evidence:none,requiredFeatures:[],assertCurrent:()=>authorize(false),beforeInference:()=>authorize(),fit:history=>({messages:history,evidence:none})};
            const fitted=project.fit(messages,settings);
            const toolResult=await this.agentTools.run(req,{owner:{kind:'project-chat',originId:source.room_id??DEFAULT_PROJECT_CHAT_ROOM,turnId:source.id,recipientId:response.id,generation:response.generation,ownerEmail:actor.email,actorRole:actor.activeRole,projectId,agentId:snapshot.agentId,modelId:model.id,modelPin:projectEmbeddingPin(model),grant:source.agent_tools_request},messages:fitted.messages,settings,signal,assertCurrent:()=>authorize(false)},project,source.content);
            messages=toolResult.messages;toolsCurrent=()=>toolResult.assertCurrent();
        }
        const options = automaticModelOptions(model,{}, { ...(snapshot.definition.temperature === undefined ? {} : { temperature: snapshot.definition.temperature }),
            ...(snapshot.definition.topP === undefined ? {} : { top_p: snapshot.definition.topP }),
            ...(model.runtime === 'ollama' && this.localContextWindow !== null ? { num_ctx: this.localContextWindow } : {}) });
        const result = await withModelUsage({ purpose: 'agent', privateProjectChatRoomId: privateRoomId, actorEmail: actor.email,actorRole:actor.activeRole, projectId, agentId: snapshot.agentId,
            turnId: source.id, operationId: response.id, requiredFeatures: ['project_chat', 'group_chat', ...((source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM) === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const]), ...learning.requiredFeatures,...(source.agent_tools_request?['project_agent_tools' as const]:[])], beforeInference: async() => {await toolsCurrent();await authorize();} },
            () => this.runtime.infer(model, 'chat', modelInferenceBody('chat', { messages, stream: false, options }), signal));
        await authorize(false);await toolsCurrent();
        const message = result.message as Record<string, unknown> | undefined;
        if (!message || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()
            || Buffer.byteLength(message.content) > 128 * 1024 || !['stop', 'length'].includes(String(result.done_reason))) throw new BadRequestException('Агент не вернул допустимый ответ. Остальные ответы и сообщения сохранены.');
        return { content: message.content + (result.done_reason === 'length' ? '\n\n[Ответ ограничен лимитом модели. Можно задать уточняющий вопрос.]' : ''), usage: chatUsage(result), learning: learning.receipt };
    }
    private group(db: ProjectChatDb): ChatGroup { return new ChatGroup(projectChatModels(this.models, db), this.assignments); }
    private async base(req: Request, projectId: string, id: string, pin: string, db: ProjectChatDb = this.models.pool): Promise<IModel> {
        const model = await projectChatModels(this.models, db).getUsable(id, req, projectId);
        if (model.capability === 'embedding' || !(model.runtime === 'ollama' ? model.manifestSha256 : model.verificationSha256) || projectEmbeddingPin(model) !== pin) throw new ConflictException('Модель чата изменилась или недоступна. Проверьте настройки.');
        return model;
    }
    private scope(projectId: string, ids: string[], model: IModel): ConversationRow {
        return { id: projectId, owner_email: '', project_id: projectId, model_id: model.id, model_pin: projectEmbeddingPin(model),
            mode: 'group', agent_ids: ids, title: '', revision: 0, created_at: '', updated_at: '' };
    }
    private async settings(model: IModel): Promise<IChatContextSettings> {
        if (model.runtime === 'ollama') return { contextWindowTokens: this.localContextWindow };
        const row={options:await modelPlanningOptions(this.models.pool,model)};
        return { contextWindowTokens: row?.options.contextWindow ?? null, reservedOutputTokens: row?.options.maxOutputTokens ?? null };
    }
    private async ancestors(projectId: string, source: ProjectChatMessageRow): Promise<ProjectChatMessageRow[]> {
        const rows: ProjectChatMessageRow[] = [], visited = new Set<string>(); let id = source.reply_to_id;
        while (id && visited.size < 8 && !visited.has(id)) {
            visited.add(id);
            const row = (await this.models.pool.query<ProjectChatMessageRow>('SELECT * FROM project_chat_messages WHERE project_id=$1 AND id=$2 AND position<$3 AND room_id=$4', [projectId, id, source.position, source.room_id ?? DEFAULT_PROJECT_CHAT_ROOM])).rows[0];
            if (!row) break;
            if (row.content && (row.kind === 'user' || row.kind === 'agent' && row.status === 'done')) rows.push(row);
            id = row.reply_to_id;
        }
        return rows.reverse();
    }
}
