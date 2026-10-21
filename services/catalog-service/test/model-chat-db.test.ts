import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCatalogSchema, checkCatalogSchema } from '../src/database/catalog-schema';
import { ModelChatService } from '../src/model-chat/chat.service';
import { chatAttachmentIds, chatBody, chatPrompt, chatRevision, chatUpload } from '../src/model-chat/chat-validation';
import type { ChatDetail } from '../src/model-chat/chat.types';
import type { ModelsService } from '../src/models/models.service';
import type { ModelRuntime } from '../src/models/model-runtime';
import type { IModel } from '../src/models/model.types';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';

const connection = process.env.MODEL_CHAT_FILES_TEST_PG_URL;
const card = (): IModel => ({ id: 'model-chat-test', name: 'Chat', description: '', capability: 'chat', runtime: 'ollama', model: 'test:1', manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '2026-10-21', updatedAt: '2026-10-21' });
const request = (email = 'owner@localhost'): Request => ({ headers: { 'x-test-email': email } } as unknown as Request);
const signal = (): AbortSignal => new AbortController().signal;
const bytes = (text: string): string => Buffer.from(text).toString('base64');

describe('Chat input boundaries', () => {
    it('rejects unknown input fields, invalid revisions, duplicate/foreign-shaped attachments and blank messages', () => {
        expect(() => chatBody({ apiKey: 'secret' }, [])).toThrow(BadRequestException);
        for (const value of [0, -1, 1.2, '1', null]) expect(() => chatRevision(value)).toThrow(BadRequestException);
        expect(() => chatAttachmentIds(Array(6).fill(randomUUID()))).toThrow(BadRequestException);
        const id = randomUUID(); expect(() => chatAttachmentIds([id, id])).toThrow(BadRequestException);
        expect(() => chatPrompt(' ')).toThrow(BadRequestException);
        expect(() => chatPrompt('я'.repeat(65537))).toThrow(BadRequestException);
    });
    it('requires canonical bounded bytes and a safe filename before starting extraction', () => {
        expect(chatUpload({ name: 'note.txt', contentBase64: bytes('Привет'), requestId: randomUUID() }).bytes.toString()).toBe('Привет');
        for (const name of ['../a.txt', 'a\\b.txt', 'a\n.txt', '']) expect(() => chatUpload({ name, contentBase64: bytes('ok'), requestId: randomUUID() })).toThrow(BadRequestException);
        for (const contentBase64 of ['', 'eA', 'eA===', 'eA==\n', bytes('x'.repeat(10 * 1024 ** 2 + 1))]) expect(() => chatUpload({ name: 'a.txt', contentBase64, requestId: randomUUID() })).toThrow(BadRequestException);
    });
});

