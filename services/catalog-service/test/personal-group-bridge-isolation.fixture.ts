import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ForbiddenException } from '@nestjs/common';
import { vi } from 'vitest';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { AgentRepository } from '../src/agents/agent.repository';
import { ModelChatService } from '../src/model-chat/chat.service';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { ownedDeviceTestAdminUrl } from './device-completion-postgres.fixture';
import type { ModelsService } from '../src/models/models.service';
import type { ModelRuntime } from '../src/models/model-runtime';
import type { IModel } from '../src/models/model.types';
import type { ChatDetail } from '../src/model-chat/chat.types';

export const connection = process.env.PERSONAL_GROUP_BRIDGE_TEST_PG_URL;
export const reply = (content: string) => ({ message: { role: 'assistant', content }, done_reason: 'stop', usage_reported: false });
export function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
export async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned personal-group barrier timed out.')), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
}

/** Real personal-chat runner, group snapshots and SQL receipts; only registry and provider transport are fixtures. */
export async function personalGroupBridgeFixture() {
    const url = ownedDeviceTestAdminUrl(connection ?? ''), admin = new Pool({ connectionString: url.href, max: 1 });
    const database = 'nc_personal_bridge_' + randomUUID().replaceAll('-', ''), projectId = 'prj-personal-bridge';
    let db: Pool | undefined, service: ModelChatService | undefined, created = false;
    const request = () => ({ headers: { 'x-owner': 'owner@localhost' } } as unknown as Request);
    const originalUrl = process.env.CATALOG_PG_URL, originalWindow = process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS;
    const server: IModel = { id: 'model-personal-server', name: 'Server', description: '', capability: 'chat', runtime: 'ollama', model: 'qa:server',
        manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '2026-10-24', updatedAt: '2026-10-24' };
    const codex: IModel = { ...server, id: 'model-personal-codex', name: 'Codex', runtime: 'device-codex', model: 'openai/gpt-test',
        manifestSha256: null, verificationSha256: 'b'.repeat(64), modelVersion: 'qa-1' };
    let allowed = true, cards = new Map([[server.id, server], [codex.id, codex]]);
    const calls: Array<{ modelId: string; agentId: string | null | undefined }> = [];
    const runtime = { infer: vi.fn(async (model: IModel, _endpoint: string, _body: Record<string, unknown>, _signal?: AbortSignal) => reply(model.id)) };
    let provider = async (model: IModel, _signal?: AbortSignal) => reply(model.id);
    const models = { pool: undefined as unknown as Pool, ready: async () => undefined,
        actor: async () => ({ email: 'owner@localhost', activeRole: 'Разработчик' }),
        getUsable: vi.fn(async (id: string) => { if (!allowed || !cards.has(id)) throw new ForbiddenException('Доступ отозван'); return cards.get(id)!; }),
        resolveProject: vi.fn(async () => { if (!allowed) throw new ForbiddenException('Доступ отозван'); return { id: projectId, name: 'Bridge isolation', state: 'active', headRevision: 0 }; }),
        list: vi.fn(async () => ({ items: [...cards.values()], assignedModelIds: [...cards.keys()] })),
    };
    const cleanup = async () => {
        await service?.onApplicationShutdown(); await db?.end();
        if (created) await admin.query('DROP DATABASE ' + database);
        await admin.end();
        if (originalUrl === undefined) delete process.env.CATALOG_PG_URL; else process.env.CATALOG_PG_URL = originalUrl;
        if (originalWindow === undefined) delete process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS; else process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS = originalWindow;
    };
    try {
        await admin.query('CREATE DATABASE ' + database); created = true; url.pathname = '/' + database;
        db = new Pool({ connectionString: url.href, max: 4 }); await ensureCatalogSchema(db);
        await db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Bridge isolation']);
        await db.query("INSERT INTO platform_users(email) VALUES('owner@localhost')");
        await db.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'owner@localhost','owner@localhost','Owner','Разработчик')", [projectId]);
        for (const card of cards.values()) await db.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)', [card.id, card.name, JSON.stringify(card)]);
        process.env.CATALOG_PG_URL = url.href; process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS = '4096'; models.pool = db;
        runtime.infer.mockImplementation(async (model, _endpoint, _body, signal) => {
            await currentModelUsage().beforeInference?.();
            calls.push({ modelId: model.id, agentId: currentModelUsage().agentId });
            return provider(model, signal);
        });
        service = new ModelChatService(models as unknown as ModelsService, runtime as unknown as ModelRuntime);
        return { db, service, server, codex, calls, runtime,
            setProvider(value: typeof provider) { provider = value; },
            revokeAccess() { allowed = false; },
            changeCodexPin() { cards.set(codex.id, { ...codex, verificationSha256: 'c'.repeat(64) }); },
            async agent(name: string, model = server) {
                const id = 'agent-' + randomUUID(), card = await new AgentRepository(db!).write(db!, id, { slug: 'nc-' + randomUUID().slice(0, 8), name,
                    definition: { description: name, prompt: 'Persona ' + name, mode: 'all', permission: {}, model: 'neurocenter/' + model.id } }, 1);
                await db!.query('INSERT INTO project_agent_sets(project_id) VALUES($1) ON CONFLICT DO NOTHING', [projectId]);
                await db!.query("INSERT INTO project_agents(project_id,agent_id,version,manifest,enabled,added_by,updated_by) VALUES($1,$2,1,$3,true,'owner','owner')", [projectId, id, card.manifest]);
                return id;
            },
            create: (agentIds: string[]) => service!.create(request(), { modelId: server.id, projectId, expectedModelPin: projectEmbeddingPin(server), mode: 'group', agentIds }),
            send: (detail: ChatDetail) => service!.send(request(), detail.conversation.id, { expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin,
                requestId: randomUUID(), prompt: 'Проверь проект', attachmentIds: [] }, new AbortController().signal),
            read: (id: string) => service!.read(request(), id),
            retry: (detail: ChatDetail) => service!.retry(request(), detail.conversation.id, detail.turns.at(-1)!.id,
                { expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin, requestId: randomUUID() }, new AbortController().signal),
            cancel: (detail: ChatDetail) => service!.cancel(request(), detail.conversation.id, detail.turns.at(-1)!.id, { expectedRevision: detail.conversation.revision }),
            async reset() {
                await db!.query('DELETE FROM model_chat_conversations'); await db!.query('DELETE FROM project_agents'); await db!.query('DELETE FROM project_agent_sets');
                allowed = true; cards = new Map([[server.id, server], [codex.id, codex]]); calls.length = 0; provider = async model => reply(model.id);
                runtime.infer.mockClear();
            }, cleanup,
        };
    } catch (error) { await cleanup(); throw error; }
}

export type PersonalGroupBridgeFixture = Awaited<ReturnType<typeof personalGroupBridgeFixture>>;
