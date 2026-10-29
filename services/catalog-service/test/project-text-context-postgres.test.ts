import 'reflect-metadata';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import type { TextContext } from '../../shared/project-text-knowledge.cjs';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { ModelChatService } from '../src/model-chat/chat.service';
import type { ChatDetail } from '../src/model-chat/chat.types';
import { ModelRuntime } from '../src/models/model-runtime';
import type { IModel, TModelRuntime } from '../src/models/model.types';
import type { ModelsService } from '../src/models/models.service';
import type { OllamaClient } from '../src/models/ollama-client';
import type { RemoteConnectionService } from '../src/models/remote-connection.service';
import type { DeviceCodexService } from '../src/models/device-codex.service';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { assertProjectTextContextSchema } from '../src/project-text/project-text.schema-verification';
import { AgentRepository } from '../src/agents/agent.repository';
import { textContextDatabase } from './project-text-context.fixture';

const connection = process.env.PROJECT_TEXT_CONTEXT_TEST_ADMIN_URL, projectId = 'prj-text-chat-test', owner = 'owner@text-chat.test';
const request = { headers: {} } as Request;
const card = (runtime: TModelRuntime): IModel => ({ id: 'model-text-' + runtime, name: runtime, description: '', capability: 'chat', runtime,
    model: 'test/selected', manifestSha256: runtime === 'ollama' ? 'a'.repeat(64) : null, verificationSha256: runtime === 'ollama' ? null : 'b'.repeat(64),
    dimension: null, source: 'custom', revision: 1, createdAt: '2026-10-29', updatedAt: '2026-10-29' });
const selector: TextContext = { mode: 'text', revision: 1, corpusHash: 'c'.repeat(64), query: 'rollback procedure' };
const reply = () => ({ message: { role: 'assistant', content: 'Use the cited rollback procedure.' }, done_reason: 'stop' });

