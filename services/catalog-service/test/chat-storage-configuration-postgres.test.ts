import 'reflect-metadata';
import { Controller, Get, Module, ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { ModelChatService } from '../src/model-chat/chat.service';
import { ChatObjectStorage } from '../src/model-chat/chat-object-storage';
import type { ChatDetail } from '../src/model-chat/chat.types';
import { ModelsService } from '../src/models/models.service';
import { ModelRuntime } from '../src/models/model-runtime';
import type { IModel } from '../src/models/model.types';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { currentModelUsage } from '../src/model-usage/model-usage.context';

vi.mock('../src/features/require-feature-enabled', () => ({ requireFeatureEnabled: vi.fn(async () => undefined), requireFeaturesEnabled: vi.fn(async () => undefined) }));
const connection = process.env.AGENT_TEST_ADMIN_URL;
const configuration = { CHAT_S3_ENDPOINT: 'https://storage.example.test', CHAT_S3_ACCESS_KEY: 'fixture-access', CHAT_S3_SECRET_KEY: 'fixture-secret',
    CHAT_S3_PROJECT_BUCKET: 'fixture-project', CHAT_S3_PERSONAL_BUCKET: 'fixture-personal', CHAT_S3_REGION: 'us-east-1' };
const model: IModel = { id: 'model-storage-isolation', name: 'Isolated text model', description: '', capability: 'chat', runtime: 'ollama', model: 'fixture:text',
    manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
const req = { headers: {} } as Request;
const upload = () => ({ requestId: randomUUID(), name: 'note.txt', contentBase64: Buffer.from('A file requiring private object storage.').toString('base64') });
class Health { health() { return { ok: true }; } }
Controller('health')(Health); Get()(Health.prototype, 'health', Object.getOwnPropertyDescriptor(Health.prototype, 'health')!);

/** Real Nest lifecycle and chat persistence; only the model and verified S3 transport are controlled boundaries. */
describe.skipIf(!connection).sequential('Invalid optional chat storage configuration cannot stop Catalog text work', () => {
    const database = 'nc_chat_config_' + randomUUID().replaceAll('-', ''), apps = new Set<INestApplication>();
    let admin: Pool, db: Pool, url: string, created = false;
    const models = {
        pool: undefined as unknown as Pool, ready: vi.fn(async () => undefined),
        actor: vi.fn(async () => ({ email: 'owner@example.test', activeRole: 'Главный админ', claims: { userRoles: ['Главный админ'], projects: [] } })),
        getUsable: vi.fn(async () => model), list: vi.fn(async () => ({ items: [model], assignedModelIds: [model.id] })),
    };
    const runtime = { infer: vi.fn(async () => {
        await currentModelUsage().beforeInference?.();
        return { message: { role: 'assistant', content: 'Text reply remains available.' }, done_reason: 'stop', usage_reported: false };
    }) };
    beforeAll(async () => {
        const target = ownedTestPostgresAdmin(connection);
        admin = new Pool({ connectionString: target.href, max: 1 });
        await admin.query('CREATE DATABASE ' + database); created = true; target.pathname = '/' + database; url = target.href;
        db = new Pool({ connectionString: url, max: 2 }); models.pool = db; await ensureCatalogSchema(db);
        await db.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)', [model.id, model.name, JSON.stringify(model)]);
    }, 30000);
    beforeEach(() => {
        for (const key of Object.keys(configuration)) vi.stubEnv(key, '');
        vi.stubEnv('CATALOG_PG_URL', url); vi.stubEnv('MODEL_CHAT_CONTEXT_WINDOW_TOKENS', '8192');
        models.ready.mockImplementation(async () => { await ensureCatalogSchema(db); });
    });
    afterEach(async () => { for (const app of apps) await app.close(); apps.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    afterAll(async () => { await db?.end(); if (created) await admin.query('DROP DATABASE ' + database); await admin?.end(); });
    async function start() {
        class App {}
        Module({ controllers: [Health], providers: [{ provide: ModelChatService, useFactory: () => new ModelChatService(models as unknown as ModelsService, runtime as unknown as ModelRuntime) }] })(App);
        const app = await NestFactory.create(App, { logger: false, abortOnError: false }); apps.add(app);
        await app.listen(0, '127.0.0.1');
        expect(await (await fetch(await app.getUrl() + '/health')).json()).toEqual({ ok: true });
        return { app, service: app.get(ModelChatService) };
    }
    const create = (service: ModelChatService) => service.create(req, { modelId: model.id, expectedModelPin: projectEmbeddingPin(model), title: 'Storage isolation' });
    const send = (service: ModelChatService, detail: ChatDetail) => service.send(req, detail.conversation.id, { expectedRevision: detail.conversation.revision,
        expectedModelPin: detail.conversation.modelPin, requestId: randomUUID(), prompt: 'A plain text question.', attachmentIds: [] }, new AbortController().signal);

    it.each(['partial', 'invalid-url'])('%s S3 configuration permits actual text chat and returns an actionable attachment-only503', async scenario => {
        vi.stubEnv('CHAT_S3_ENDPOINT', scenario === 'partial' ? configuration.CHAT_S3_ENDPOINT : 'not-a-url');
        if (scenario === 'invalid-url') for (const [key, value] of Object.entries(configuration)) if (key !== 'CHAT_S3_ENDPOINT') vi.stubEnv(key, value);
        const { service } = await start(), initial = await create(service), answered = await send(service, initial);
        expect(answered.turns[0]).toMatchObject({ status: 'done', answer: { content: 'Text reply remains available.' } });
        await expect(service.upload(req, initial.conversation.id, upload())).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/настрой|конфигурац/i) });
        expect((await service.read(req, initial.conversation.id)).turns).toEqual(answered.turns);
        expect((await db.query('SELECT count(*) AS n FROM model_chat_attachments WHERE conversation_id=$1', [initial.conversation.id])).rows[0].n).toBe('0');
        expect((await db.query('SELECT count(*) AS n FROM model_chat_objects')).rows[0].n).toBe('0');
        expect((await db.query('SELECT count(*) AS n FROM model_chat_attachment_transfers')).rows[0].n).toBe('0');
    });
    it('keeps prior chat IDs and replies after configuration repair and a new service instance; upload waits for privacy readiness', async () => {
        for (const [key, value] of Object.entries(configuration)) vi.stubEnv(key, value);
        const initialize = vi.spyOn(ChatObjectStorage.prototype, 'initialize').mockResolvedValue();
        vi.spyOn(ChatObjectStorage.prototype, 'put').mockResolvedValue('fixture-version');
        vi.spyOn(ChatObjectStorage.prototype, 'read').mockResolvedValue(Buffer.from('A file requiring private object storage.'));
        vi.spyOn(ChatObjectStorage.prototype, 'assertPrivate').mockResolvedValue();
        const first = await start(); await first.service.storage.initialize();
        const created = await create(first.service), initial = await first.service.upload(req, created.conversation.id, upload()), answered = await send(first.service, initial);
        const savedObjects = (await db.query('SELECT id,storage_id,bucket,object_key,version_id,sha256,bytes,state FROM model_chat_objects ORDER BY id')).rows;
        expect(savedObjects).toHaveLength(1); await first.app.close(); apps.delete(first.app);
        vi.stubEnv('CHAT_S3_SECRET_KEY', ''); const invalid = await start();
        expect((await invalid.service.read(req, initial.conversation.id)).attachments).toEqual(initial.attachments);
        await expect(invalid.service.upload(req, initial.conversation.id, upload())).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect((await db.query('SELECT id,storage_id,bucket,object_key,version_id,sha256,bytes,state FROM model_chat_objects ORDER BY id')).rows).toEqual(savedObjects);
        await invalid.app.close(); apps.delete(invalid.app); vi.stubEnv('CHAT_S3_SECRET_KEY', configuration.CHAT_S3_SECRET_KEY);
        let ready!: () => void; initialize.mockReturnValue(new Promise(resolve => { ready = resolve; }));
        const next = await start();
        expect((await next.service.read(req, initial.conversation.id)).turns).toEqual(answered.turns);
        try { await expect(next.service.upload(req, initial.conversation.id, upload())).rejects.toBeInstanceOf(ServiceUnavailableException); }
        finally { ready(); await next.service.storage.initialize(); }
        expect(initialize).toHaveBeenCalledTimes(2);
        const withFile = await next.service.upload(req, initial.conversation.id, upload());
        expect(withFile.conversation.id).toBe(initial.conversation.id); expect(withFile.turns).toEqual(answered.turns); expect(withFile.attachments).toHaveLength(2);
        expect(withFile.attachments).toContainEqual(initial.attachments[0]);
        expect((await db.query('SELECT id,storage_id,bucket,object_key,version_id,sha256,bytes,state FROM model_chat_objects WHERE id=$1', [savedObjects[0].id])).rows).toEqual(savedObjects);
        expect((await db.query('SELECT storage_state FROM model_chat_attachments WHERE conversation_id=$1', [initial.conversation.id])).rows).toEqual([{ storage_state: 'S3' }, { storage_state: 'S3' }]);
    });
    it('keeps mandatory Catalog schema failures fail-closed instead of announcing a healthy listener', async () => {
        const error = new Error('Mandatory schema unavailable'); models.ready.mockRejectedValueOnce(error);
        await expect(start()).rejects.toBe(error);
    });
});
