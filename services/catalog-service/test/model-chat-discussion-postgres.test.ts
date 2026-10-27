import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { Pool } from 'pg';
import { createServer } from 'node:http';
import { ModelChatService } from '../src/model-chat/chat.service';
import { ModelRuntime } from '../src/models/model-runtime';
import { OllamaClient } from '../src/models/ollama-client';
import { localModelAlias } from '../src/models/local-model-alias';
import type { RemoteConnectionService } from '../src/models/remote-connection.service';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import { ModelUsageRepository } from '../src/model-usage/model-usage.repository';
import { ModelApiAdmission } from '../src/model-api-admission/model-api-admission';
import { ModelRateLimitsService } from '../src/model-rate-limits/model-rate-limits.service';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { migrateCatalog, catalogMigrationHistory } from '../src/database/migrations';
import { checkCatalogSchema } from '../src/database/catalog-schema';
import { assertChatDiscussionSchema } from '../src/model-chat/chat-discussion.schema-verification';
import type { ChatDetail } from '../src/model-chat/chat.types';
import { bounded, connection, deferred, personalGroupBridgeFixture, reply, type PersonalGroupBridgeFixture } from './personal-group-bridge-isolation.fixture';

const nativeFetch = globalThis.fetch;
const request = (owner = 'owner@localhost') => ({ headers: { 'x-owner': owner } } as unknown as Request);
const task = (agentId: string) => ({ agentId, instruction: 'Проверь свою часть.' });
const plan = (ids: string[], critic: string | null = null) => JSON.stringify({ responses: ids.map(task), critic: critic ? task(critic) : null });
const synthesis = () => JSON.stringify({ summary: 'Итог с ограничениями.', decisions: ['Согласованное решение'], disagreements: ['Нужна проверка'], nextSteps: ['Проверить результат'] });