describe.skipIf(!connection)('Accepted project text context — owned PostgreSQL and real chat/runtime owners', () => {
    let database: Awaited<ReturnType<typeof textContextDatabase>>, service: ModelChatService, allowed = true;
    let corpus = { mode: 'text' as const, projectId, revision: 1, corpusHash: selector.corpusHash, documentCount: 1, bytes: 128, updatedAt: null };
    let flags = { ...defaultFeatureFlags(), project_search: false, group_discussions: false };
    const calls: Array<{ runtime: TModelRuntime; endpoint: string; body: Record<string, unknown> }> = [];
    let provider = async (_signal?: AbortSignal): Promise<Record<string, unknown>> => reply();
    const infer = async (model: IModel, endpoint: 'chat' | 'embed', body: Record<string, unknown>, signal?: AbortSignal) => {
        calls.push({ runtime: model.runtime, endpoint, body }); return provider(signal);
    };
    const create = (runtime: TModelRuntime = 'ollama') => service.create(request, { modelId: card(runtime).id, projectId, expectedModelPin: projectEmbeddingPin(card(runtime)) });
    const input = (detail: ChatDetail, key = randomUUID()) => ({ expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin,
        requestId: key, prompt: 'Explain the rollback procedure', attachmentIds: [], textContext: selector });
    const send = (detail: ChatDetail, key = randomUUID()) => service.send(request, detail.conversation.id, input(detail, key), new AbortController().signal);

    beforeAll(async () => {
        database = await textContextDatabase(connection);
        await ensureCatalogSchema(database.pool);
        await database.pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Fresh text project']);
        await database.pool.query('INSERT INTO platform_users(email) VALUES($1)', [owner]);
        await database.pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)', [projectId, owner, 'Разработчик']);
        const runtimes: TModelRuntime[] = ['ollama', 'remote-openai', 'device-codex'];
        for (const runtime of runtimes) await database.pool.query("INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,'{}')", [card(runtime).id, runtime]);
        const url = new URL(connection!); url.pathname = '/' + database.name;
        vi.stubEnv('CATALOG_PG_URL', url.href); vi.stubEnv('MODEL_CHAT_CONTEXT_WINDOW_TOKENS', '131072');
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'owned-text-context-test');
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(evaluateFeatureFlags(flags))));
        const models = { pool: database.pool, ready: async () => undefined,
            actor: async () => ({ email: owner, activeRole: 'Разработчик', claims: { email: owner, projects: [], userRoles: ['Разработчик'] } }),
            getUsable: async (id: string) => { if (!allowed) throw new ForbiddenException('Project access revoked'); const model = runtimes.map(card).find(item => item.id === id); if (!model) throw new Error('Unknown fixture model'); return model; },
            list: async () => ({ items: runtimes.map(card), assignedModelIds: runtimes.map(runtime => card(runtime).id) }),
            resolveProject: async (_req: Request, id: string) => { if (!allowed || id !== projectId) throw new ForbiddenException('Project access revoked'); return { id: projectId, name: 'Fresh text project', state: 'ACTIVE', headRevision: 0 }; },
        } as unknown as ModelsService;
        const runtime = new ModelRuntime({ infer } as unknown as OllamaClient, { infer } as unknown as RemoteConnectionService,
            undefined, { infer } as unknown as DeviceCodexService);
        service = new ModelChatService(models, runtime);
        vi.spyOn(service.projectContext.text.client, 'call').mockImplementation(async (route: string) => {
            if (route === 'text/state') return { ...corpus };
            if (route === 'text/search') return { mode: 'text', projectId, revision: corpus.revision, corpusHash: corpus.corpusHash,
                sources: [{ id: 'rollback-source', path: 'docs/rollback.md', startLine: 2, endLine: 3, excerpt: 'ROLLBACK PROCEDURE: restore the accepted revision.', score: 0.5 }] };
            throw new Error('Unexpected text RAG fixture call');
        });
    });
    afterEach(async () => {
        await database?.pool.query('DELETE FROM model_chat_conversations');
        await database?.pool.query('DELETE FROM project_agents');
        await database?.pool.query("UPDATE platform_users SET enabled=true WHERE email=$1", [owner]);
        await database?.pool.query("UPDATE project_members SET role='Разработчик' WHERE project_id=$1", [projectId]);
        allowed = true; calls.length = 0; provider = async () => reply();
        flags = { ...defaultFeatureFlags(), project_search: false, group_discussions: false };
        corpus = { mode: 'text', projectId, revision: 1, corpusHash: selector.corpusHash, documentCount: 1, bytes: 128, updatedAt: null };
    });
    afterAll(async () => { await service?.onApplicationShutdown(); await database?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    it('registers and physically verifies additive accepted-context schema', async () => {
        await assertProjectTextContextSchema(database.pool);
        const versions = (await database.pool.query('SELECT version FROM catalog_schema_migrations ORDER BY version')).rows;
        expect(versions.some(row => Number(row.version) === 47)).toBe(true);
    });

    it.each<TModelRuntime>(['ollama', 'remote-openai', 'device-codex'])('delivers the same accepted citations before %s dispatch without embedding configuration', async runtime => {
        const detail = await send(await create(runtime));
        expect(calls.map(call => [call.runtime, call.endpoint])).toEqual([[runtime, 'chat']]);
        expect(JSON.stringify(calls[0].body)).toContain('ROLLBACK PROCEDURE');
        expect(detail.turns[0]).toMatchObject({ status: 'done', textContext: { selection: selector, evidence: { mode: 'text', textRevision: 1, sources: [{ id: 'rollback-source' }] } },
            answer: { evidence: { mode: 'text', corpusHash: selector.corpusHash, sources: [{ path: 'docs/rollback.md' }] } } });
        const saved = (await database.pool.query('SELECT selection,evidence FROM model_chat_text_contexts')).rows;
        expect(saved).toHaveLength(1); expect(saved[0].selection).toEqual(selector);
        expect((await database.pool.query('SELECT model_id FROM project_embedding_settings WHERE project_id=$1', [projectId])).rows.every(row => row.model_id === null)).toBe(true);
    });

    it('recovers exact accepted history after lost ACK with text OFF; changed selection never replays inference', async () => {
        const initial = await create(), key = randomUUID(), body = input(initial, key);
        const completed = await service.send(request, initial.conversation.id, body, new AbortController().signal);
        flags.project_text_knowledge = false; corpus.revision++;
        const recovered = await service.send(request, initial.conversation.id, body, new AbortController().signal);
        expect(recovered.turns[0].textContext).toEqual(completed.turns[0].textContext);
        expect((await service.history(request, initial.conversation.id)).turns[0].textContext).toEqual(completed.turns[0].textContext);
        await expect(service.send(request, initial.conversation.id, { ...body, textContext: { ...selector, query: 'changed' } }, new AbortController().signal)).rejects.toBeInstanceOf(ConflictException);
        expect(calls).toHaveLength(1);
    });

    it('persists every valid UTF-8 query even when JSON escaping expands the accepted selector', async () => {
        const initial = await create(), textContext = { ...selector, query: '\u0001'.repeat(2047) + 'x' };
        const detail = await service.send(request, initial.conversation.id, { ...input(initial), textContext }, new AbortController().signal);
        expect(detail.turns[0]).toMatchObject({ status: 'done', textContext: { selection: textContext } });
        const saved = (await database.pool.query('SELECT octet_length(selection::text) AS bytes FROM model_chat_text_contexts')).rows[0];
        expect(saved.bytes).toBeGreaterThan(4096); expect(saved.bytes).toBeLessThanOrEqual(16384);
    });

    it.each<TModelRuntime>(['ollama', 'remote-openai', 'device-codex'])('keeps persona, approved-learning channel and the same text citations for a %s project agent', async runtime => {
        const agentId = 'agent-' + randomUUID(), agent = await new AgentRepository(database.pool).write(database.pool, agentId,
            { slug: 'text-' + randomUUID().slice(0, 8), name: 'Text project agent', definition: { description: 'Text fixture', prompt: 'PROJECT AGENT PERSONA', mode: 'all', permission: {} } }, 1);
        await database.pool.query('INSERT INTO project_agent_sets(project_id) VALUES($1) ON CONFLICT DO NOTHING', [projectId]);
        await database.pool.query('INSERT INTO project_agents(project_id,agent_id,version,manifest,enabled,added_by,updated_by) VALUES($1,$2,1,$3,true,$4,$4)', [projectId, agentId, agent.manifest, owner]);
        const initial = await service.create(request, { modelId: card(runtime).id, projectId, expectedModelPin: projectEmbeddingPin(card(runtime)), mode: 'group', agentIds: [agentId] });
        const detail = await send(initial), response = detail.turns[0].responses?.[0];
        expect(calls.map(call => [call.runtime, call.endpoint])).toEqual([[runtime, 'chat']]);
        expect(JSON.stringify(calls[0].body)).toContain('PROJECT AGENT PERSONA');
        expect(JSON.stringify(calls[0].body)).toContain('ROLLBACK PROCEDURE');
        expect(response).toMatchObject({ status: 'done', answer: { evidence: { mode: 'text', sources: [{ id: 'rollback-source' }] }, learning: { projectId, agentId, status: 'empty' } } });
        expect(detail.turns[0].textContext?.selection).toEqual(selector);
    });

    it('refuses a changed corpus after durable acceptance before any provider call and retains the selected sources', async () => {
        const add = service.repository.addTurn.bind(service.repository);
        const hook = vi.spyOn(service.repository, 'addTurn').mockImplementationOnce(async (...args) => { const turn = await add(...args); corpus.revision++; return turn; });
        try {
            await expect(send(await create())).rejects.toBeInstanceOf(ConflictException);
            expect(calls).toEqual([]);
            const saved = (await database.pool.query('SELECT selection,evidence FROM model_chat_text_contexts')).rows;
            expect(saved).toHaveLength(1); expect(saved[0].evidence.textRevision).toBe(1);
            expect((await database.pool.query('SELECT status FROM model_chat_turns')).rows[0].status).toBe('failed');
        } finally { hook.mockRestore(); }
    });

    it('cancels through the public durable owner without deleting accepted source history', async () => {
        let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
        provider = async signal => { started(); await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }); return reply(); };
        const initial = await create(), work = send(initial);
        await began;
        const pending = await service.read(request, initial.conversation.id);
        const cancelled = await service.cancel(request, initial.conversation.id, pending.turns[0].id, { expectedRevision: pending.conversation.revision });
        await work;
        expect(cancelled.turns[0]).toMatchObject({ status: 'cancelled', textContext: { selection: selector } });
        expect(calls).toHaveLength(1);
        expect((await database.pool.query('SELECT count(*) FROM model_chat_text_contexts')).rows[0].count).toBe('1');
    });

    it('locks current Catalog account and project writer authority before text mutations', async () => {
        const authorize = () => service.projectContext.text.authorize({ projectId, actor: { email: owner, activeRole: 'Разработчик' }, requestKey: randomUUID(), requestHash: 'd'.repeat(64) });
        expect(await authorize()).toEqual({ ok: true });
        await database.pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1", [projectId]);
        await expect(authorize()).rejects.toBeInstanceOf(ForbiddenException);
        await database.pool.query("UPDATE project_members SET role='Разработчик' WHERE project_id=$1", [projectId]);
        await database.pool.query('UPDATE platform_users SET enabled=false WHERE email=$1', [owner]);
        await expect(authorize()).rejects.toBeInstanceOf(ForbiddenException);
        expect(calls).toEqual([]);
    });

    it('blocks newly selected text context after feature OFF or project revocation without accepting a turn', async () => {
        const initial = await create(); flags.project_text_knowledge = false;
        await expect(send(initial)).rejects.toBeInstanceOf(ForbiddenException);
        flags.project_text_knowledge = true; allowed = false;
        await expect(send(initial)).rejects.toBeInstanceOf(ForbiddenException);
        expect((await database.pool.query('SELECT count(*) FROM model_chat_text_contexts')).rows[0].count).toBe('0');
        expect((await database.pool.query('SELECT count(*) FROM model_chat_turns')).rows[0].count).toBe('0'); expect(calls).toEqual([]);
    });
});