describe.skipIf(!connection)('Personal model chats — disposable PostgreSQL', () => {
    let admin: Pool, db: Pool, service: ModelChatService, database: string, oldUrl: string | undefined;
    let model = card(), allowed = true;
    const models = {
        ready: vi.fn(async () => undefined),
        actor: vi.fn(async (req: Request) => ({ email: String(req.headers['x-test-email'] || 'owner@localhost'), activeRole: 'Главный админ' })),
        getUsable: vi.fn(async () => { if (!allowed) throw new ForbiddenException('Доступ отозван'); return model; }),
        resolveProject: vi.fn(async (_req: Request, name: string) => { if (!['prj-chat-test', 'Chat project'].includes(name)) throw new ForbiddenException('Нет проекта'); return { id: 'prj-chat-test' }; }),
    };
    const runtime = { infer: vi.fn(async () => ({ model: model.model, done_reason: 'stop', message: { role: 'assistant', content: 'Ответ' }, prompt_eval_count: 9, eval_count: 4, usage_reported: true })) };
    const create = (req = request()) => service.create(req, { modelId: model.id, projectId: 'prj-chat-test', expectedModelPin: projectEmbeddingPin(model) });
    const send = (detail: ChatDetail, prompt = 'Привет', attachmentIds: string[] = [], requestId = randomUUID(), req = request(), abort = signal()) => service.send(req, detail.conversation.id, { expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin, requestId, prompt, attachmentIds }, abort);
    beforeAll(async () => {
        const url = new URL(connection!);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '5432') throw new Error('Use an explicit disposable localhost PostgreSQL port other than 5432');
        url.pathname = '/postgres'; admin = new Pool({ connectionString: url.href, max: 1 }); database = 'nc_chat_' + randomUUID().replaceAll('-', '');
        await admin.query('CREATE DATABASE ' + database); url.pathname = '/' + database; oldUrl = process.env.CATALOG_PG_URL; process.env.CATALOG_PG_URL = url.href;
        db = new Pool({ connectionString: url.href, max: 4 }); await ensureCatalogSchema(db);
        await db.query("INSERT INTO projects(id,name) VALUES('prj-chat-test','Chat project')");
        await db.query("INSERT INTO model_catalog(id,name,descriptor) VALUES('model-chat-test','Chat model','{}')");
        service = new ModelChatService(models as unknown as ModelsService, runtime as unknown as ModelRuntime);
    });
    afterEach(async () => {
        await db?.query('DELETE FROM model_chat_conversations'); model = card(); allowed = true; vi.clearAllMocks();
        runtime.infer.mockImplementation(async () => ({ model: model.model, done_reason: 'stop', message: { role: 'assistant', content: 'Ответ' }, prompt_eval_count: 9, eval_count: 4, usage_reported: true }));
    });
    afterAll(async () => { await service?.onApplicationShutdown(); await db?.end(); if (admin) { await admin.query('DROP DATABASE ' + database); await admin.end(); } if (oldUrl === undefined) delete process.env.CATALOG_PG_URL; else process.env.CATALOG_PG_URL = oldUrl; });
    it('creates only migration-owned tables and canonicalizes project names', async () => {
        const created = await service.create(request(), { modelId: model.id, projectId: 'Chat project', expectedModelPin: projectEmbeddingPin(model) });
        expect(created.conversation.projectId).toBe('prj-chat-test'); expect(created.turns).toEqual([]);
        expect((await checkCatalogSchema(db, true)).ready).toBe(true);
        expect((await db.query('SELECT version FROM catalog_schema_migrations ORDER BY version')).rows.at(-1).version).toBe(13);
    });
    it('keeps chats private even from another administrator and isolates project scopes', async () => {
        const a = await create(); const b = request('other-admin@localhost');
        expect((await service.list(b, model.id, 'prj-chat-test')).items).toEqual([]);
        await expect(service.read(b, a.conversation.id)).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.rename(b, a.conversation.id, { expectedRevision: 1, title: 'stolen' })).rejects.toBeInstanceOf(NotFoundException);
        expect((await service.list(request(), model.id)).items).toEqual([]);
    });
    it('persists replies/usage/history, renames with CAS, and deletes all file bytes transactionally', async () => {
        const created = await create(), uploaded = await service.upload(request(), created.conversation.id, { name: 'note.txt', contentBase64: bytes('Документ'), requestId: randomUUID() });
        const completed = await send(uploaded, 'Изучи', uploaded.attachments.map(file => file.id));
        expect(completed.turns[0]).toMatchObject({ status: 'done', answer: { content: 'Ответ', usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13, reported: true } } });
        expect(runtime.infer.mock.calls[0][2]).toMatchObject({ messages: [{ role: 'user', content: expect.stringContaining('Документ') }] });
        const reread = await service.read(request(), created.conversation.id); expect(reread.turns).toEqual(completed.turns);
        await expect(service.rename(request(), created.conversation.id, { expectedRevision: 1, title: 'старое' })).rejects.toBeInstanceOf(ConflictException);
        const renamed = await service.rename(request(), created.conversation.id, { expectedRevision: reread.conversation.revision, title: 'Мой диалог' });
        expect(renamed.conversation.title).toBe('Мой диалог');
        expect(await service.remove(request(), created.conversation.id, { expectedRevision: renamed.conversation.revision })).toEqual({ deleted: true });
        expect((await db.query('SELECT count(*) AS n FROM model_chat_attachments')).rows[0].n).toBe('0');
        expect((await db.query('SELECT count(*) AS n FROM model_chat_turns')).rows[0].n).toBe('0');
    });
    it('deduplicates upload and inference request IDs and rejects a conflicting payload', async () => {
        let current = await create(); const upload = { name: 'note.txt', contentBase64: bytes('text'), requestId: randomUUID() };
        current = await service.upload(request(), current.conversation.id, upload);
        const repeated = await service.upload(request(), current.conversation.id, upload); expect(repeated.attachments).toEqual(current.attachments);
        await expect(service.upload(request(), current.conversation.id, { ...upload, contentBase64: bytes('changed') })).rejects.toBeInstanceOf(ConflictException);
        const requestId = randomUUID(); const [one, two] = await Promise.all([send(current, 'Hi', [], requestId), send(current, 'Hi', [], requestId)]);
        expect(runtime.infer).toHaveBeenCalledOnce(); expect([one.turns[0].status, two.turns[0].status]).toContain('done');
        await expect(send(current, 'changed', [], requestId)).rejects.toBeInstanceOf(ConflictException);
    });
    it('rejects concurrent distinct sends and attachment IDs from another conversation', async () => {
        const one = await create(), two = await create(), attached = await service.upload(request(), two.conversation.id, { name: 'note.txt', contentBase64: bytes('private'), requestId: randomUUID() });
        await expect(send(one, 'Steal', [attached.attachments[0].id])).rejects.toBeInstanceOf(NotFoundException);
        expect(runtime.infer).not.toHaveBeenCalled();
        const results = await Promise.allSettled([send(one), send(one, 'Second')]);
        expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect(runtime.infer).toHaveBeenCalledOnce();
    });
    it('supports retry and editing only the failed tail, retaining every successful turn', async () => {
        let detail = await send(await create());
        runtime.infer.mockRejectedValueOnce(new Error('provider secret must not escape'));
        detail = await send(detail, 'Следом'); expect(detail.turns[1].status).toBe('failed'); expect(detail.turns[1].error).not.toContain('secret');
        const retryBody = { expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin, requestId: randomUUID() };
        detail = await service.retry(request(), detail.conversation.id, detail.turns[1].id, retryBody, signal());
        expect(detail.turns).toHaveLength(2); expect(detail.turns.every(turn => turn.status === 'done')).toBe(true);
        await expect(service.removeTurn(request(), detail.conversation.id, detail.turns[0].id, { expectedRevision: detail.conversation.revision })).rejects.toBeInstanceOf(ConflictException);
        runtime.infer.mockRejectedValueOnce(new Error('failed')); detail = await send(detail, 'Изменить');
        const tail = detail.turns[2]; detail = await service.removeTurn(request(), detail.conversation.id, tail.id, { expectedRevision: detail.conversation.revision }); expect(detail.turns).toHaveLength(2);
        await expect(send(detail, 'Изменить', [], tail.requestId)).rejects.toBeInstanceOf(ConflictException);
    });
    it('cancels the upstream and records a terminal turn on browser abort', async () => {
        let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
        runtime.infer.mockImplementationOnce(async (_m, _e, _b, abort: AbortSignal) => { began(); await new Promise((_, reject) => abort.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); return {} as never; });
        const abort = new AbortController(), created = await create(), pending = send(created, 'Wait', [], randomUUID(), request(), abort.signal);
        await started; abort.abort(); const result = await pending;
        expect(result.turns[0]).toMatchObject({ status: 'cancelled' }); expect(result.turns[0].answer).toBeUndefined();
    });
    it('explicit cancellation survives late successful provider results', async () => {
        let release!: () => void, began!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
        runtime.infer.mockImplementationOnce(async () => { began(); await gate; return { model: model.model, message: { role: 'assistant', content: 'late' }, done_reason: 'stop' } as never; });
        const created = await create(), pending = send(created); await started;
        const progress = await service.read(request(), created.conversation.id), stopped = await service.cancel(request(), created.conversation.id, progress.turns[0].id, { expectedRevision: progress.conversation.revision });
        release(); await pending; expect(stopped.turns[0].status).toBe('cancelled'); expect((await service.read(request(), created.conversation.id)).turns[0].answer).toBeUndefined();
    });
    it('blocks changed model semantics and withholds late results after access revocation', async () => {
        const created = await create(); model = { ...model, manifestSha256: 'b'.repeat(64) };
        expect((await service.read(request(), created.conversation.id)).blockedReason).toContain('изменились');
        await expect(send(created)).rejects.toBeInstanceOf(ConflictException); expect(runtime.infer).not.toHaveBeenCalled();
        model = card(); runtime.infer.mockImplementationOnce(async () => { allowed = false; return { model: model.model, message: { role: 'assistant', content: 'private late output' }, done_reason: 'stop' } as never; });
        await expect(send(created)).rejects.toBeInstanceOf(ForbiddenException);
        expect((await db.query('SELECT status,answer FROM model_chat_turns')).rows).toEqual([{ status: 'failed', answer: null }]);
    });
    it('recovers only an expired lease and never interrupts a live pending worker', async () => {
        const created = await create(), id = randomUUID();
        await db.query("INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,attachment_ids,input_text,status,lease_until) VALUES($1,$2,$3,ARRAY[$3::uuid],$4,'pending','{}','pending','pending',now()+interval '1 minute')", [id, created.conversation.id, randomUUID(), 'a'.repeat(64)]);
        expect((await service.read(request(), created.conversation.id)).turns[0].status).toBe('pending');
        await db.query("UPDATE model_chat_turns SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
        const recovered = await service.read(request(), created.conversation.id); expect(recovered.turns[0].status).toBe('cancelled'); expect(recovered.conversation.revision).toBe(2);
    });
    it('rejects combined document overflow without silent truncation or provider calls', async () => {
        let detail = await create();
        for (let index = 0; index < 2; index++) detail = await service.upload(request(), detail.conversation.id, { name: index + '.txt', contentBase64: bytes('x'.repeat(70 * 1024)), requestId: randomUUID() });
        await expect(send(detail, 'Read', detail.attachments.map(file => file.id))).rejects.toBeInstanceOf(BadRequestException);
        expect(runtime.infer).not.toHaveBeenCalled(); expect((await service.read(request(), detail.conversation.id)).turns).toEqual([]);
    });
    it('forbids removing used files and wipes draft file bytes without resurrecting upload receipts', async () => {
        const created = await create(), upload = { name: 'note.txt', contentBase64: bytes('keep text'), requestId: randomUUID() };
        let detail = await service.upload(request(), created.conversation.id, upload); const attachmentId = detail.attachments[0].id;
        detail = await send(detail, 'Read', [attachmentId]);
        await expect(service.removeAttachment(request(), detail.conversation.id, attachmentId, { expectedRevision: detail.conversation.revision })).rejects.toBeInstanceOf(ConflictException);
        const other = await create(), draft = await service.upload(request(), other.conversation.id, { ...upload, requestId: randomUUID() });
        await service.removeAttachment(request(), other.conversation.id, draft.attachments[0].id, { expectedRevision: draft.conversation.revision });
        expect((await db.query('SELECT content,text,text_bytes FROM model_chat_attachments WHERE id=$1', [draft.attachments[0].id])).rows[0]).toEqual({ content: null, text: '', text_bytes: 0 });
    });
});
