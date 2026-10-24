import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { AgentRepository } from '../src/agents/agent.repository';
import type { AgentDefinition } from '../../shared/project-agents.cjs';
import { ModelChatService } from '../src/model-chat/chat.service';
import { COMPACTION_INSTRUCTION } from '../src/model-chat/chat-compaction';
import { chatAgentIds } from '../src/model-chat/chat-group';
import type { ChatDetail } from '../src/model-chat/chat.types';
import type { ModelsService } from '../src/models/models.service';
import type { ModelRuntime } from '../src/models/model-runtime';
import type { IModel } from '../src/models/model.types';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';

vi.mock('../src/features/require-feature-enabled', () => ({ requireFeatureEnabled: vi.fn(async () => undefined), requireFeaturesEnabled: vi.fn(async () => undefined) }));
const connection = process.env.MODEL_CHAT_GROUP_TEST_PG_URL, projectId = 'prj-group-test';
const request = (email = 'owner@localhost') => ({ headers: { 'x-test-email': email } } as unknown as Request);
const reply = (content: string) => ({ message: { role: 'assistant', content }, done_reason: 'stop', usage_reported: false });
const local = (): IModel => ({ id: 'model-group-local', name: 'Local', description: '', capability: 'chat', runtime: 'ollama', model: 'test:local', manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '2026-10-21', updatedAt: '2026-10-21' });
const remote = (): IModel => ({ ...local(), id: 'model-group-remote', name: 'Remote', runtime: 'remote-ollama', model: 'remote/test', manifestSha256: null, verificationSha256: 'b'.repeat(64), modelVersion: '1' });
describe('Group selection validation', () => {
    it('rejects duplicates, unknown IDs and more than eight paid participants', () => {
        for (const input of [undefined, [], ['agent-a', 'agent-a'], ['other'], Array.from({ length: 9 }, (_, i) => 'agent-' + i)]) expect(() => chatAgentIds(input)).toThrow(BadRequestException);
        expect(chatAgentIds([], true)).toEqual([]); expect(chatAgentIds(['agent-a'])).toEqual(['agent-a']);
    });
});

