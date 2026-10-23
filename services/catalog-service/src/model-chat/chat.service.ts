import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnApplicationShutdown, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { createPool } from '../database/pool';
import { ModelsService } from '../models/models.service';
import { ModelRuntime } from '../models/model-runtime';
import type { IModel } from '../models/model.types';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { modelInferenceBody } from '../models/inference.controller';
import { requireFeatureEnabled, requireFeaturesEnabled } from '../features/require-feature-enabled';
import { withModelUsage, currentModelUsage } from '../model-usage/model-usage.context';
import { assertPendingChatInference } from './chat-inference-admission';
import { ProjectAgentRepository } from '../agents/project-agent.repository';
import { extractChatDocument } from './chat-document-extractor';
import { chatContext, chatUsage, managedChatContextWindow, type IChatContextSettings, type IChatContext } from './chat-context';
import { canCompact, chatSources, compactionBatch, COMPACTION_CALL_LIMIT, needsCompaction, projection } from './chat-compaction';
import { ChatAttachmentStorage } from './chat-attachment-storage';
import { ChatGroup, chatAgentIds } from './chat-group';
import { unknownGroupUsage, type ChatRoundBudget } from './chat-group.types';
import { executeChatRound, finishChatRound } from './chat-round';
import { prepareChatRound } from './chat-round-preflight';
import { ModelChatProjectContext } from './chat-project-context';
import { ChatResearchExecutor } from './chat-research';
import { ChatResearchRepository } from './chat-research.repository';
import { ChatResearchTools } from './chat-research-tools';
import { researchRequest as chatResearchInput } from './chat-research-input';
import type { ChatResearchRequest } from './chat-research.types';
import { researchEvidence } from './chat-research-evidence';
import { ChatRepository, type ChatDb, type ChatRows } from './chat.repository';
import { attachmentView, conversationView, turnView, type AttachmentRow, type ChatDetail, type ChatMessage, type TurnRow, type ConversationRow } from './chat.types';
import { CHAT_TEXT_BYTES, chatAttachmentIds, chatBody, chatChanged, chatHash, chatPin, chatPrompt, chatRevision, chatTitle, chatUpload, chatUuid } from './chat-validation';

/** Personal history and document text stay behind current model/project permissions. */
@Injectable()
export class ModelChatService implements OnModuleInit, OnApplicationShutdown {
    private readonly localContextWindow = managedChatContextWindow();
    readonly pool = createPool({ connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 5 }, 'model-chat');
    readonly repository = new ChatRepository(this.pool);
    readonly groups: ChatGroup;
    readonly researchReceipts = new ChatResearchRepository(this.pool);
    private get researchTools() { return new ChatResearchTools(this.models, this.projectContext); }
    projectContext: ModelChatProjectContext;
    storage = new ChatAttachmentStorage(this.pool);
    private readonly active = new Map<string, { conversationId: string; requestId: string; abort: AbortController }>();
    constructor(private readonly models: ModelsService, private readonly runtime: ModelRuntime) { this.groups = new ChatGroup(models, new ProjectAgentRepository(this.pool)); this.projectContext = new ModelChatProjectContext(models, runtime); }
    async onModuleInit(): Promise<void> { await this.models.ready(); await this.storage.initialize(); }
    async onApplicationShutdown(): Promise<void> { for (const value of this.active.values()) value.abort.abort(); await this.storage.close(); await this.pool.end(); }