describe.skipIf(!connection)('Automatic private group discussion — disposable PostgreSQL', () => {
    let f: PersonalGroupBridgeFixture, enabled = true;
    const steps = async () => (await f.db.query('SELECT * FROM model_chat_discussion_steps ORDER BY sequence')).rows;
    const send = (detail: ChatDetail, requestId = randomUUID(), targets?: string[]) => f.service.send(request(), detail.conversation.id, {
        expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin, requestId, prompt: 'Обсудите задачу', attachmentIds: [],
        ...(targets ? { targetAgentIds: targets } : {}),
    }, new AbortController().signal);
    const provide = (value: (phase: string, agentId: string | null | undefined, body: Record<string, unknown>) => Promise<ReturnType<typeof reply>>) => f.setProvider(async (_model, _signal, body) => {
        const usage = currentModelUsage(), step = (await f.db.query('SELECT phase FROM model_chat_discussion_steps WHERE id=$1', [usage.operationId])).rows[0];
        return value(step?.phase ?? 'legacy', usage.agentId, body!);
    });
    beforeAll(async () => {
        const disk = await statfs(process.cwd(), { bigint: true });
        if (disk.bavail * disk.bsize < 4n * 1024n ** 3n) throw new Error('Discussion PostgreSQL acceptance requires 4 GiB free disk space.');
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'discussion-owned-test-only');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags({ ...defaultFeatureFlags(), group_discussions: enabled })), { status: 200 })));
        f = await personalGroupBridgeFixture();
    });
    afterEach(async () => { enabled = true; await f?.reset(); });
    afterAll(async () => { await f?.cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    it('one send plans, saves pinned independent answers, critiques them and returns the final answer without another action', async () => {
        const a = await f.agent('A'), b = await f.agent('B', f.codex), observed: Array<{ phase: string; body: Record<string, unknown> }> = [];
        provide(async (phase, agentId, body) => { observed.push({ phase, body }); return reply(phase === 'planning' ? plan([a, b], a) : phase === 'synthesis' ? synthesis() : 'SAVED ' + agentId); });
        const detail = await send(await f.create([a, b])), turn = detail.turns[0];
        expect(turn.status).toBe('done'); expect(turn.discussion).toEqual({ mode: 'automatic', callsStarted: 5, maxCalls: 5 });
        expect(turn.responses?.map(item => [item.agentId, item.status])).toEqual([[a, 'done'], [b, 'done'], [a, 'done'], ['discussion-summary', 'done']]);
        expect(turn.responses?.[1]).toMatchObject({ modelId: f.codex.id, modelPin: projectEmbeddingPin(f.codex) });
        expect(turn.responses?.at(-1)?.answer?.content).toContain('Итог с ограничениями');
        expect(observed.map(item => item.phase)).toEqual(['planning', 'response', 'response', 'critique', 'synthesis']);
        expect(JSON.stringify(observed[0].body)).not.toContain('Persona A'); expect(JSON.stringify(observed[1].body)).not.toContain('SAVED');
        expect(JSON.stringify(observed[3].body)).toContain('SAVED ' + a); expect(JSON.stringify(observed[3].body)).toContain('SAVED ' + b);
        expect(JSON.stringify(detail)).not.toContain('"definition"'); expect(await steps()).toHaveLength(5);
        await expect(f.service.read(request('other@localhost'), detail.conversation.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sends an explicit singleton recipient directly without a planner or summary', async () => {
        const a = await f.agent('A'), b = await f.agent('B'); provide(async phase => reply(phase === 'planning' ? plan([b]) : 'UNEXPECTED'));
        const detail = await send(await f.create([a, b]), randomUUID(), [a]);
        expect(f.calls).toHaveLength(1); expect(detail.turns[0].status).toBe('done');
        expect(detail.turns[0].targetAgentIds).toEqual([a]); expect(detail.turns[0].responses?.map(item => item.agentId)).toEqual([a]);
        expect(detail.turns[0].discussion).toBeUndefined(); expect(await steps()).toEqual([]);
    });

    it('returns the sole successful contribution with a separate failed child and no synthesis', async () => {
        const a = await f.agent('A'), b = await f.agent('B');
        provide(async (phase, agentId) => { if (phase === 'planning') return reply(plan([a, b])); if (agentId === a || phase === 'synthesis') throw Error('secret-provider-url'); return reply('INDEPENDENT'); });
        const detail = await send(await f.create([a, b]));
        expect(detail.turns[0].status).toBe('done'); expect(detail.turns[0].responses?.map(item => item.status)).toEqual(['failed', 'done']);
        expect(detail.turns[0].responses?.at(-1)?.answer?.content).toContain('INDEPENDENT'); expect(JSON.stringify(detail)).not.toContain('secret-provider-url');
        expect((await steps()).map(item => item.status)).toEqual(['done', 'failed', 'done']);
    });

    it('finishes with separate errors and no summary when no accepted agent answers', async () => {
        const a=await f.agent('A'),b=await f.agent('B');
        provide(async phase=>{if(phase==='planning')return reply(plan([a,b]));throw Error('private transport failure');});
        const detail=await send(await f.create([a,b]));
        expect(detail.turns[0]).toMatchObject({status:'failed',error:expect.stringContaining('Проверенного ответа пока нет')});
        expect(detail.turns[0].responses?.map(item=>item.status)).toEqual(['failed','failed']);
        expect(detail.turns[0].responses?.some(item=>item.agentId==='discussion-summary')).toBe(false);
        expect(f.calls).toHaveLength(3);expect(JSON.stringify(detail)).not.toContain('private transport failure');
    });

    it('does not count a response and critique by the same successful agent as two responders', async () => {
        const a=await f.agent('A'),b=await f.agent('B');
        provide(async phase=>reply(phase==='planning'?plan([a],a):'SAVED '+phase));
        const detail=await send(await f.create([a,b]));
        expect(detail.turns[0].responses?.map(item=>item.agentId)).toEqual([a,a]);
        expect((await steps()).map(item=>item.phase)).toEqual(['planning','response','critique']);
        expect(detail.turns[0].responses?.some(item=>item.agentId==='discussion-summary')).toBe(false);
    });

    it('reconciles a lost delivery ACK by the original request without repeating accepted work or changing completed receipts', async () => {
        const a = await f.agent('A'), b = await f.agent('B'); provide(async phase => reply(phase === 'planning' ? plan([a]) : phase === 'synthesis' ? synthesis() : 'IMMUTABLE'));
        const initial = await f.create([a,b]), requestId = randomUUID();
        await expect(send(initial, requestId).then(() => { throw Error('lost delivery ACK'); })).rejects.toThrow('lost delivery ACK');
        const before = await steps(), count = f.calls.length, reconciled = await send(initial, requestId);
        expect(reconciled.turns[0].status).toBe('done'); expect(f.calls).toHaveLength(count); expect(await steps()).toEqual(before);
        const saved = before.find(item => item.phase === 'response');
        await expect(f.db.query("UPDATE model_chat_discussion_steps SET output='replacement' WHERE id=$1", [saved.id])).rejects.toThrow('immutable');
        await expect(f.db.query('DELETE FROM model_chat_discussion_steps WHERE id=$1', [saved.id])).rejects.toThrow('immutable');
        await expect(f.db.query('UPDATE model_chat_discussions SET calls_started=0 WHERE turn_id=$1', [saved.turn_id])).rejects.toThrow('immutable');
        expect(await steps()).toEqual(before);
    });

    it('retains a saved answer after cancellation and rejects held late output without running synthesis or a second participant again', async () => {
        const a = await f.agent('A'), b = await f.agent('B'), entered = deferred(), held = deferred();
        provide(async (phase, agentId) => { if (phase === 'planning') return reply(plan([a, b])); if (agentId === b) { entered.resolve(); await held.promise; } return reply(agentId === a ? 'SAVED FIRST' : 'LATE'); });
        const initial = await f.create([a, b]), pending = send(initial);
        try {
            await bounded(entered.promise); const current = await f.read(initial.conversation.id), cancelled = await f.cancel(current);
            expect(cancelled.turns[0].status).toBe('cancelled'); expect(cancelled.turns[0].responses?.map(item => item.status)).toEqual(['done', 'cancelled']);
            expect(cancelled.turns[0].responses?.[0].answer?.content).toBe('SAVED FIRST'); held.resolve(); await bounded(pending);
            expect((await steps()).some(item => item.output === 'LATE')).toBe(false); expect(f.calls).toHaveLength(3);
            await expect(f.retry(await f.read(initial.conversation.id))).rejects.toBeInstanceOf(ConflictException);
            expect(f.calls).toHaveLength(3);
        } finally { held.resolve(); await pending.catch(() => undefined); }
    });

    it('preserves a saved partial answer in the next question context after cancellation without re-running its step', async () => {
        const a = await f.agent('A'), b = await f.agent('B'), entered = deferred(), held = deferred();
        provide(async (phase, agentId) => { if (phase === 'planning') return reply(plan([a, b])); if (agentId === b) { entered.resolve(); await held.promise; } return reply('PARTIAL FACT 7391'); });
        const initial = await f.create([a, b]), pending = send(initial);
        try { await bounded(entered.promise); await f.cancel(await f.read(initial.conversation.id)); held.resolve(); await bounded(pending); }
        finally { held.resolve(); await pending.catch(() => undefined); }
        const saved = (await steps()).find(item => item.phase === 'response' && item.status === 'done'), observed: Record<string, unknown>[] = [];
        provide(async (phase, _agent, body) => { if (phase === 'response') observed.push(body); return reply(phase === 'planning' ? plan([a]) : phase === 'synthesis' ? synthesis() : 'CONTINUED'); });
        const current = await f.read(initial.conversation.id), result = await send(current);
        expect(result.turns).toHaveLength(2); expect(result.turns[1].status).toBe('done');
        expect(JSON.stringify(observed)).toContain('PARTIAL FACT 7391'); expect(JSON.stringify(observed)).toContain('Сохранённый частичный ответ A');
        expect((await f.db.query('SELECT * FROM model_chat_discussion_steps WHERE id=$1', [saved.id])).rows[0]).toEqual(saved);
        expect((await f.db.query('SELECT status,answer FROM model_chat_turns WHERE id=$1', [saved.turn_id])).rows[0]).toEqual({ status: 'cancelled', answer: null });
    });

    it('observes a concurrent same-request send while work is held without dispatching a second planner', async () => {
        const a = await f.agent('A'), b = await f.agent('B'), entered = deferred(), held = deferred(), requestId = randomUUID();
        provide(async phase => { if (phase === 'planning') { entered.resolve(); await held.promise; return reply(plan([a])); } return reply(phase === 'synthesis' ? synthesis() : 'ANSWER'); });
        const initial = await f.create([a,b]), first = send(initial, requestId);
        try { await bounded(entered.promise); const concurrent = await bounded(send(initial, requestId));
            expect(concurrent.turns[0].status).toBe('pending'); expect(f.calls).toHaveLength(1); expect(await steps()).toHaveLength(1);
        } finally { held.resolve(); await bounded(first); }
        expect(f.calls).toHaveLength(2); expect((await f.db.query('SELECT id FROM model_chat_turns')).rows).toHaveLength(1);
    });

    it('retains a dispatched unknown usage marker and accepted step without replay after a lost provider outcome or a fresh reader', async () => {
        const a = await f.agent('A'), b = await f.agent('B'), usage = new ModelUsageRepository(f.db), usageId = randomUUID(), worker = randomUUID();
        provide(async () => { const context = currentModelUsage();
            await usage.begin({ ...context, id: usageId, workerId: worker, model: f.server, endpoint: 'chat' });
            await usage.dispatchProgress(usageId, worker, 1, new Date().toISOString(), null);
            throw Error('controlled process lost an already dispatched outcome');
        });
        const initial = await f.create([a,b]), requestId = randomUUID(); await send(initial, requestId);
        const before = await steps(), marker = (await f.db.query('SELECT * FROM model_usage_calls WHERE id=$1', [usageId])).rows[0];
        expect(marker).toMatchObject({ status: 'pending', dispatch_count: 1, operation_id: before[0].id });
        const reader = new ModelChatService(f.models, f.runtime as unknown as ModelRuntime);
        try { await reader.read(request(), initial.conversation.id); await send(initial, requestId); }
        finally { await reader.onApplicationShutdown(); }
        expect(f.calls).toHaveLength(1); expect(await steps()).toEqual(before);
        expect((await f.db.query('SELECT * FROM model_usage_calls WHERE id=$1', [usageId])).rows[0]).toEqual(marker);
    });

    it('stops every later dispatch and withholds the late answer when the original actor role changes', async () => {
        const a = await f.agent('A'), b = await f.agent('B');
        provide(async phase => { if (phase === 'planning') return reply(plan([a, b])); f.changeRole('Админ проекта'); return reply('PRIVATE LATE'); });
        await expect(send(await f.create([a, b]))).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.calls).toHaveLength(2); expect((await steps()).some(item => item.output === 'PRIVATE LATE')).toBe(false);
    });

    it('keeps received results and readable history when the flag turns off, and then uses the existing legacy group path', async () => {
        const a = await f.agent('A'), b = await f.agent('B');
        provide(async phase => { if (phase === 'planning') return reply(plan([a, b])); enabled = false; return reply('RETAINED'); });
        let detail = await send(await f.create([a, b])); expect(f.calls).toHaveLength(2);
        expect(detail.turns[0].responses?.find(item => item.status === 'done')?.answer?.content).toBe('RETAINED');
        expect(detail.turns[0].responses?.some(item => item.agentId === 'discussion-summary')).toBe(false);
        expect((await f.read(detail.conversation.id)).turns).toHaveLength(1);
        provide(async () => reply('LEGACY')); detail = await send(detail);
        expect(detail.turns[1].discussion).toBeUndefined(); expect(detail.turns[1].responses?.map(item => item.agentId)).toEqual([a, b]); expect(f.calls).toHaveLength(4);
    });

    it('rejects a transport aborted before durable acceptance without creating a turn or dispatching work', async () => {
        const a = await f.agent('A'), initial = await f.create([a]), client = new AbortController(); client.abort();
        await expect(f.service.send(request(), initial.conversation.id, { expectedRevision: initial.conversation.revision, expectedModelPin: initial.conversation.modelPin,
            requestId: randomUUID(), prompt: 'Never accepted', attachmentIds: [] }, client.signal)).rejects.toThrow();
        expect(f.calls).toHaveLength(0); expect((await f.db.query('SELECT id FROM model_chat_turns')).rows).toEqual([]);
        expect((await f.db.query('SELECT turn_id FROM model_chat_discussions')).rows).toEqual([]);
        expect((await f.read(initial.conversation.id)).conversation.revision).toBe(initial.conversation.revision);
    });

    it('rolls back admission when browser loss arrives during asynchronous roster preparation before acceptance', async () => {
        const a = await f.agent('A'), initial = await f.create([a]), entered = deferred(), held = deferred(), client = new AbortController();
        const original = f.service.groups.plan.bind(f.service.groups), prepare = vi.spyOn(f.service.groups, 'plan').mockImplementationOnce(async (...args) => {
            const roster = await original(...args); entered.resolve(); await held.promise; return roster;
        });
        provide(async phase => reply(phase === 'planning' ? plan([a]) : phase === 'synthesis' ? synthesis() : 'UNACCEPTED'));
        const pending = f.service.send(request(), initial.conversation.id, { expectedRevision: initial.conversation.revision,
            expectedModelPin: initial.conversation.modelPin, requestId: randomUUID(), prompt: 'Never accepted', attachmentIds: [] }, client.signal);
        let failure: unknown;
        try { await bounded(entered.promise); client.abort(); held.resolve(); try { await bounded(pending); } catch (error) { failure = error; } }
        finally { held.resolve(); await pending.catch(() => undefined); prepare.mockRestore(); }
        expect(f.calls).toHaveLength(0); expect(failure).toBeDefined();
        expect((await f.db.query('SELECT id FROM model_chat_turns')).rows).toEqual([]);
        expect((await f.db.query('SELECT turn_id FROM model_chat_discussions')).rows).toEqual([]);
        expect((await f.read(initial.conversation.id)).conversation.revision).toBe(initial.conversation.revision);
    });

    it.each(['model','legacy','automatic'] as const)('keeps an accepted %s turn running after browser loss and reopens it without replay', async mode => {
        enabled = mode !== 'legacy'; const a = await f.agent('A'), b = await f.agent('B'), entered = deferred(), held = deferred(), requestId = randomUUID();
        provide(async phase => { if (phase === 'planning') return reply(plan([a,b])); if (phase === 'synthesis') return reply(synthesis()); entered.resolve(); await held.promise; return reply('SERVER OWNED RESULT'); });
        const initial = mode === 'model' ? await f.service.create(request(), { modelId: f.server.id, projectId: 'prj-personal-bridge', expectedModelPin: projectEmbeddingPin(f.server) }) : await f.create([a,b]);
        const client = new AbortController(), pending = f.service.send(request(), initial.conversation.id, { expectedRevision: initial.conversation.revision,
            expectedModelPin: initial.conversation.modelPin, requestId, prompt: 'Обсудите задачу', attachmentIds: [] }, client.signal);
        try {
            await bounded(entered.promise); const acceptedCalls = f.calls.length; client.abort();
            const reopened = await f.read(initial.conversation.id); expect(reopened.turns[0].status).toBe('pending');
            expect(f.runtime.infer.mock.calls.at(-1)?.[3]?.aborted).toBe(false);
            expect((await send(initial, requestId)).turns[0].status).toBe('pending'); expect(f.calls).toHaveLength(acceptedCalls);
            held.resolve(); await bounded(pending); const complete = await f.read(initial.conversation.id);
            expect(complete.turns[0].status).toBe('done'); expect(JSON.stringify(complete)).toContain(mode === 'automatic' ? 'Итог с ограничениями' : 'SERVER OWNED RESULT');
            const paid = f.calls.length; await send(initial, requestId); expect(f.calls).toHaveLength(paid);
        } finally { held.resolve(); await pending.catch(() => undefined); }
    });

    it('retains actual truncated finish metadata in saved answers and synthesis without replaying paid work', async () => {
        const a = await f.agent('A'), b = await f.agent('B'), synthesisBodies: Record<string, unknown>[] = [];
        provide(async (phase, _agent, body) => { if (phase === 'planning') return reply(plan([a,b]));
            if (phase === 'synthesis') synthesisBodies.push(body);
            return { ...reply(phase === 'synthesis' ? synthesis() : 'TRUNCATED CONTRIBUTION'), done_reason: 'length' };
        });
        const initial = await f.create([a,b]), requestId = randomUUID(), detail = await send(initial, requestId), child = detail.turns[0].responses![0];
        expect(child.answer?.finishReason).toBe('length'); expect(child.answer?.content).toBe('TRUNCATED CONTRIBUTION');
        expect(detail.turns[0].responses?.at(-1)?.answer?.finishReason).toBe('length');
        expect(JSON.parse((synthesisBodies[0].messages as Array<{content:string}>).at(-1)!.content).contributions).toContainEqual(expect.objectContaining({agentId:a,finishReason:'length'}));
        const saved = await steps(); expect(saved.filter(item => ['response','synthesis'].includes(item.phase)).map(item => item.finish_reason)).toEqual(['length','length','length']);
        await expect(f.db.query("UPDATE model_chat_discussion_steps SET finish_reason='stop' WHERE id=$1", [child.id])).rejects.toThrow('immutable');
        const count = f.calls.length; await send(initial, requestId); expect(f.calls).toHaveLength(count); expect(await steps()).toEqual(saved);
        expect((await f.read(initial.conversation.id)).turns[0].responses?.[0].answer?.finishReason).toBe('length');
    });

    it('rejects an overflowing retained history before planning or any specialist request without losing its middle', async () => {
        const a = await f.agent('A'), b = await f.agent('B'), initial = await f.create([a,b]);
        const answer = (content: string) => ({ content, finishReason: 'stop', usage: { inputTokens: null, outputTokens: null, totalTokens: null, reported: false } });
        for (const [prompt, content] of [['Prefix', 'PREFIX'], ['Middle', 'MISSING_MIDDLE_FACT_9625' + 'x'.repeat(8 * 1024 ** 2 - 64)], ['Tail', 'TAIL']]) {
            const requestId = randomUUID(); await f.db.query(`INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,attachment_ids,input_text,status,answer)
                VALUES($1,$2,$3,ARRAY[$3::uuid],$4,$5,'{}',$5,'done',$6::jsonb)`, [randomUUID(), initial.conversation.id, requestId, 'c'.repeat(64), prompt, JSON.stringify(answer(content))]);
        }
        provide(async phase => reply(phase === 'planning' ? plan([a]) : phase === 'synthesis' ? synthesis() : 'UNSAFE TRUNCATED ANSWER'));
        const oldWindow = process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS; process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS = '';
        const chat = new ModelChatService(f.models, f.runtime as unknown as ModelRuntime);
        try {
            const source = await chat.repository.sources(f.db, initial.conversation.id, null);
            expect(source.overflow).toBe(true); expect(JSON.stringify(source.turns)).not.toContain('MISSING_MIDDLE_FACT_9625');
            const before = (await f.db.query('SELECT id,status,request_id,answer FROM model_chat_turns ORDER BY position')).rows;
            let failure: unknown; try { await chat.send(request(), initial.conversation.id, { expectedRevision: initial.conversation.revision,
                expectedModelPin: initial.conversation.modelPin, requestId: randomUUID(), prompt: 'Continue from the retained middle', attachmentIds: [] }, new AbortController().signal); } catch (error) { failure = error; }
            expect(f.calls).toHaveLength(0); expect(failure).toBeInstanceOf(BadRequestException);
            expect((await f.db.query('SELECT id,status,request_id,answer FROM model_chat_turns ORDER BY position')).rows).toEqual(before);
            expect((await f.db.query('SELECT revision FROM model_chat_conversations WHERE id=$1', [initial.conversation.id])).rows[0].revision).toBe(initial.conversation.revision);
            expect((await f.db.query("SELECT left(answer->>'content',length('MISSING_MIDDLE_FACT_9625')) AS marker FROM model_chat_turns WHERE prompt='Middle'")).rows[0].marker).toBe('MISSING_MIDDLE_FACT_9625');
        } finally { await chat.onApplicationShutdown(); if (oldWindow === undefined) delete process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS; else process.env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS = oldWindow; }
    });

    it('runs the actual dispatcher, SQL usage recorder and rate admission against only an owned loopback protocol fixture', async () => {
        const a = await f.agent('A'), b = await f.agent('B'), alias = localModelAlias(f.server), paid: Record<string, unknown>[] = [];
        const server = createServer(async (incoming, outgoing) => {
            outgoing.setHeader('content-type', 'application/json');
            if (incoming.url === '/api/tags' && incoming.method === 'GET') { outgoing.end(JSON.stringify({ models: [{ name: alias, digest: f.server.manifestSha256 }] })); return; }
            if (incoming.url !== '/api/chat' || incoming.method !== 'POST') { outgoing.writeHead(404); outgoing.end('{}'); return; }
            let raw = ''; for await (const chunk of incoming) { raw += chunk; if (Buffer.byteLength(raw) > 131072) { outgoing.writeHead(413); outgoing.end('{}'); return; } }
            const body = JSON.parse(raw); paid.push(body); const first = body.messages[0]?.content ?? '';
            const content = first.startsWith('Раздели вопрос') ? plan([a, b], a) : first.startsWith('Собери итог') ? synthesis() : 'LOOPBACK CONTRIBUTION';
            outgoing.end(JSON.stringify({ model: alias, done: true, done_reason: 'stop', message: { role: 'assistant', content }, prompt_eval_count: 10, eval_count: 5 }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port, usage = new ModelUsageService(f.models), limits = new ModelRateLimitsService(f.models);
        const local = new OllamaClient({ fetch: nativeFetch, env: { ...process.env, NODE_ENV: 'test', MODEL_RUNTIME_URL: 'http://127.0.0.1:' + port }, admission: new ModelApiAdmission(limits) });
        const runtime = new ModelRuntime(local, {} as RemoteConnectionService, usage), chat = new ModelChatService(f.models, runtime);
        try {
            await usage.onModuleInit(); await limits.onModuleInit(); const initial = await f.create([a, b]);
            const result = await chat.send(request(), initial.conversation.id, { expectedRevision: initial.conversation.revision, expectedModelPin: initial.conversation.modelPin,
                requestId: randomUUID(), prompt: 'Discuss synthetic protocol fixture', attachmentIds: [] }, new AbortController().signal);
            expect(result.turns[0].status).toBe('done'); expect(paid).toHaveLength(5); expect(f.calls).toHaveLength(0);
            const journal = (await f.db.query('SELECT * FROM model_usage_calls WHERE turn_id=$1 ORDER BY started_at,id', [result.turns[0].id])).rows, receipts = await steps();
            expect(journal).toHaveLength(5); expect(journal.every(item => item.status === 'success' && item.dispatch_count === 1 && item.actor_email === 'owner@localhost' && item.project_id === 'prj-personal-bridge')).toBe(true);
            expect(journal.map(item => item.operation_id).sort()).toEqual(receipts.map(item => item.id).sort());
            expect(receipts.every(item => item.model_pin === projectEmbeddingPin(f.server))).toBe(true);
            expect(JSON.stringify(journal)).not.toContain('Discuss synthetic protocol fixture'); expect(JSON.stringify(journal)).not.toContain('LOOPBACK CONTRIBUTION');
        } finally { await chat.onApplicationShutdown(); await usage.onApplicationShutdown(); await limits.onApplicationShutdown(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    });

    it('upgrades schema33 with existing group history, preserves all old facts and rejects constraint tampering transactionally', async () => {
        const schema = 'discussion_upgrade_' + randomUUID().replaceAll('-', '');
        await f.db.query('CREATE SCHEMA ' + schema);
        const pool = new Pool({ connectionString: String(f.db.options.connectionString), max: 1, options: '-c search_path=' + schema });
        try {
            await migrateCatalog(pool, CATALOG_MIGRATIONS.filter(item => item.version <= 33));
            const old = await catalogMigrationHistory(pool, CATALOG_MIGRATIONS), conversation = randomUUID(), turn = randomUUID(), requestId = randomUUID();
            expect(old.pending).toEqual(CATALOG_MIGRATIONS.filter(item => item.version > 33).map(item => item.version));
            await pool.query("INSERT INTO model_catalog(id,name,descriptor) VALUES('model-old','Old','{}')");
            await pool.query("INSERT INTO projects(id,name) VALUES('project-old','Old')");
            await pool.query("INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,title,model_pin,mode,agent_ids) VALUES($1,'owner@localhost','model-old','project-old','Old',$2,'group',ARRAY['agent-old'])", [conversation, 'a'.repeat(64)]);
            const answer = { content: 'OLD GROUP HISTORY', finishReason: 'stop', usage: { inputTokens: null, outputTokens: null, totalTokens: null, reported: false } };
            await pool.query("INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,attachment_ids,input_text,status,answer,target_agent_ids) VALUES($1,$2,$3,ARRAY[$3::uuid],$4,'Old','{}','Old','done',$5::jsonb,ARRAY['agent-old'])", [turn, conversation, requestId, 'b'.repeat(64), JSON.stringify(answer)]);
            await pool.query("INSERT INTO model_chat_agent_responses(id,conversation_id,turn_id,agent_id,snapshot,request_id,status,answer) VALUES($1,$2,$3,'agent-old','{}',$4,'done',$5::jsonb)", [randomUUID(), conversation, turn, requestId, JSON.stringify(answer)]);
            const before = (await pool.query('SELECT * FROM model_chat_turns')).rows;
            const originalColumns = Object.keys(before[0]);
            const preservedTurns = async () => (await pool.query('SELECT * FROM model_chat_turns')).rows
                .map(row => Object.fromEntries(originalColumns.map(column => [column,row[column]])));
            await migrateCatalog(pool, CATALOG_MIGRATIONS.filter(item => item.version <= 34));
            await pool.query(`INSERT INTO model_chat_discussions(turn_id,request_id,actor_role,model,roster,deadline_at)
                VALUES($1,$2,'Разработчик','{}','[{}]',now()+interval '2 minutes')`, [turn,requestId]);
            const legacy = (await pool.query('SELECT * FROM model_chat_discussions')).rows[0];
            await migrateCatalog(pool, CATALOG_MIGRATIONS); expect((await checkCatalogSchema(pool, true)).applied).toContain(34);
            const {summary_policy:policy,...upgraded}=(await pool.query('SELECT * FROM model_chat_discussions')).rows[0];
            expect(policy).toBe('legacy');expect(upgraded).toEqual(legacy);
            expect(await preservedTurns()).toEqual(before);
            expect((await pool.query('SELECT answer FROM model_chat_agent_responses')).rows[0].answer).toEqual(answer);
            const client = await pool.connect();
            try { await client.query('BEGIN'); await client.query('ALTER TABLE model_chat_discussions DROP CONSTRAINT model_chat_discussions_calls_started_check');
                await expect(assertChatDiscussionSchema(client)).rejects.toThrow('model_chat_discussions_calls_started_check');
            } finally { await client.query('ROLLBACK'); client.release(); }
            await expect(checkCatalogSchema(pool, true)).resolves.toMatchObject({ ready: true });
            await expect(migrateCatalog(pool, CATALOG_MIGRATIONS.filter(item => item.version <= 33))).rejects.toThrow('автоматический откат');
            expect(await preservedTurns()).toEqual(before);
        } finally { await pool.end(); await f.db.query('DROP SCHEMA ' + schema + ' CASCADE'); }
    });
});