describe.skipIf(!connection)('Private project agent rounds — disposable PostgreSQL', () => {
    let admin: Pool, db: Pool, database: string, service: ModelChatService, oldUrl: string | undefined, oldWindow: string | undefined;
    let allowed = true, cards = new Map<string, IModel>(), assigned = new Set<string>();
    const models = {
        pool: undefined as unknown as Pool, ready: async () => undefined,
        actor: async (req: Request) => ({ email: String(req.headers['x-test-email']), activeRole: 'Разработчик' }),
        getUsable: vi.fn(async (id: string) => { if (!allowed || !assigned.has(id) || !cards.has(id)) throw new ForbiddenException('Доступ отозван'); return cards.get(id)!; }),
        resolveProject: vi.fn(async (_req: Request, id: string) => { if (!allowed || id !== projectId) throw new ForbiddenException('Нет проекта'); return { id: projectId, name: 'Group project', state: 'active', headRevision: 0 }; }),
        list: vi.fn(async () => ({ items: [...cards.values()], assignedModelIds: [...assigned] })),
    };
    const runtime = { infer: vi.fn(async (_model: IModel, _endpoint: string, body: Record<string, unknown>, _signal?: AbortSignal): Promise<Record<string, unknown>> => {
        const messages = body.messages as Array<{ role: string; content: string }>;
        return reply(messages[0].content === COMPACTION_INSTRUCTION ? 'Краткое резюме.' : 'Ответ ' + messages.find(message => message.role === 'system')?.content);
    }) };
    const create = (agentIds: string[], req = request()) => service.create(req, { modelId: local().id, projectId, expectedModelPin: projectEmbeddingPin(cards.get(local().id)!), mode: 'group', agentIds });
    const send = (detail: ChatDetail, targets?: string[], requestId = randomUUID(), abort = new AbortController().signal) => service.send(request(), detail.conversation.id, { expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin,
        requestId, prompt: 'Проверь проект', attachmentIds: [], ...(targets === undefined ? {} : { targetAgentIds: targets }) }, abort);
    const retry = (detail: ChatDetail) => service.retry(request(), detail.conversation.id, detail.turns.at(-1)!.id, { expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin, requestId: randomUUID() }, new AbortController().signal);
    const agent = async (name: string, definition: Partial<AgentDefinition> = {}, enabled = true) => {
        const id = 'agent-' + randomUUID(), card = await new AgentRepository(db).write(db, id, { slug: 'nc-' + randomUUID().slice(0, 8), name,
            definition: { description: name, prompt: 'Persona ' + name, mode: 'all', permission: {}, ...definition } }, 1);
        await db.query('INSERT INTO project_agent_sets(project_id) VALUES($1) ON CONFLICT DO NOTHING', [projectId]);
        await db.query('INSERT INTO project_agents(project_id,agent_id,version,manifest,enabled,added_by,updated_by) VALUES($1,$2,1,$3,$4,\'owner\',\'owner\')', [projectId, id, card.manifest, enabled]); return card;
    };
    beforeAll(async () => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','group-test-only');
        vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags({...defaultFeatureFlags(),group_discussions:false})),{status:200})));
        const url = new URL(connection!); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '5432') throw new Error('Use an explicit disposable localhost PostgreSQL port other than 5432');
        url.pathname = '/postgres'; admin = new Pool({ connectionString: url.href, max: 1 }); database = 'nc_chat_group_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; db = new Pool({ connectionString: url.href, max: 4 }); await ensureCatalogSchema(db);
        await db.query('INSERT INTO projects(id,name) VALUES($1,\'Group project\')', [projectId]);
        await db.query("INSERT INTO platform_users(email) VALUES('owner@localhost')");
        await db.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'owner@localhost','owner@localhost','Owner','Разработчик')", [projectId]);
        for (const card of [local(), remote()]) { cards.set(card.id, card); assigned.add(card.id); await db.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,\'{}\')', [card.id, card.name]); }
        await db.query("INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,semantic_sha,options) VALUES($1,1,'http://127.0.0.1:1',false,'none',$2,$3::jsonb)", [remote().id, remote().verificationSha256, JSON.stringify({ contextWindow: 8192, maxOutputTokens: 128 })]);
        oldUrl = process.env.CATALOG_PG_URL; oldWindow = process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS; process.env.CATALOG_PG_URL = url.href; process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS = '4096'; models.pool = db;
        service = new ModelChatService(models as unknown as ModelsService, runtime as unknown as ModelRuntime);
    });
    afterEach(async () => {
        await db?.query('DELETE FROM model_chat_conversations'); await db?.query('DELETE FROM project_agents'); await db?.query('DELETE FROM project_agent_sets');
        await db?.query('UPDATE model_remote_connections SET options=$1::jsonb', [JSON.stringify({ contextWindow: 8192, maxOutputTokens: 128 })]);
        allowed = true; cards = new Map([[local().id, local()], [remote().id, remote()]]); assigned = new Set(cards.keys()); vi.clearAllMocks();
        runtime.infer.mockImplementation(async (_model, _endpoint, body) => { const messages = body.messages as Array<{ role: string; content: string }>; return reply(messages[0].content === COMPACTION_INSTRUCTION ? 'Краткое резюме.' : 'Ответ ' + messages.find(message => message.role === 'system')?.content); });
    });
    afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await service?.onApplicationShutdown(); await db?.end(); if (admin) { await admin.query('DROP DATABASE ' + database); await admin.end(); } if (oldUrl === undefined) delete process.env.CATALOG_PG_URL; else process.env.CATALOG_PG_URL = oldUrl; if (oldWindow === undefined) delete process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS; else process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS = oldWindow; });
    it('requires a project and an active assigned roster while preserving owner isolation', async () => {
        const a = await agent('A'), b = await agent('B', {}, false);
        await expect(service.create(request(), { modelId: local().id, expectedModelPin: projectEmbeddingPin(local()), mode: 'group', agentIds: [a.id] })).rejects.toBeInstanceOf(BadRequestException);
        await expect(create([b.id])).rejects.toBeInstanceOf(ConflictException);
        expect((await service.agents(request(), local().id, projectId)).items).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: a.id, status: 'active' }), expect.objectContaining({ agentId: b.id, status: 'disabled' })]));
        const detail = await create([a.id]); await expect(service.read(request('other@localhost'), detail.conversation.id)).rejects.toBeInstanceOf(NotFoundException);
        expect((await service.list(request('other@localhost'), local().id, projectId)).items).toEqual([]);
    });
    it('broadcasts once to each selected agent with pinned identity, project overrides and distinct models', async () => {
        const a = await agent('A', { temperature: 0.1 }), b = await agent('B', { model: 'neurocenter/' + remote().id, topP: 0.7 });
        await db.query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [a.id, JSON.stringify({ prompt: 'Project override A', temperature: 0.6 })]);
        let detail = await create([a.id, b.id]), initial = detail; const requestId = randomUUID(); detail = await send(detail, undefined, requestId);
        expect(detail.turns[0].status).toBe('done'); expect(detail.turns[0].answer).toBeUndefined(); expect(detail.turns[0].responses?.map(response => response.agentId)).toEqual([a.id, b.id]);
        expect(detail.turns[0].responses?.map(response => response.modelId)).toEqual([local().id, remote().id]); expect(runtime.infer).toHaveBeenCalledTimes(2);
        expect(runtime.infer.mock.calls[0][2]).toMatchObject({ messages: [expect.objectContaining({ role: 'system', content: 'Project override A' }), expect.anything(), expect.objectContaining({ role: 'user', content: 'Проверь проект' })], options: { temperature: 0.6, num_ctx: 4096 } });
        expect(runtime.infer.mock.calls[1][2]).toMatchObject({ options: { top_p: 0.7 } }); expect(detail.turns[0].responses?.every(response => response.answer?.evidence?.status === 'metadata')).toBe(true);
        expect(JSON.stringify(detail)).not.toContain('"definition"'); await send(initial, undefined, requestId); expect(runtime.infer).toHaveBeenCalledTimes(2);
        await expect(send(initial, [a.id], requestId)).rejects.toBeInstanceOf(ConflictException);
    });
    it('explicit @ targets do not fan out and unavailable peers do not block an active addressee', async () => {
        const a = await agent('A'), b = await agent('B'); let detail = await create([a.id, b.id]);
        await db.query('UPDATE project_agents SET enabled=false WHERE agent_id=$1', [b.id]); detail = await service.read(request(), detail.conversation.id);
        expect(detail.participants).toContainEqual(expect.objectContaining({ agentId: b.id, status: 'disabled' })); expect(detail.blockedReason).toBeNull();
        await expect(send(detail)).rejects.toBeInstanceOf(ConflictException); expect(runtime.infer).not.toHaveBeenCalled();
        detail = await send(detail, [a.id]); expect(detail.turns[0].responses).toHaveLength(1); expect(detail.turns[0].responses![0].agentId).toBe(a.id);
        await expect(send(detail, ['agent-not-selected'])).rejects.toBeInstanceOf(BadRequestException); expect(runtime.infer).toHaveBeenCalledOnce();
    });
    it('reports each model window and rejects only addressed agents whose new prompt cannot fit', async () => {
        const a = await agent('A'), b = await agent('B', { model: 'neurocenter/' + remote().id }); const detail = await create([a.id, b.id]);
        expect(detail.context.contextWindowTokens).toBeNull(); expect(detail.context.participants?.map(item => item.context.contextWindowTokens)).toEqual([4096, 8192]);
        await db.query('UPDATE model_remote_connections SET options=$1::jsonb WHERE model_id=$2', [JSON.stringify({ contextWindow: 512, maxOutputTokens: 128 }), remote().id]);
        const preview = await service.preview(request(), detail.conversation.id, { prompt: 'x'.repeat(1200), attachmentIds: [] });
        expect(preview).toMatchObject({ exceeded: true, canCompact: false }); expect(preview.participants?.find(item => item.agentId === b.id)?.context.contextWindowTokens).toBe(512);
        expect(await service.preview(request(), detail.conversation.id, { prompt: 'x'.repeat(1200), attachmentIds: [], targetAgentIds: [a.id] })).toMatchObject({ exceeded: false, participants: [expect.objectContaining({ agentId: a.id })] });
        expect(runtime.infer).not.toHaveBeenCalled();
    });
    it('changes membership with CAS and preserves historical identities after removal', async () => {
        const a = await agent('A'), b = await agent('B'); let detail = await send(await create([a.id]));
        await expect(service.participants(request(), detail.conversation.id, { expectedRevision: 1, agentIds: [b.id] })).rejects.toBeInstanceOf(ConflictException);
        detail = await service.participants(request(), detail.conversation.id, { expectedRevision: detail.conversation.revision, agentIds: [b.id] });
        expect(detail.participants?.map(item => item.agentId)).toEqual([b.id]); expect(detail.turns[0].responses![0].name).toBe('A'); detail = await send(detail);
        expect(detail.turns[1].responses![0].name).toBe('B');
    });
    it('retains successful siblings and retries only failed answers with unchanged snapshots', async () => {
        const a = await agent('A'), b = await agent('B'); runtime.infer.mockImplementationOnce(async () => reply('successful A')).mockRejectedValueOnce(new Error('provider secret'));
        let detail = await send(await create([a.id, b.id])); expect(detail.turns[0].status).toBe('failed'); expect(detail.turns[0].responses?.map(response => response.status)).toEqual(['done', 'failed']);
        const saved = detail.turns[0].responses![0]; detail = await retry(detail); expect(runtime.infer).toHaveBeenCalledTimes(3); expect(detail.turns[0].status).toBe('done'); expect(detail.turns[0].responses![0]).toEqual(saved);
        expect(JSON.stringify(detail)).not.toContain('provider secret'); await expect(db.query("UPDATE model_chat_agent_responses SET answer='{}' WHERE id=$1", [saved.id])).rejects.toThrow('immutable');
    });
    it('explicit partial completion preserves received answers and permits a new round without disabled agents', async () => {
        const a = await agent('A'), b = await agent('B'); runtime.infer.mockImplementationOnce(async () => reply('Keep A')).mockRejectedValueOnce(new Error('failed'));
        let detail = await send(await create([a.id, b.id])); await expect(service.removeTurn(request(), detail.conversation.id, detail.turns[0].id, { expectedRevision: detail.conversation.revision })).rejects.toBeInstanceOf(ConflictException);
        await db.query('UPDATE project_agents SET enabled=false WHERE agent_id=$1', [b.id]);
        detail = await service.complete(request(), detail.conversation.id, detail.turns[0].id, { expectedRevision: detail.conversation.revision }); expect(detail.turns[0].status).toBe('done'); expect(detail.turns[0].responses![0].answer?.content).toBe('Keep A');
        detail = await send(detail, [a.id]); expect(detail.turns[1].status).toBe('done');
        const history = (runtime.infer.mock.calls.at(-1)![2].messages as Array<{ content: string }>).map(message => message.content).join('\n'); expect(history).toContain('Keep A'); expect(history).toContain('@' + a.slug); expect(history).toContain(projectEmbeddingPin(local()));
    });
    it('rejects late answers after a participant prompt changes while keeping unaffected siblings', async () => {
        const a = await agent('A'), b = await agent('B'); runtime.infer.mockImplementationOnce(async () => { await db.query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [a.id, JSON.stringify({ prompt: 'changed' })]); return reply('must not commit'); });
        const detail = await send(await create([a.id, b.id])); expect(detail.turns[0].responses?.map(response => response.status)).toEqual(['failed', 'done']); expect(JSON.stringify(detail)).not.toContain('must not commit');
    });
    it('cancels an active round without losing an earlier reply or starting later participants', async () => {
        const a = await agent('A'), b = await agent('B'), c = await agent('C'); let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
        runtime.infer.mockImplementationOnce(async () => reply('A already done')).mockImplementationOnce(async (_m, _e, _b, signal) => { started(); await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); return reply('unreachable'); });
        let detail = await create([a.id, b.id, c.id]); const pending = send(detail); await began; detail = await service.read(request(), detail.conversation.id);
        detail = await service.cancel(request(), detail.conversation.id, detail.turns[0].id, { expectedRevision: detail.conversation.revision }); await pending;
        expect(detail.turns[0].responses?.map(response => response.status)).toEqual(['done', 'cancelled', 'cancelled']); expect(runtime.infer).toHaveBeenCalledTimes(2);
        detail = await retry(detail); expect(detail.turns[0].status).toBe('done'); expect(runtime.infer).toHaveBeenCalledTimes(4); expect(detail.turns[0].responses![0].answer?.content).toBe('A already done');
    });
    it('does not guess ambiguous OpenCode model names or send through unassigned models', async () => {
        const a = await agent('A', { model: 'provider/same-model' }); cards.set(local().id, { ...local(), model: 'provider/same-model' }); cards.set(remote().id, { ...remote(), model: 'provider/same-model' });
        expect((await service.agents(request(), local().id, projectId)).items.find(item => item.agentId === a.id)).toMatchObject({ status: 'blocked' }); await expect(create([a.id])).rejects.toBeInstanceOf(ConflictException);
        await db.query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [a.id, JSON.stringify({ model: 'neurocenter/' + remote().id })]); assigned.delete(remote().id);
        await expect(create([a.id])).rejects.toBeInstanceOf(ConflictException); expect(runtime.infer).not.toHaveBeenCalled();
    });
    it('withholds late results after project access is revoked', async () => {
        const a = await agent('A'), b = await agent('B'); runtime.infer.mockImplementationOnce(async () => { allowed = false; return reply('private late output'); });
        await expect(send(await create([a.id, b.id]))).rejects.toBeInstanceOf(ForbiddenException);
        expect((await db.query('SELECT status,answer FROM model_chat_agent_responses ORDER BY created_at,id')).rows.every(response => response.status === 'failed' && response.answer === null)).toBe(true);
    });
    it('rechecks the participant snapshot after the response write and rolls back a changed prompt', async () => {
        const a = await agent('A'), detail = await create([a.id]), original = service.groups.status.bind(service.groups);
        const intercept = vi.spyOn(service.groups, 'status').mockImplementation(async (...args) => {
            await original(...args); if (args[4] === 'done') await args[0].query('UPDATE project_agents SET overrides=$2::jsonb WHERE agent_id=$1', [a.id, JSON.stringify({ prompt: 'changed during commit' })]);
        });
        try {
            runtime.infer.mockResolvedValueOnce(reply('must roll back'));
            const result = await send(detail); expect(result.turns[0].status).toBe('failed'); expect(result.turns[0].responses![0].answer).toBeUndefined();
            expect(result.turns[0].responses![0].error).toContain('изменились'); expect(JSON.stringify(result)).not.toContain('must roll back');
        } finally { intercept.mockRestore(); }
    });
    it('uses the owned connection for roster checks when five concurrent reads occupy the whole pool', async () => {
        const a = await agent('A'), detail = await create([a.id]);
        const results = await Promise.all(Array.from({ length: 5 }, () => service.read(request(), detail.conversation.id)));
        expect(results.every(result => result.participants?.[0].agentId === a.id)).toBe(true);
    });
    it('shares eight paid summary calls across the whole round and retains per-model checkpoint progress', async () => {
        const a = await agent('A'), b = await agent('B', { model: 'neurocenter/' + remote().id }); let detail = await create([a.id, b.id]);
        const answer = { content: 'x'.repeat(300000), finishReason: 'stop', usage: { reported: false, inputTokens: null, outputTokens: null, totalTokens: null } };
        await db.query(`INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,input_text,attachment_ids,status,answer)
            VALUES($1,$2,$3,ARRAY[$3::uuid],$4,'old','old','{}','done',$5::jsonb)`, [randomUUID(), detail.conversation.id, randomUUID(), 'a'.repeat(64), JSON.stringify(answer)]);
        detail = await service.read(request(), detail.conversation.id); detail = await send(detail); expect(detail.turns.at(-1)?.status).toBe('failed'); expect(runtime.infer).toHaveBeenCalledTimes(8);
        expect(runtime.infer.mock.calls.every(call => (call[2].messages as Array<{ content: string }>)[0].content === COMPACTION_INSTRUCTION)).toBe(true);
        const checkpoints = (await db.query('SELECT model_pin,through_offset FROM model_chat_compactions WHERE conversation_id=$1 ORDER BY created_at', [detail.conversation.id])).rows;
        expect(checkpoints).toHaveLength(8); expect(checkpoints.every(checkpoint => checkpoint.model_pin === projectEmbeddingPin(local()))).toBe(true);
        expect((await db.query("SELECT answer->>'content' AS content FROM model_chat_turns WHERE conversation_id=$1 AND status='done'", [detail.conversation.id])).rows[0].content).toBe(answer.content);
    });
});
