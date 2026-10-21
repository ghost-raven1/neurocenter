import { BadRequestException, ConflictException, ForbiddenException, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { createPool } from '../database/pool';
import { ModelsService } from '../models/models.service';
import { ModelRuntime } from '../models/model-runtime';
import type { IModel } from '../models/model.types';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { modelInferenceBody } from '../models/inference.controller';
import { requireFeatureEnabled } from '../features/require-feature-enabled';
import { extractChatDocument } from './chat-document-extractor';
import { chatContext, chatUsage, managedChatContextWindow, type IChatContextSettings } from './chat-context';
import { canCompact, chatSources, compactionBatch, COMPACTION_CALL_LIMIT, needsCompaction, projection } from './chat-compaction';
import { ChatAttachmentStorage } from './chat-attachment-storage';
import { ChatRepository, type ChatDb, type ChatRows } from './chat.repository';
import { attachmentView, conversationView, turnView, type AttachmentRow, type ChatDetail, type ChatMessage, type TurnRow, type ConversationRow } from './chat.types';
import { CHAT_TEXT_BYTES, chatAttachmentIds, chatBody, chatChanged, chatHash, chatPin, chatPrompt, chatRevision, chatTitle, chatUpload, chatUuid } from './chat-validation';

/** Personal history and document text stay behind current model/project permissions. */
@Injectable()
export class ModelChatService implements OnModuleInit, OnApplicationShutdown {
    private readonly localContextWindow = managedChatContextWindow();
    readonly pool = createPool({ connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 5 }, 'model-chat');
    readonly repository = new ChatRepository(this.pool);
    storage = new ChatAttachmentStorage(this.pool);
    private readonly active = new Map<string, { conversationId: string; requestId: string; abort: AbortController }>();
    constructor(private readonly models: ModelsService, private readonly runtime: ModelRuntime) {}
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
    async list(req: Request, modelId: string, projectId?: string) {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Личные диалоги доступны пользователю в интерфейсе.');
        const actor = await this.models.actor(req);
        if (projectId !== undefined) projectId = (await this.models.resolveProject(req, projectId, 2, actor)).id;
        await this.models.getUsable(modelId, req, projectId);
        const rows = await this.repository.list(actor.email, modelId, projectId ?? null);
        await this.models.getUsable(modelId, req, projectId); return { items: rows.map(conversationView) };
    }
    async create(req: Request, raw: unknown): Promise<ChatDetail> {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Личные диалоги доступны пользователю в интерфейсе.');
        const body = chatBody(raw, ['modelId', 'projectId', 'expectedModelPin', 'title']);
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
        await authorize();
        const row = await this.repository.create(actor.email, modelId, projectId ?? null, pin, body.title === undefined ? 'Новый диалог' : chatTitle(body.title), authorize);
        return this.read(req, row.id);
    }
    async read(req: Request, id: string): Promise<ChatDetail> {
        const scope = await this.scope(req, id);
        return this.repository.owned(scope.owner, scope.row.id, scope.authorize, async (db, row) => this.detail(await this.repository.rows(db, row), await scope.authorize(), db));
    }
    async history(req: Request, id: string, before?: string, rawLimit?: string) {
        if (before !== undefined) chatUuid(before);
        const limit = rawLimit === undefined ? 50 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('Размер страницы истории: от 1 до 50 сообщений.');
        const scope = await this.scope(req, id);
        return this.repository.owned(scope.owner, id, scope.authorize, async (db, row) => {
            const page = await this.repository.rows(db, row, before, limit, false);
            return { turns: page.turns.map(turnView), attachments: page.attachments.map(attachmentView), history: page.history };
        });
    }
    async rename(req: Request, id: string, raw: unknown): Promise<ChatDetail> {
        const body = chatBody(raw, ['expectedRevision', 'title']), revision = chatRevision(body.expectedRevision), title = chatTitle(body.title), scope = await this.scope(req, id);
        await this.repository.owned(scope.owner, scope.row.id, scope.authorize, async (db, row) => {
            this.repository.revision(row, revision); await db.query('UPDATE model_chat_conversations SET title=$2 WHERE id=$1', [id, title]); await this.repository.bump(db, row);
        }); return this.read(req, id);
    }
    async remove(req: Request, id: string, raw: unknown): Promise<{ deleted: true }> {
        const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id);
        await this.repository.owned(scope.owner, scope.row.id, scope.authorize, async (db, row) => { this.repository.revision(row, revision); await db.query('DELETE FROM model_chat_conversations WHERE id=$1', [id]); });
        for (const value of this.active.values()) if (value.conversationId === id) value.abort.abort();
        return { deleted: true };
    }
    async upload(req: Request, id: string, raw: unknown, signal?: AbortSignal): Promise<ChatDetail> {
        const input = chatUpload(raw), scope = await this.scope(req, id);
        const prior = await this.repository.owned(scope.owner, id, scope.authorize, async db => this.repository.priorAttachment(db, id, input.requestId));
        if (prior) { this.sameUpload(prior, input.hash); return this.read(req, id); }
        signal?.throwIfAborted();
        const extracted = await extractChatDocument(input.name, input.bytes, signal);
        if (!extracted.text.trim() || extracted.text.includes('\0') || Buffer.byteLength(extracted.text) > CHAT_TEXT_BYTES) throw new BadRequestException('Документ не содержит доступного текста или превышает 100 КиБ извлечённого текста. Разделите его на части.');
        const object = await this.storage.stage({ ownerEmail: scope.owner, projectId: scope.row.project_id, conversationId: id, bytes: input.bytes, mediaType: extracted.mediaType }, signal);
        try {
            await this.repository.owned(scope.owner, id, scope.authorize, async (db, row) => {
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
        return this.repository.owned(scope.owner, id, scope.authorize, async db => { const row = await this.repository.attachment(db, id, attachmentId); return { attachment: attachmentView(row), text: row.text }; });
    }
    async removeAttachment(req: Request, id: string, attachmentId: string, raw: unknown): Promise<ChatDetail> {
        const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id); chatUuid(attachmentId);
        await this.repository.owned(scope.owner, id, scope.authorize, async (db, row) => {
            this.repository.revision(row, revision); await this.repository.attachment(db, id, attachmentId);
            const linked = await db.query('SELECT 1 FROM model_chat_turns WHERE conversation_id=$1 AND removed_at IS NULL AND $2::uuid=ANY(attachment_ids)', [id, attachmentId]);
            if (linked.rowCount) throw new ConflictException('Файл используется сообщением. Его содержимое сохраняется вместе с историей диалога.');
            await db.query("UPDATE model_chat_attachments SET object_id=NULL,storage_state='DELETED',text='',text_bytes=0,deleted_at=now() WHERE id=$1 AND conversation_id=$2", [attachmentId, id]); await this.repository.bump(db, row);
        }); return this.read(req, id);
    }
    async preview(req: Request, id: string, raw: unknown) {
        const body = chatBody(raw, ['prompt', 'attachmentIds']), prompt = chatPrompt(body.prompt ?? '', true), ids = chatAttachmentIds(body.attachmentIds ?? []), scope = await this.scope(req, id);
        return this.repository.owned(scope.owner, id, scope.authorize, async (db, row) => {
            return (await this.state(db, row, await scope.authorize(), prompt || ids.length ? await this.inputText(db, id, prompt, ids) : undefined)).context;
        });
    }
    async send(req: Request, id: string, raw: unknown, signal: AbortSignal): Promise<ChatDetail> {
        const body = chatBody(raw, ['expectedRevision', 'requestId', 'prompt', 'attachmentIds', 'expectedModelPin']), revision = chatRevision(body.expectedRevision), requestId = chatUuid(body.requestId),
            prompt = chatPrompt(body.prompt, true), ids = chatAttachmentIds(body.attachmentIds ?? []), pin = chatPin(body.expectedModelPin), hash = chatHash([prompt, ids]), scope = await this.scope(req, id);
        if (!prompt.trim() && !ids.length) throw new BadRequestException('Введите сообщение или прикрепите документ.');
        const prepared = await this.repository.owned(scope.owner, id, () => scope.authorize(true), async (db, row) => {
            if (row.model_pin !== pin) throw chatChanged();
            const repeated = await this.repository.priorTurn(db, id, requestId);
            if (repeated) { if (repeated.request_hash !== hash || repeated.removed_at) throw new ConflictException('Идентификатор запроса уже использован другим сообщением.'); return null; }
            signal.throwIfAborted(); this.repository.revision(row, revision);
            const tail = await this.repository.tail(db, id); this.requireResolved(tail ? [tail] : []);
            const text = await this.inputText(db, id, prompt, ids), state = await this.state(db, row, await scope.authorize(true), text);
            if (state.context.exceeded) throw new BadRequestException(state.context.reason || 'Сообщение не помещается в доступный контекст.');
            const turn = await this.repository.addTurn(db, row, { requestId, hash, prompt, attachmentIds: ids, text });
            await this.repository.stage(db, row, turn, state.context.compactionNeeded ? 'compacting' : 'responding');
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
            signal.throwIfAborted(); this.repository.revision(row, revision);
            const tail = await this.repository.tail(db, id);
            if (!tail || tail.id !== turnId || !['failed', 'cancelled'].includes(tail.status)) throw new ConflictException('Повторить можно последнее прерванное сообщение.');
            if (tail.request_ids.length >= 100) throw new ConflictException('Достигнут предел повторов. Начните новый диалог.');
            const state = await this.state(db, row, await scope.authorize(true));
            if (state.context.exceeded) throw new BadRequestException(state.context.reason || 'Сообщение не помещается в доступный контекст.');
            const turn = (await db.query<TurnRow>("UPDATE model_chat_turns SET request_id=$3,request_ids=array_append(request_ids,$3::uuid),status='pending',error=NULL,lease_until=now()+interval '20 minutes' WHERE conversation_id=$1 AND id=$2 RETURNING *", [id, turnId, requestId])).rows[0];
            await this.repository.stage(db, row, turn, state.context.compactionNeeded ? 'compacting' : 'responding');
            await this.repository.bump(db, row); return { turn };
        });
        if (!prepared) return this.read(req, id); return this.execute(req, scope, prepared.turn, signal);
    }
    async cancel(req: Request, id: string, turnId: string, raw: unknown): Promise<ChatDetail> {
        chatUuid(turnId); const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id);
        const cancelledRequest = await this.repository.owned(scope.owner, id, scope.authorize, async (db, row) => {
            this.repository.revision(row, revision);
            const changed = await db.query<{ request_id: string }>("UPDATE model_chat_turns SET status='cancelled',error='Запрос остановлен.',lease_until=NULL WHERE conversation_id=$1 AND id=$2 AND status='pending' AND removed_at IS NULL RETURNING request_id", [id, turnId]);
            if (!changed.rowCount) throw new ConflictException('Запрос уже завершён. Обновите диалог.'); await this.repository.bump(db, row);
            return changed.rows[0].request_id;
        }); const active = this.active.get(turnId); if (active?.requestId === cancelledRequest) active.abort.abort(); return this.read(req, id);
    }
    async removeTurn(req: Request, id: string, turnId: string, raw: unknown): Promise<ChatDetail> {
        chatUuid(turnId); const body = chatBody(raw, ['expectedRevision']), revision = chatRevision(body.expectedRevision), scope = await this.scope(req, id);
        await this.repository.owned(scope.owner, id, scope.authorize, async (db, row) => {
            this.repository.revision(row, revision); const tail = await this.repository.tail(db, id);
            if (!tail || tail.id !== turnId || !['failed', 'cancelled'].includes(tail.status)) throw new ConflictException('Изменить можно последнее прерванное сообщение.');
            await db.query("UPDATE model_chat_turns SET removed_at=now(),prompt='',input_text='',attachment_ids='{}' WHERE conversation_id=$1 AND id=$2", [id, turnId]); await this.repository.bump(db, row);
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
            const model = await scope.authorize(true), messages = await this.compact(scope, turn, combined); combined.throwIfAborted();
            await requireFeatureEnabled('model_hosting'); await scope.authorize(true); combined.throwIfAborted();
            const result = await this.runtime.infer(model, 'chat', modelInferenceBody('chat', { messages,
                ...(model.runtime === 'ollama' && this.localContextWindow !== null ? { options: { num_ctx: this.localContextWindow } } : {}), stream: false }), combined);
            combined.throwIfAborted(); await scope.authorize(true); await requireFeatureEnabled('model_hosting');
            const message = result.message as Record<string, unknown> | undefined;
            if (!message || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim() || Buffer.byteLength(JSON.stringify(message.content)) > 8 * 1024 ** 2
                || !['stop', 'length'].includes(String(result.done_reason))) throw new Error('invalid-chat-response');
            await this.repository.owned(scope.owner, scope.row.id, () => scope.authorize(true), async (db, row) => {
                combined.throwIfAborted(); await this.repository.finish(db, row, turn, { content: message.content as string, finishReason: result.done_reason as 'stop' | 'length', usage: chatUsage(result) });
            });
        } catch (error) {
            await this.repository.fail(scope.row.id, turn.id, turn.request_id, combined.aborted ? 'cancelled' : 'failed', combined.aborted ? 'Запрос остановлен. Можно повторить его.' : error instanceof BadRequestException ? error.message : 'Модель не выполнила запрос. Проверьте подключение и повторите.');
            if (error instanceof ForbiddenException || error instanceof ConflictException) throw error;
        } finally { if (this.active.get(turn.id)?.abort === abort) this.active.delete(turn.id); }
        return this.read(req, scope.row.id);
    }
    private requireResolved(turns: TurnRow[]): void { if (turns.some(turn => turn.status !== 'done')) throw new ConflictException('Повторите, измените или остановите последнее сообщение.'); }
    /** Summarization and answer share the pending request lease; each paid batch has an immutable receipt. */
    private async compact(scope: Awaited<ReturnType<ModelChatService['scope']>>, turn: TurnRow, signal: AbortSignal): Promise<ChatMessage[]> {
        for (let calls = 0; calls <= COMPACTION_CALL_LIMIT; calls++) {
            signal.throwIfAborted();
            const state = await this.repository.owned(scope.owner, scope.row.id, () => scope.authorize(true), async (db, row) => {
                const current = await this.repository.priorTurn(db, row.id, turn.request_id);
                if (!current || current.status !== 'pending' || current.request_id !== turn.request_id || current.removed_at) throw new ConflictException('Запрос уже остановлен или завершён.');
                const state = await this.state(db, row, await scope.authorize(true));
                await this.repository.stage(db, row, turn, state.context.compactionNeeded ? 'compacting' : 'responding');
                return state;
            });
            if (state.context.exceeded) throw new BadRequestException(state.context.reason || 'Сообщение не помещается в окно модели. История сохранена.');
            if (!state.context.compactionNeeded) return state.messages;
            if (calls === COMPACTION_CALL_LIMIT) throw new BadRequestException('Сохранён прогресс сжатия. Для большого диалога достигнут лимит восьми обработок за запрос; нажмите «Повторить», чтобы продолжить. Исходная история сохранена.');
            const batch = compactionBatch(state.checkpoint, state.sources, state.settings, turn.id);
            await requireFeatureEnabled('model_hosting'); const model = await scope.authorize(true); signal.throwIfAborted();
            const result = await this.runtime.infer(model, 'chat', modelInferenceBody('chat', { messages: batch.messages, options: { num_predict: batch.maxOutputTokens,
                ...(model.runtime === 'ollama' && this.localContextWindow !== null ? { num_ctx: this.localContextWindow } : {}) }, stream: false }), signal);
            signal.throwIfAborted(); await scope.authorize(true); await requireFeatureEnabled('model_hosting');
            const message = result.message as Record<string, unknown> | undefined;
            if (!message || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim() || result.done_reason !== 'stop'
                || Buffer.byteLength(message.content) > Math.min(65536, batch.maxOutputTokens * 2)) throw new BadRequestException('Модель не смогла подготовить полное краткое резюме. История сохранена; можно повторить сжатие.');
            await this.repository.owned(scope.owner, scope.row.id, () => scope.authorize(true), async (db, row) => {
                signal.throwIfAborted(); const current = await this.repository.priorTurn(db, row.id, turn.request_id);
                if (!current || current.status !== 'pending' || current.request_id !== turn.request_id || current.removed_at) throw new ConflictException('Запрос уже остановлен или завершён.');
                const currentState = await this.state(db, row, await scope.authorize(true));
                if (currentState.checkpoint?.id !== state.checkpoint?.id || compactionBatch(currentState.checkpoint, currentState.sources, currentState.settings, turn.id).digest !== batch.digest) throw chatChanged();
                await this.repository.saveCheckpoint(db, row, turn, state.checkpoint, batch, message.content as string, chatUsage(result));
            });
        }
        throw new Error('unreachable-compaction-budget');
    }
    private async state(db: ChatDb, row: ConversationRow, model: IModel, draft?: string) {
        const checkpoint = await this.repository.checkpoint(db, row.id), loaded = await this.repository.sources(db, row.id, checkpoint), settings = await this.settings(db, model), turns = loaded.turns;
        const sources = chatSources(turns, checkpoint), tail = turns.at(-1);
        // A separately fetched tail must never let a checkpoint jump over an omitted middle prefix.
        if (loaded.overflow && tail) for (const source of sources) if (source.turnId === tail.id) source.completed = false;
        let pendingTurnId = tail && tail.status !== 'done' ? tail.id : undefined;
        if (draft !== undefined) {
            pendingTurnId = 'draft';
            sources.push({ turnId: pendingTurnId, position: Number(tail?.position ?? 0) + 1, role: 'user', text: draft, offset: 0, end: draft.length, total: draft.length, completed: false });
        }
        const messages = projection(checkpoint, sources), raw = chatContext(messages, settings), pending = sources.filter(source => source.turnId === pendingTurnId);
        raw.estimatedInputTokens += Math.ceil(loaded.omittedBytes / 2) + loaded.omittedMessages * 6;
        raw.messageCount += loaded.omittedMessages; raw.requestBytes += loaded.omittedRequestBytes;
        const single = chatContext(projection(null, pending), settings), eligible = canCompact(sources, pendingTurnId);
        const optionsBytes = model.runtime === 'ollama' && this.localContextWindow !== null ? Buffer.byteLength(JSON.stringify({ num_ctx: this.localContextWindow })) + 11 : 0;
        const needed = loaded.overflow || needsCompaction(messages, settings) || raw.requestBytes + optionsBytes > raw.maxRequestBytes, compactable = !single.exceeded && (eligible || !!checkpoint && raw.exceeded);
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
    private async detail(rows: ChatRows, model: IModel, db: ChatDb): Promise<ChatDetail> {
        const state = await this.state(db, rows.conversation, model), pending = rows.turns.find(turn => turn.status === 'pending');
        return { conversation: conversationView(rows.conversation), turns: rows.turns.map(turnView), attachments: rows.attachments.map(attachmentView),
            history: rows.history, context: state.context, compaction: { state: pending?.processing_stage === 'compacting' ? 'compacting' : state.checkpoint ? 'ready' : 'none',
                coveredTurns: await this.repository.covered(db, rows.conversation.id, state.checkpoint), ...(state.checkpoint ? { updatedAt: new Date(state.checkpoint.created_at).toISOString() } : {}) },
            blockedReason: projectEmbeddingPin(model) === rows.conversation.model_pin ? null : 'Модель или её параметры изменились. Начните новый диалог.' };
    }
}