    private async scope(req: Request, id: string) {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Личные диалоги доступны пользователю в интерфейсе.');
        const actor = await this.models.actor(req), row = await this.repository.peek(actor.email, chatUuid(id));
        const authorize = async (pin = false): Promise<IModel> => {
            const current = await this.models.actor(req);
            if (current.email !== actor.email) throw new ForbiddenException('Владелец диалога изменился.');
            const model = await this.models.getUsable(row.model_id, req, row.project_id ?? undefined);
            if (pin && projectEmbeddingPin(model) !== row.model_pin) throw new ConflictException('Модель или её параметры изменились. Начните новый диалог.');
            return model;
        };
        const model = await authorize(); return { owner: actor.email, row, model, authorize };
    }
    async list(req: Request, modelId?: string, projectId?: string) {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Личные диалоги доступны пользователю в интерфейсе.');
        const actor = await this.models.actor(req);
        if (!['Главный админ', 'Админ проекта', 'Разработчик'].includes(actor.activeRole)) throw new ForbiddenException('Для личных диалогов нужна рабочая роль.');
        if (modelId !== undefined && (typeof modelId !== 'string' || !modelId || modelId.length > 256)) throw new BadRequestException('Некорректный фильтр модели.');
        if (projectId !== undefined) projectId = (await this.models.resolveProject(req, projectId, 2, actor)).id;
        if (modelId !== undefined) await this.models.getUsable(modelId, req, projectId);
        const rows = await this.repository.list(actor.email, modelId, projectId ?? null);
        const visible = new Set<string>();
        for (const id of new Set(rows.map(row => row.model_id))) {
            try { await this.models.getUsable(id, req, projectId); visible.add(id); }
            catch (cause) { if (!(cause instanceof ForbiddenException) && !(cause instanceof NotFoundException)) throw cause; }
        }
        const current = await this.models.actor(req);
        if (current.email !== actor.email || current.activeRole !== actor.activeRole || JSON.stringify(current.claims) !== JSON.stringify(actor.claims)) throw new ForbiddenException('Права изменились. Обновите список диалогов.');
        if (projectId !== undefined) await this.models.resolveProject(req, projectId, 2, current);
        if (modelId !== undefined) await this.models.getUsable(modelId, req, projectId);
        return { items: rows.filter(row => visible.has(row.model_id)).map(conversationView) };
    }
    async create(req: Request, raw: unknown): Promise<ChatDetail> {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Личные диалоги доступны пользователю в интерфейсе.');
        const body = chatBody(raw, ['modelId', 'projectId', 'expectedModelPin', 'title', 'mode', 'agentIds']);
        const mode = body.mode ?? 'model';
        if (mode !== 'model' && mode !== 'group') throw new BadRequestException('Выберите обычный или групповой диалог.');
        const agentIds = mode === 'group' ? chatAgentIds(body.agentIds) : [];
        if (mode === 'model' && body.agentIds !== undefined) throw new BadRequestException('Участники добавляются в групповой диалог.');
        if (mode === 'group' && body.projectId === undefined) throw new BadRequestException('Групповому диалогу нужен проект.');
        if (typeof body.modelId !== 'string' || body.projectId !== undefined && typeof body.projectId !== 'string') throw new BadRequestException('Выберите модель и проект.');
        const actor = await this.models.actor(req), modelId = body.modelId,
            projectId = body.projectId === undefined ? undefined : (await this.models.resolveProject(req, body.projectId, 2, actor)).id, pin = chatPin(body.expectedModelPin);
        const authorize = async (): Promise<IModel> => {
            const model = await this.models.getUsable(modelId, req, projectId);
            if (model.capability === 'embedding') throw new BadRequestException('Embedding-модель не поддерживает диалог.');
            if (projectEmbeddingPin(model) !== pin) throw new ConflictException('Модель изменилась. Обновите каталог.');
            if (model.runtime === 'ollama' ? !model.manifestSha256 : !model.verificationSha256) throw new ConflictException('Сначала проверьте подключение модели.');
            return model;
        };
        const model = await authorize(); await requireFeaturesEnabled([mode === 'group' ? 'group_chat' : 'model_chat']);
        const groupRow = { mode, agent_ids: agentIds, project_id: projectId } as ConversationRow;
        if (mode === 'group') await this.groups.plan(req, groupRow, model);
        const row = await this.repository.create(actor.email, modelId, projectId ?? null, pin, body.title === undefined ? 'Новый диалог' : chatTitle(body.title), async db => {
            const model = await authorize(); if (mode === 'group') await this.groups.plan(req, groupRow, model, undefined, db); return model;
        }, { mode, agentIds });
        return this.read(req, row.id);
    }
    async agents(req: Request, modelId: string, projectId?: string) {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Личные диалоги доступны пользователю в интерфейсе.');
        if (!projectId) throw new BadRequestException('Выберите проект для группы.');
        const project = await this.models.resolveProject(req, projectId, 2), model = await this.models.getUsable(modelId, req, project.id);
        return { items: (await this.groups.roster(req, project.id, model)).items };
    }
    async chatAgents(req: Request, id: string) { const scope = await this.scope(req, id); return this.agents(req, scope.row.model_id, scope.row.project_id ?? undefined); }
    async participants(req: Request, id: string, raw: unknown): Promise<ChatDetail> {
        const body = chatBody(raw, ['expectedRevision', 'agentIds']), revision = chatRevision(body.expectedRevision), ids = chatAgentIds(body.agentIds, true), scope = await this.scope(req, id);
        await this.repository.owned(scope.owner, id, () => scope.authorize(), async (db, row) => {
            this.repository.revision(row, revision);
            if (!row.project_id) throw new BadRequestException('Агенты добавляются в диалог выбранного проекта.');
            if (row.mode !== 'group' && !ids.length) throw new BadRequestException('Выберите хотя бы одного агента для этого диалога.');
            const tail = await this.repository.tail(db, id); if (tail?.status === 'pending') throw new ConflictException('Дождитесь завершения раунда перед изменением участников.');
            if (row.mode !== 'group' && tail && tail.status !== 'done') throw new ConflictException('Сначала завершите или измените последнее прерванное сообщение.');
            if (ids.some(agentId => !row.agent_ids.includes(agentId)) || row.mode !== 'group') await requireFeaturesEnabled(['group_chat']);
            if (ids.length) await this.groups.plan(req, { ...row, mode: 'group', agent_ids: ids }, await scope.authorize(), undefined, db);
            await db.query("UPDATE model_chat_conversations SET mode='group',agent_ids=$2 WHERE id=$1", [id, ids]); await this.repository.bump(db, row);
        }); return this.read(req, id);
    }
    async read(req: Request, id: string): Promise<ChatDetail> {
        const scope = await this.scope(req, id);
        return this.repository.owned(scope.owner, scope.row.id, () => scope.authorize(), async (db, row) => this.detail(req, await this.repository.rows(db, row), await scope.authorize(), db));
    }
    async history(req: Request, id: string, before?: string, rawLimit?: string) {
        if (before !== undefined) chatUuid(before);
        const limit = rawLimit === undefined ? 50 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('Размер страницы истории: от 1 до 50 сообщений.');
        const scope = await this.scope(req, id);
        return this.repository.owned(scope.owner, id, () => scope.authorize(), async (db, row) => {
            const page = await this.repository.rows(db, row, before, limit, false);
            return { turns: await this.viewTurns(db, row.id, page.turns), attachments: page.attachments.map(attachmentView), history: page.history };
        });
    }
    async availableResearch(req: Request, modelId: string, projectId?: string) {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Личные диалоги доступны пользователю в интерфейсе.');
        if (!projectId || typeof modelId !== 'string') throw new BadRequestException('Выберите модель и проект для исследования.');
        const project = await this.models.resolveProject(req, projectId, 2), model = await this.models.getUsable(modelId, req, project.id);
        if (model.capability === 'embedding') throw new BadRequestException('Embedding-модель не поддерживает исследование в диалоге.');
        const result = await this.researchTools.choices(req, { project_id: project.id } as ConversationRow);
        await this.models.getUsable(modelId, req, project.id); return result;
    }
    async researchChoices(req: Request, id: string) {
        const scope = await this.scope(req, id);
        return this.repository.owned(scope.owner, id, () => scope.authorize(), async (_db, row) => this.researchTools.choices(req, row));
    }
    async researchStep(req: Request, id: string, stepId: string) {
        chatUuid(stepId); const scope = await this.scope(req, id);
        return this.repository.owned(scope.owner, id, () => scope.authorize(), db => this.researchReceipts.get(db, id, stepId));
    }
    async researchHistory(req: Request, id: string, turnId: string, before?: string, rawLimit?: string) {
        chatUuid(turnId); if (before !== undefined) chatUuid(before);
        const limit = rawLimit === undefined ? 50 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Размер страницы исследования: от 1 до 100 шагов.');
        const scope = await this.scope(req, id);
        return this.repository.owned(scope.owner, id, () => scope.authorize(), db => this.researchReceipts.history(db, id, turnId, {before, limit}));
    }
    private async researchAllowed(req: Request, row: ConversationRow, request: ChatResearchRequest | null | undefined, db?: ChatDb): Promise<void> {
        if (!request) return;
        await requireFeaturesEnabled(['research_tools', ...(request.project ? ['project_search' as const] : []), ...(request.external ? ['tool_catalog' as const] : [])]);
        if (request.project) { const choices = await this.researchTools.choices(req, row); if (!choices.project.available) throw new ConflictException(choices.project.reason); }
        if (request.external) await this.researchTools.resolve(req, row, request.external, db);
    }
    private async viewTurns(db: ChatDb, id: string, turns: TurnRow[]) {
        const steps = turns.some(turn => turn.research_request) ? await this.researchReceipts.list(db, id, turns.map(turn => turn.id)) : [];
        return turns.map(turn => ({ ...turnView(turn), ...(turn.research_request ? { researchSteps: steps.filter(step => step.turnId === turn.id) } : {}) }));
    }
    async rename(req: Request, id: string, raw: unknown): Promise<ChatDetail> {
        const body = chatBody(raw, ['expectedRevision', 'title']), revision = chatRevision(body.expectedRevision), title = chatTitle(body.title), scope = await this.scope(req, id);
        await this.repository.owned(scope.owner, scope.row.id, () => scope.authorize(), async (db, row) => {
            this.repository.revision(row, revision); await db.query('UPDATE model_chat_conversations SET title=$2 WHERE id=$1', [id, title]); await this.repository.bump(db, row);
        }); return this.read(req, id);
    }
    async remove(req: Request, id: string, raw: unknown): Promise<{ deleted: true }> {
        const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id);
        await this.repository.owned(scope.owner, scope.row.id, () => scope.authorize(), async (db, row) => { this.repository.revision(row, revision); await db.query('DELETE FROM model_chat_conversations WHERE id=$1', [id]); });
        for (const value of this.active.values()) if (value.conversationId === id) value.abort.abort();
        return { deleted: true };
    }
    async upload(req: Request, id: string, raw: unknown, signal?: AbortSignal): Promise<ChatDetail> {
        const input = chatUpload(raw), scope = await this.scope(req, id);
        const prior = await this.repository.owned(scope.owner, id, () => scope.authorize(), async db => this.repository.priorAttachment(db, id, input.requestId));
        if (prior) { this.sameUpload(prior, input.hash); return this.read(req, id); }
        await requireFeaturesEnabled([scope.row.mode === 'group' ? 'group_chat' : 'model_chat']);
        signal?.throwIfAborted();
        const extracted = await extractChatDocument(input.name, input.bytes, signal);
        if (!extracted.text.trim() || extracted.text.includes('\0') || Buffer.byteLength(extracted.text) > CHAT_TEXT_BYTES) throw new BadRequestException('Документ не содержит доступного текста или превышает 100 КиБ извлечённого текста. Разделите его на части.');
        const object = await this.storage.stage({ ownerEmail: scope.owner, projectId: scope.row.project_id, conversationId: id, bytes: input.bytes, mediaType: extracted.mediaType }, signal);
        try {
            await this.repository.owned(scope.owner, id, () => scope.authorize(), async (db, row) => {
                signal?.throwIfAborted(); const repeated = await this.repository.priorAttachment(db, id, input.requestId);
                if (repeated) { this.sameUpload(repeated, input.hash); return; }
                await this.repository.addAttachment(db, row, { ...input, ...extracted, objectId: object.id }); await this.storage.activate(db, object); signal?.throwIfAborted();
            });
        } finally { await this.storage.abandon(object).catch(() => undefined); }
        return this.read(req, id);
    }
    private sameUpload(row: AttachmentRow, hash: string): void {
        if (row.request_hash !== hash || row.deleted_at) throw new ConflictException('Этот запрос загрузки уже использован. Выберите файл повторно.');
    }
    async attachment(req: Request, id: string, attachmentId: string) {
        const scope = await this.scope(req, id); chatUuid(attachmentId);
        return this.repository.owned(scope.owner, id, () => scope.authorize(), async db => { const row = await this.repository.attachment(db, id, attachmentId); return { attachment: attachmentView(row), text: row.text }; });
    }
    async removeAttachment(req: Request, id: string, attachmentId: string, raw: unknown): Promise<ChatDetail> {
        const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id); chatUuid(attachmentId);
        await this.repository.owned(scope.owner, id, () => scope.authorize(), async (db, row) => {
            this.repository.revision(row, revision); await this.repository.attachment(db, id, attachmentId);
            const linked = await db.query('SELECT 1 FROM model_chat_turns WHERE conversation_id=$1 AND removed_at IS NULL AND $2::uuid=ANY(attachment_ids)', [id, attachmentId]);
            if (linked.rowCount) throw new ConflictException('Файл используется сообщением. Его содержимое сохраняется вместе с историей диалога.');
            await db.query("UPDATE model_chat_attachments SET object_id=NULL,storage_state='DELETED',text='',text_bytes=0,deleted_at=now() WHERE id=$1 AND conversation_id=$2", [attachmentId, id]); await this.repository.bump(db, row);
        }); return this.read(req, id);
    }
    async preview(req: Request, id: string, raw: unknown) {
        const body = chatBody(raw, ['prompt', 'attachmentIds', 'targetAgentIds']), prompt = chatPrompt(body.prompt ?? '', true), ids = chatAttachmentIds(body.attachmentIds ?? []), scope = await this.scope(req, id);
        const targets = body.targetAgentIds === undefined ? undefined : chatAgentIds(body.targetAgentIds, true);
        return this.repository.owned(scope.owner, id, () => scope.authorize(), async (db, row) => {
            return this.contextFor(req, db, row, await scope.authorize(), prompt || ids.length ? await this.inputText(db, id, prompt, ids) : undefined, targets);
        });
    }
    async send(req: Request, id: string, raw: unknown, signal: AbortSignal): Promise<ChatDetail> {
        const body = chatBody(raw, ['expectedRevision', 'requestId', 'prompt', 'attachmentIds', 'expectedModelPin', 'targetAgentIds', 'research']), revision = chatRevision(body.expectedRevision), requestId = chatUuid(body.requestId),
            prompt = chatPrompt(body.prompt, true), ids = chatAttachmentIds(body.attachmentIds ?? []), pin = chatPin(body.expectedModelPin), scope = await this.scope(req, id),
            targets = body.targetAgentIds === undefined ? [] : chatAgentIds(body.targetAgentIds, true), research = chatResearchInput(body.research, scope.row.project_id),
            values = scope.row.mode === 'group' ? [prompt, ids, targets] : [prompt, ids], hash = chatHash(research ? [...values, research] : values);
        if (scope.row.mode !== 'group' && targets.length) throw new BadRequestException('Адресаты доступны в групповом диалоге.');
        if (!prompt.trim() && !ids.length) throw new BadRequestException('Введите сообщение или прикрепите документ.');
        const prepared = await this.repository.owned(scope.owner, id, () => scope.authorize(true), async (db, row) => {
            if (row.model_pin !== pin) throw chatChanged();
            const repeated = await this.repository.priorTurn(db, id, requestId);
            if (repeated) { if (repeated.request_hash !== hash || repeated.removed_at) throw new ConflictException('Идентификатор запроса уже использован другим сообщением.'); return null; }
            await requireFeaturesEnabled([row.mode === 'group' ? 'group_chat' : 'model_chat']);
            await this.researchAllowed(req, row, research, db);
            signal.throwIfAborted(); this.repository.revision(row, revision);
            const tail = await this.repository.tail(db, id); this.requireResolved(tail ? [tail] : []);
            const model = await scope.authorize(true), text = await this.inputText(db, id, prompt, ids), context = await this.contextFor(req, db, row, model, text, targets);
            if (context.exceeded) throw new BadRequestException(context.reason || 'Сообщение не помещается в доступный контекст.');
            const plan = row.mode === 'group' ? await this.groups.plan(req, row, model, targets, db) : [];
            const turn = await this.repository.addTurn(db, row, { requestId, hash, prompt, attachmentIds: ids, text, research, targetAgentIds: plan.map(agent => agent.snapshot.agentId) });
            if (plan.length) await this.groups.add(db, row, turn, plan);
            await this.repository.stage(db, row, turn, context.compactionNeeded ? 'compacting' : 'responding');
            return { turn };
        });
        if (!prepared) return this.read(req, id);
        return this.execute(req, scope, prepared.turn, signal);
    }
    async retry(req: Request, id: string, turnId: string, raw: unknown, signal: AbortSignal): Promise<ChatDetail> {
        chatUuid(turnId);
        const body = chatBody(raw, ['expectedRevision', 'expectedModelPin', 'requestId']), revision = chatRevision(body.expectedRevision), requestId = chatUuid(body.requestId), pin = chatPin(body.expectedModelPin), scope = await this.scope(req, id);
        const prepared = await this.repository.owned(scope.owner, id, () => scope.authorize(true), async (db, row) => {
            if (row.model_pin !== pin) throw chatChanged();
            const repeated = await this.repository.priorTurn(db, id, requestId);
            if (repeated) { if (repeated.id !== turnId || repeated.removed_at) throw new ConflictException('Этот запрос повторения уже использован.'); return null; }
            await requireFeaturesEnabled([row.mode === 'group' ? 'group_chat' : 'model_chat']);
            signal.throwIfAborted(); this.repository.revision(row, revision);
            const tail = await this.repository.tail(db, id);
            if (!tail || tail.id !== turnId || !['failed', 'cancelled'].includes(tail.status)) throw new ConflictException('Повторить можно последнее прерванное сообщение.');
            await this.researchAllowed(req, row, tail.research_request, db);
            if (tail.request_ids.length >= 100) throw new ConflictException('Достигнут предел повторов. Начните новый диалог.');
            const unfinished = row.mode === 'group' ? (await this.groups.responses(db, id, [turnId])).filter(response => response.status !== 'done').map(response => response.agent_id) : [];
            const context = await this.contextFor(req, db, row, await scope.authorize(true), undefined, unfinished.length ? unfinished : tail.target_agent_ids);
            if (context.exceeded) throw new BadRequestException(context.reason || 'Сообщение не помещается в доступный контекст.');
            const turn = (await db.query<TurnRow>("UPDATE model_chat_turns SET request_id=$3,request_ids=array_append(request_ids,$3::uuid),status='pending',error=NULL,lease_until=now()+interval '20 minutes' WHERE conversation_id=$1 AND id=$2 RETURNING *", [id, turnId, requestId])).rows[0];
            if (row.mode === 'group') await this.groups.retry(db, id, turn);
            await this.repository.stage(db, row, turn, context.compactionNeeded ? 'compacting' : 'responding');
            await this.repository.bump(db, row); return { turn };
        });
        if (!prepared) return this.read(req, id); return this.execute(req, scope, prepared.turn, signal);
    }
    async cancel(req: Request, id: string, turnId: string, raw: unknown): Promise<ChatDetail> {
        chatUuid(turnId); const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id);
        const cancelledRequest = await this.repository.owned(scope.owner, id, () => scope.authorize(), async (db, row) => {
            this.repository.revision(row, revision);
            const changed = await db.query<{ request_id: string }>("UPDATE model_chat_turns SET status='cancelled',error='Запрос остановлен.',lease_until=NULL WHERE conversation_id=$1 AND id=$2 AND status='pending' AND removed_at IS NULL RETURNING request_id", [id, turnId]);
            if (!changed.rowCount) throw new ConflictException('Запрос уже завершён. Обновите диалог.'); await this.repository.bump(db, row);
            await db.query("UPDATE model_chat_agent_responses SET status='cancelled',error='Раунд остановлен.',updated_at=now() WHERE conversation_id=$1 AND turn_id=$2 AND status='pending'", [id, turnId]);
            return changed.rows[0].request_id;
        }); const active = this.active.get(turnId); if (active?.requestId === cancelledRequest) active.abort.abort(); return this.read(req, id);
    }
    async removeTurn(req: Request, id: string, turnId: string, raw: unknown): Promise<ChatDetail> {
        chatUuid(turnId); const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id);
        await this.repository.owned(scope.owner, id, () => scope.authorize(), async (db, row) => {
            this.repository.revision(row, revision); const tail = await this.repository.tail(db, id);
            if (!tail || tail.id !== turnId || !['failed', 'cancelled'].includes(tail.status)) throw new ConflictException('Изменить можно последнее прерванное сообщение.');
            if ((await this.groups.responses(db, id, [turnId])).some(response => response.status === 'done')) throw new ConflictException('Полученные ответы сохраняются. Продолжите с готовыми ответами вместо удаления раунда.');
            await db.query("DELETE FROM model_chat_research_steps WHERE conversation_id=$1 AND turn_id=$2", [id, turnId]);
            await db.query("UPDATE model_chat_turns SET removed_at=now(),prompt='',input_text='',attachment_ids='{}' WHERE conversation_id=$1 AND id=$2", [id, turnId]); await this.repository.bump(db, row);
        }); return this.read(req, id);
    }
    async complete(req: Request, id: string, turnId: string, raw: unknown): Promise<ChatDetail> {
        chatUuid(turnId); const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id);
        await this.repository.owned(scope.owner, id, () => scope.authorize(), async (db, row) => {
            this.repository.revision(row, revision); const turn = await this.repository.tail(db, id);
            if (row.mode !== 'group' || !turn || turn.id !== turnId || !['failed', 'cancelled'].includes(turn.status)) throw new ConflictException('Завершить можно последний прерванный раунд.');
            const responses = await this.groups.partial(db, row, turn);
            if (!responses.some(response => response.status === 'done')) throw new ConflictException('Нет готовых ответов. Повторите или измените сообщение.');
            await db.query("UPDATE model_chat_turns SET status='done',answer=$3::jsonb,error=NULL,lease_until=NULL WHERE conversation_id=$1 AND id=$2", [id, turnId, JSON.stringify({ content: this.groups.aggregate(responses), finishReason: 'stop', usage: unknownGroupUsage() })]);
            await this.repository.bump(db, row);
        }); return this.read(req, id);
    }
    private async execute(req: Request, scope: Awaited<ReturnType<ModelChatService['scope']>>, turn: TurnRow, signal: AbortSignal): Promise<ChatDetail> {
        const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(15 * 60 * 1000)]);
        this.active.set(turn.id, { conversationId: scope.row.id, requestId: turn.request_id, abort });
        try {
            combined.throwIfAborted();
            const active = await this.repository.owned(scope.owner, scope.row.id, () => scope.authorize(true), async db => {
                const current = await this.repository.priorTurn(db, scope.row.id, turn.request_id);
                return !!current && current.status === 'pending' && current.request_id === turn.request_id && !current.removed_at;
            });
            if (!active) return this.read(req, scope.row.id);
            await requireFeaturesEnabled([scope.row.mode === 'group' ? 'group_chat' : 'model_chat', ...(turn.research_request ? ['research_tools' as const] : [])]);
            const research = new ChatResearchExecutor(this.repository, this.runtime, this.researchTools, this.projectContext);
            const beforeInference = async () => { await scope.authorize(true); await assertPendingChatInference(this.repository, scope.row.id, turn, combined); };
            const model = await scope.authorize(true), prepareProject = () => withModelUsage({ purpose: 'project-search', actorEmail: scope.owner, projectId: scope.row.project_id, turnId: turn.id, beforeInference, requiredFeatures: [scope.row.mode === 'group' ? 'group_chat' : 'model_chat', ...(turn.research_request ? ['research_tools' as const] : [])] }, () => this.projectContext.prepare(req, scope.row.project_id, turn.input_text, combined));
            if (scope.row.mode === 'group') {
                const prepared = await prepareChatRound(req, scope, turn, combined, this.groups, this.repository, model => this.settings(this.pool, model), research);
                if (!prepared.size) { await finishChatRound(scope, turn, combined, this.groups, this.repository); return this.read(req, scope.row.id); }
                const project = await prepareProject();
                await executeChatRound(req, scope, turn, combined, project, this.groups, this.repository, this.runtime, {
                    compact: (model, overhead, assertCurrent, budget, responseId, beforeInference) => this.compact(scope, turn, combined, model, overhead, assertCurrent, budget, responseId, beforeInference),
                    localContextWindow: this.localContextWindow, research,
                    researchBudget: { externalCalls: 0 }, prepared,
                }); return this.read(req, scope.row.id);
            }
            const project = await prepareProject(), settings = await this.settings(this.pool, model), minimal = project.fit([{ role: 'user', content: turn.input_text }], settings);
            const overhead = [...minimal.messages.slice(0, -1), ...research.overhead(turn.research_request)], history = await this.compact(scope, turn, combined, undefined, overhead, project.assertCurrent);
            const fitted = project.fit(history, settings), researched = await research.run({ req, owner: scope.owner, row: scope.row, turn, model,
                messages: fitted.messages, initialProjectSources: fitted.evidence.sources, settings, signal: combined, options: model.runtime === 'ollama' && this.localContextWindow !== null ? { num_ctx: this.localContextWindow } : {},
                budget: { externalCalls: 0 }, assertCurrent: async () => { await scope.authorize(true); await project.assertCurrent(); } });
            const messages = researched.messages; combined.throwIfAborted();
            await this.repository.owned(scope.owner, scope.row.id, researched.assertCurrent, (db, row) => this.repository.stage(db, row, turn, 'responding'));
            if (chatContext(messages, settings).exceeded) throw new BadRequestException('Контекст проекта и сообщение не помещаются в окно модели.');
            await requireFeatureEnabled('model_hosting'); if (turn.research_request) await requireFeatureEnabled('research_tools'); await researched.assertCurrent(); combined.throwIfAborted();
            const result = await withModelUsage({ purpose: 'chat', actorEmail: scope.owner, projectId: scope.row.project_id, turnId: turn.id, beforeInference: async () => { await beforeInference(); await researched.assertCurrent(); }, ...(turn.research_request ? { requiredFeatures: ['research_tools' as const] } : {}) }, () => this.runtime.infer(model, 'chat', modelInferenceBody('chat', { messages,
                ...(model.runtime === 'ollama' && this.localContextWindow !== null ? { options: { num_ctx: this.localContextWindow } } : {}), stream: false }), combined));
            combined.throwIfAborted(); await researched.assertCurrent();
            const message = result.message as Record<string, unknown> | undefined;
            if (!message || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim() || Buffer.byteLength(JSON.stringify(message.content)) > 8 * 1024 ** 2
                || !['stop', 'length'].includes(String(result.done_reason))) throw new Error('invalid-chat-response');
            await this.repository.owned(scope.owner, scope.row.id, researched.assertCurrent, async (db, row) => {
                combined.throwIfAborted(); await this.repository.finish(db, row, turn, { content: message.content as string, finishReason: result.done_reason as 'stop' | 'length', usage: chatUsage(result), evidence: researchEvidence(fitted.evidence, researched.projectSources), ...(researched.externalSources.length ? { researchSources: researched.externalSources } : {}), ...(researched.limitReached ? { researchLimited: true } : {}) });
            });
        } catch (error) {
            await this.repository.fail(scope.row.id, turn.id, turn.request_id, combined.aborted ? 'cancelled' : 'failed', combined.aborted ? 'Запрос остановлен. Можно повторить его.' : error instanceof BadRequestException || error instanceof ServiceUnavailableException || error instanceof ConflictException || error instanceof ForbiddenException && error.message.startsWith('Функция «') ? error.message : 'Модель не выполнила запрос. Проверьте подключение и повторите.');
            if (error instanceof ForbiddenException || error instanceof ConflictException) throw error;
        } finally { if (this.active.get(turn.id)?.abort === abort) this.active.delete(turn.id); }
        return this.read(req, scope.row.id);
    }
    private requireResolved(turns: TurnRow[]): void { if (turns.some(turn => turn.status !== 'done')) throw new ConflictException('Повторите, измените или остановите последнее сообщение.'); }
    /** Summarization and answer share the pending request lease; each paid batch has an immutable receipt. */
    private async compact(scope: Awaited<ReturnType<ModelChatService['scope']>>, turn: TurnRow, signal: AbortSignal, selectedModel?: IModel,
        overhead: ChatMessage[] = [], assertCurrent: (db?: ChatDb) => Promise<void> = async () => undefined, budget: ChatRoundBudget = { summaries: 0 }, responseId?: string, beforeInference?: () => Promise<void>): Promise<ChatMessage[]> {
        for (;;) {
            signal.throwIfAborted();
            const state = await this.repository.owned(scope.owner, scope.row.id, () => scope.authorize(true), async (db, row) => {
                const current = await this.repository.priorTurn(db, row.id, turn.request_id);
                if (!current || current.status !== 'pending' || current.request_id !== turn.request_id || current.removed_at) throw new ConflictException('Запрос уже остановлен или завершён.');
                const model = selectedModel ?? await scope.authorize(true), state = await this.state(db, row, model, undefined, overhead, selectedModel ? projectEmbeddingPin(model) : row.model_pin);
                await this.repository.stage(db, row, turn, state.context.compactionNeeded ? 'compacting' : 'responding');
                if (responseId) await db.query("UPDATE model_chat_agent_responses SET processing_stage=$4 WHERE id=$1 AND request_id=$2 AND status='pending' AND turn_id=$3", [responseId, turn.request_id, turn.id, state.context.compactionNeeded ? 'compacting' : 'responding']);
                return state;
            });
            if (state.context.exceeded) throw new BadRequestException(state.context.reason || 'Сообщение не помещается в окно модели. История сохранена.');
            if (!state.context.compactionNeeded) return state.messages;
            if (budget.summaries >= COMPACTION_CALL_LIMIT) throw new BadRequestException('Сохранён прогресс сжатия. Для большого диалога достигнут лимит восьми обработок за запрос; нажмите «Повторить», чтобы продолжить. Исходная история сохранена.');
            const batch = compactionBatch(state.checkpoint, state.sources, state.settings, turn.id, overhead);
            await requireFeatureEnabled('model_hosting'); if (turn.research_request) await requireFeatureEnabled('research_tools'); await scope.authorize(true); await assertCurrent(); const model = selectedModel ?? await scope.authorize(true); signal.throwIfAborted(); budget.summaries++;
            await beforeInference?.();
            const result = await withModelUsage({ purpose: 'compaction', actorEmail: scope.owner, projectId: scope.row.project_id, turnId: turn.id, beforeInference: async () => {
                await scope.authorize(true); await assertCurrent(); await beforeInference?.(); await assertPendingChatInference(this.repository, scope.row.id, turn, signal, responseId);
            }, requiredFeatures: [...(currentModelUsage().requiredFeatures ?? []), scope.row.mode === 'group' ? 'group_chat' : 'model_chat', ...(turn.research_request ? ['research_tools' as const] : [])] }, () => this.runtime.infer(model, 'chat', modelInferenceBody('chat', { messages: batch.messages, options: { num_predict: batch.maxOutputTokens,
                ...(model.runtime === 'ollama' && this.localContextWindow !== null ? { num_ctx: this.localContextWindow } : {}) }, stream: false }), signal));
            signal.throwIfAborted(); await scope.authorize(true); await assertCurrent();
            const message = result.message as Record<string, unknown> | undefined;
            if (!message || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim() || result.done_reason !== 'stop'
                || Buffer.byteLength(message.content) > Math.min(65536, batch.maxOutputTokens * 2)) throw new BadRequestException('Модель не смогла подготовить полное краткое резюме. История сохранена; можно повторить сжатие.');
            await this.repository.owned(scope.owner, scope.row.id, async db => { await scope.authorize(true); await assertCurrent(db); }, async (db, row) => {
                signal.throwIfAborted(); const current = await this.repository.priorTurn(db, row.id, turn.request_id);
                if (!current || current.status !== 'pending' || current.request_id !== turn.request_id || current.removed_at) throw new ConflictException('Запрос уже остановлен или завершён.');
                const currentState = await this.state(db, row, selectedModel ?? await scope.authorize(true), undefined, overhead, selectedModel ? projectEmbeddingPin(model) : row.model_pin);
                if (currentState.checkpoint?.id !== state.checkpoint?.id || compactionBatch(currentState.checkpoint, currentState.sources, currentState.settings, turn.id, overhead).digest !== batch.digest) throw chatChanged();
                await this.repository.saveCheckpoint(db, row, turn, state.checkpoint, batch, message.content as string, chatUsage(result), selectedModel ? projectEmbeddingPin(model) : row.model_pin);
            });
        }
    }
    private async state(db: ChatDb, row: ConversationRow, model: IModel, draft?: string, overhead: ChatMessage[] = [], modelPin = row.model_pin) {
        const checkpoint = await this.repository.checkpoint(db, row.id, modelPin), loaded = await this.repository.sources(db, row.id, checkpoint), settings = await this.settings(db, model), turns = loaded.turns;
        const sources = chatSources(turns, checkpoint), tail = turns.at(-1);
        // A separately fetched tail must never let a checkpoint jump over an omitted middle prefix.
        if (loaded.overflow && tail) for (const source of sources) if (source.turnId === tail.id) source.completed = false;
        let pendingTurnId = tail && tail.status !== 'done' ? tail.id : undefined;
        if (draft !== undefined) {
            pendingTurnId = 'draft';
            sources.push({ turnId: pendingTurnId, position: Number(tail?.position ?? 0) + 1, role: 'user', text: draft, offset: 0, end: draft.length, total: draft.length, completed: false });
        }
        const messages = projection(checkpoint, sources), raw = chatContext([...overhead, ...messages], settings), pending = sources.filter(source => source.turnId === pendingTurnId);
        raw.estimatedInputTokens += Math.ceil(loaded.omittedBytes / 2) + loaded.omittedMessages * 6;
        raw.messageCount += loaded.omittedMessages; raw.requestBytes += loaded.omittedRequestBytes;
        const single = chatContext([...overhead, ...projection(null, pending)], settings), eligible = canCompact(sources, pendingTurnId);
        const optionsBytes = model.runtime === 'ollama' && this.localContextWindow !== null ? Buffer.byteLength(JSON.stringify({ num_ctx: this.localContextWindow })) + 11 : 0;
        const needed = loaded.overflow || needsCompaction([...overhead, ...messages], settings) || raw.requestBytes + optionsBytes > raw.maxRequestBytes, compactable = !single.exceeded && (eligible || !!checkpoint && raw.exceeded);
        const context = { ...raw, canCompact: compactable, compactionNeeded: needed && compactable };
        if (single.exceeded) { context.exceeded = true; context.reason = single.reason; context.canCompact = false; context.compactionNeeded = false; }
        else if (needed && compactable) { context.exceeded = false; delete context.reason; }
        else if (loaded.overflow) { context.exceeded = true; context.reason = 'Не удалось подготовить безопасный контекст. Исходная история сохранена.'; }
        // A large new message alone may use >80% safely; there is no old material to squeeze further.
        return { checkpoint, sources, messages, settings, context };
    }
    private async inputText(db: ChatDb, id: string, prompt: string, ids: string[]): Promise<string> {
        const files: string[] = [];
        for (const aid of ids) { const file = await this.repository.attachment(db, id, aid); files.push(`\n\n[Вложение: ${file.name}; содержимое документа]\n${file.text}\n[Конец вложения]`); }
        const text = prompt + files.join('');
        if (Buffer.byteLength(text) > 128 * 1024) throw new BadRequestException('Сообщение вместе с текстом файлов превышает 128 КиБ. Прикрепите меньше файлов или разделите документ.'); return text;
    }
    private async settings(db: ChatDb, model: IModel): Promise<IChatContextSettings> {
        if (model.runtime === 'ollama') return { contextWindowTokens: this.localContextWindow };
        const row = (await db.query<{ options: { contextWindow?: number; maxOutputTokens?: number } }>('SELECT options FROM model_remote_connections WHERE model_id=$1 AND semantic_sha=$2 AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1', [model.id, model.verificationSha256 ?? null])).rows[0];
        return { contextWindowTokens: row?.options.contextWindow ?? null, reservedOutputTokens: row?.options.maxOutputTokens ?? null };
    }
    private async contextFor(req: Request, db: ChatDb, row: ConversationRow, model: IModel, draft?: string, targets?: string[], strict = true): Promise<IChatContext> {
        if (row.mode !== 'group') { if (targets?.length) throw new BadRequestException('Адресаты доступны в групповом диалоге.'); return (await this.state(db, row, model, draft)).context; }
        const plans = strict ? await this.groups.plan(req, row, model, targets, db)
            : (await this.groups.roster(req, row.project_id!, model, db)).resolved.filter(agent => row.agent_ids.includes(agent.snapshot.agentId));
        const participants: NonNullable<IChatContext['participants']> = [];
        for (const agent of plans) participants.push({ agentId: agent.snapshot.agentId, name: agent.snapshot.name, modelId: agent.model.id, modelName: agent.model.name,
            context: (await this.state(db, row, agent.model, draft, [{ role: 'system', content: agent.snapshot.definition.prompt }], agent.snapshot.modelPin)).context });
        const exceeded = participants.some(item => item.context.exceeded);
        const context = { ...(participants[0]?.context ?? chatContext([])), participants, contextWindowTokens: null, reservedOutputTokens: null,
            exceeded, canCompact: !exceeded && participants.some(item => item.context.canCompact), compactionNeeded: !exceeded && participants.some(item => item.context.compactionNeeded),
            estimatedInputTokens: Math.max(0, ...participants.map(item => item.context.estimatedInputTokens)), requestBytes: Math.max(0, ...participants.map(item => item.context.requestBytes)) };
        const blocked = participants.find(item => item.context.exceeded); if (blocked) context.reason = `${blocked.name}: ${blocked.context.reason}`; else delete context.reason;
        return context;
    }
    private async detail(req: Request, rows: ChatRows, model: IModel, db: ChatDb): Promise<ChatDetail> {
        const state = await this.state(db, rows.conversation, model), pending = rows.turns.find(turn => turn.status === 'pending'),
            checkpoint = rows.conversation.mode === 'group' ? await this.repository.checkpoint(db, rows.conversation.id) : state.checkpoint;
        return { conversation: conversationView(rows.conversation), turns: await this.viewTurns(db, rows.conversation.id, rows.turns), attachments: rows.attachments.map(attachmentView),
            participants: await this.groups.selected(req, rows.conversation, model, db), projectContext: await this.projectContext.overview(req, rows.conversation.project_id),
            history: rows.history, context: await this.contextFor(req, db, rows.conversation, model, undefined, undefined, false), compaction: { state: pending?.processing_stage === 'compacting' ? 'compacting' : checkpoint ? 'ready' : 'none',
                coveredTurns: await this.repository.covered(db, rows.conversation.id, checkpoint), ...(checkpoint ? { updatedAt: new Date(checkpoint.created_at).toISOString() } : {}) },
            blockedReason: projectEmbeddingPin(model) === rows.conversation.model_pin ? null : 'Модель или её параметры изменились. Начните новый диалог.' };
    }
}
