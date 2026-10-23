vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import 'reflect-metadata';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCatalogSchema, checkCatalogSchema } from '../src/database/catalog-schema';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import {assertChatResearchSchema} from '../src/model-chat/chat-research.schema-verification';
import { withModelUsage, currentModelUsage } from '../src/model-usage/model-usage.context';
import { ModelRuntime } from '../src/models/model-runtime';
import type { ModelsService } from '../src/models/models.service';
import type { OllamaClient } from '../src/models/ollama-client';
import type { RemoteConnectionService } from '../src/models/remote-connection.service';
import type { IAccessClaims } from '../src/access/access.model';
import type { IModel } from '../src/models/model.types';

const connection = process.env.MODEL_USAGE_TEST_PG_URL;
const model: IModel = { id: 'model-usage', name: 'Usage model', description: '', capability: 'chat', runtime: 'ollama', model: 'test:usage', manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '2026-10-21', updatedAt: '2026-10-21' };
const req = (role = 'Главный админ', email = 'main@localhost') => ({ headers: { role, email } } as unknown as Request);
const output = (counts: Record<string, unknown> = {}) => ({ message: { role: 'assistant', content: 'private answer must never be stored' }, ...counts });

describe('Usage context isolation', () => {
    it('restores parent attribution across nested purposes and concurrent asynchronous work', async () => {
        const result = await Promise.all(['a@localhost', 'b@localhost'].map(actorEmail => withModelUsage({ purpose: 'agent', actorEmail, agentId: 'agent-a' }, async () => {
            await Promise.resolve(); const compacted = withModelUsage({ purpose: 'compaction' }, () => currentModelUsage()); return { actor: currentModelUsage(), compacted };
        })));
        expect(result.map(item => item.actor.actorEmail)).toEqual(['a@localhost', 'b@localhost']); expect(result.every(item => item.compacted.purpose === 'compaction' && item.compacted.agentId === 'agent-a')).toBe(true);
        expect(currentModelUsage()).toEqual({ purpose: 'direct' });
    });
});

describe.skipIf(!connection)('Model usage ledger — disposable PostgreSQL', () => {
    let admin: Pool, db: Pool, database: string, service: ModelUsageService, oldUrl: string | undefined;
    let revoked = false;
    const claims = (email: string): IAccessClaims => ({ email, userRoles: ['Главный админ', 'Админ проекта', 'Разработчик', 'Наблюдатель'], projects: revoked ? [] : [{ projectId: 'prj-a', projectName: 'A', role: 'Админ проекта' }], pluginIds: [], skillPaths: [] });
    const models = { ready: async () => undefined, actor: async (request: Request) => ({ email: String(request.headers.email), activeRole: String(request.headers.role), claims: claims(String(request.headers.email)) }),
        resolveProject: async (_request: Request, id: string) => { if (id !== 'prj-a' || revoked) throw new ForbiddenException('No project access'); return { id }; } };
    const call = (counts: Record<string, unknown> = {}, email = 'owner@localhost', projectId: string | null = 'prj-a') => withModelUsage({ purpose: 'chat', actorEmail: email, projectId }, () => service.observe(model, 'chat', async () => output(counts)));
    const report = (request = req(), query = {}) => service.report(request, query);
    const rows = () => db.query('SELECT * FROM model_usage_calls ORDER BY started_at,id').then(result => result.rows);
    const privateRoom = async () => {
        const roomId = randomUUID(), sourceId = randomUUID(), member = `usage-member-${randomUUID()}@localhost`;
        await db.query("INSERT INTO projects(id,name) VALUES('prj-a','A') ON CONFLICT(id) DO NOTHING");
        await db.query('INSERT INTO platform_users(email) VALUES($1)', [member]);
        await db.query(`INSERT INTO project_chat_rooms(project_id,id,title,visibility,creator_email,create_request_key,create_request_hash)
            VALUES('prj-a',$1,'Private fixture','PRIVATE','owner@localhost',$2,$3)`, [roomId, randomUUID(), 'a'.repeat(64)]);
        await db.query("INSERT INTO project_chat_room_members(project_id,room_id,email) VALUES('prj-a',$1,$2)", [roomId, member]);
        await db.query(`INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,generation)
            VALUES($1,'prj-a',$2,'user','private source must stay out of usage','owner@localhost','Owner','Разработчик','done',$3,$4,$5)`, [sourceId, roomId, randomUUID(), 'b'.repeat(64), randomUUID()]);
        return { roomId, sourceId, member, cleanup: async () => { await db.query("DELETE FROM projects WHERE id='prj-a'"); await db.query('DELETE FROM platform_users WHERE email=$1', [member]); } };
    };
    beforeAll(async () => {
        const url = new URL(connection!); if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '5432' || url.pathname !== '/postgres' || url.search || url.hash) throw new Error('Use a disposable localhost PostgreSQL admin URL without query or fragment');
        url.pathname = '/postgres'; admin = new Pool({ connectionString: url.href, max: 1 }); database = 'nc_usage_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; db = new Pool({ connectionString: url.href, max: 4 }); await ensureCatalogSchema(db);
        oldUrl = process.env.CATALOG_PG_URL; process.env.CATALOG_PG_URL = url.href; service = new ModelUsageService(models as unknown as ModelsService); await service.onModuleInit();
    });
    afterEach(async () => { vi.restoreAllMocks(); revoked = false; await db?.query('TRUNCATE model_usage_calls'); });
    afterAll(async () => { await service?.onApplicationShutdown(); await db?.end(); if (admin) { await admin.query('DROP DATABASE ' + database); await admin.end(); } if (oldUrl === undefined) delete process.env.CATALOG_PG_URL; else process.env.CATALOG_PG_URL = oldUrl; });
    it('is migration-owned and writes the pending UUID before actual inference', async () => {
        expect((await checkCatalogSchema(db, true)).applied.at(-1)).toBe(CATALOG_MIGRATIONS.at(-1)!.version);
        await service.observe(model, 'chat', async () => { const pending = await rows(); expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ status: 'pending', input_tokens: null, output_tokens: null }); expect(pending[0].id).toMatch(/^[a-f0-9-]{36}$/); return output(); });
        expect((await rows())[0]).toMatchObject({ status: 'success', input_tokens: null, output_tokens: null, lease_until: null });
    });
    it('readiness detects usage-specific physical drift without contacting a provider', async () => {
        const client = await db.connect();
        try { for (const sql of ['DROP INDEX model_usage_calls_pending', 'ALTER TABLE model_usage_calls ALTER COLUMN purpose DROP NOT NULL', 'ALTER TABLE model_usage_calls DROP CONSTRAINT model_usage_calls_check']) {
            await client.query('BEGIN'); await client.query(sql); await expect(assertChatResearchSchema(client)).rejects.toThrow('не готова'); await client.query('ROLLBACK');
        } } finally { await client.query('ROLLBACK'); client.release(); }
        await expect(assertChatResearchSchema(db)).resolves.toBeUndefined();
    });
    it('the central runtime records exactly one actual dispatch, preserving selected identity', async () => {
        const local = { infer: vi.fn(async () => output({ prompt_eval_count: 0, eval_count: 7, usage_reported: true })) }, remote = { infer: vi.fn(async () => output()) };
        const runtime = new ModelRuntime(local as unknown as OllamaClient, remote as unknown as RemoteConnectionService, service), turnId = randomUUID();
        await withModelUsage({ purpose: 'agent', actorEmail: 'owner@localhost', projectId: 'prj-a', agentId: 'agent-reviewer', turnId }, () => runtime.infer(model, 'chat', { messages: [{ role: 'user', content: 'private prompt and key' }] }));
        expect(local.infer).toHaveBeenCalledOnce(); expect(remote.infer).not.toHaveBeenCalled(); const saved = await rows(); expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ purpose: 'agent', actor_email: 'owner@localhost', project_id: 'prj-a', agent_id: 'agent-reviewer', turn_id: turnId, input_tokens: '0', output_tokens: '7' });
        expect(JSON.stringify(saved)).not.toMatch(/private prompt and key|private answer must never be stored/);
    });
    it('does not invent zero tokens and aggregates reported integers without precision loss', async () => {
        await call(); await call({ prompt_eval_count: 0, eval_count: 0, usage_reported: true });
        await call({ prompt_eval_count: Number.MAX_SAFE_INTEGER, eval_count: 2 }); await call({ prompt_eval_count: Number.MAX_SAFE_INTEGER, eval_count: 3 });
        const result = await report(); expect(result.summary).toMatchObject({ requests: 4, inputTokens: (BigInt(Number.MAX_SAFE_INTEGER) * 2n).toString(), outputTokens: '5', knownInputRequests: 3, unknownInputRequests: 1, unknownOutputRequests: 1 });
    });
    it('stores safe failure status without provider error text, prompts, replies or keys', async () => {
        await expect(service.observe(model, 'chat', async () => { throw new Error('api-key=provider-secret; prompt=private'); })).rejects.toThrow('provider-secret');
        expect((await rows())[0]).toMatchObject({ status: 'error', input_tokens: null, output_tokens: null }); expect(JSON.stringify(await rows())).not.toMatch(/provider-secret|prompt=private|api-key/);
    });
    it('aborts upstream and records cancellation rather than a synthetic success', async () => {
        const abort = new AbortController(); let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
        const pending = service.observe(model, 'chat', async signal => { began(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); return output(); }, abort.signal);
        await started; abort.abort(); await expect(pending).rejects.toThrow(); expect((await rows())[0].status).toBe('cancelled');
    });
    it('does not send paid work if the initial durable receipt cannot be written', async () => {
        const begin = vi.spyOn(service.repository, 'begin').mockRejectedValueOnce(new Error('database unavailable')), actual = vi.fn(async () => output());
        await expect(service.observe(model, 'chat', actual)).rejects.toBeInstanceOf(ServiceUnavailableException); expect(actual).not.toHaveBeenCalled(); expect(await rows()).toEqual([]); begin.mockRestore();
    });
    it('returns a completed answer after terminal write failure and retries only its receipt', async () => {
        const finish = vi.spyOn(service.repository, 'finish').mockRejectedValueOnce(new Error('lost DB acknowledgement')), actual = vi.fn(async () => output({ prompt_eval_count: 4 }));
        expect(await service.observe(model, 'chat', actual)).toMatchObject(output({ prompt_eval_count: 4 })); expect(actual).toHaveBeenCalledOnce(); expect((await rows())[0].status).toBe('pending'); finish.mockRestore();
        await (service as unknown as { maintain(): Promise<void> }).maintain(); expect(actual).toHaveBeenCalledOnce(); expect((await rows())[0]).toMatchObject({ status: 'success', input_tokens: '4' });
    });
    it('recovers only expired leases, preserves live workers and accepts a later confirmed outcome', async () => {
        const expired = randomUUID(), live = randomUUID(), worker = randomUUID();
        for (const id of [expired, live]) await service.repository.begin({ id, workerId: worker, model, endpoint: 'chat', purpose: 'direct' });
        await db.query("UPDATE model_usage_calls SET lease_until=now()-interval '1 second' WHERE id=$1", [expired]); await service.repository.recover();
        expect((await rows()).find(row => row.id === expired)).toMatchObject({ status: 'interrupted', latency_ms: null, input_tokens: null }); expect((await rows()).find(row => row.id === live).status).toBe('pending');
        await service.repository.finish(expired, worker, { status: 'success', inputTokens: 2, outputTokens: null, latencyMs: 100 }); expect((await rows()).find(row => row.id === expired).status).toBe('success');
    });
    it('shutdown cancels its actual call and never interrupts another worker lease', async () => {
        const second = new ModelUsageService(models as unknown as ModelsService); await second.onModuleInit();
        const foreign = randomUUID(); await service.repository.begin({ id: foreign, workerId: randomUUID(), model, endpoint: 'chat', purpose: 'direct' }); let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
        const pending = second.observe(model, 'chat', async signal => { began(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('shutdown')), { once: true })); return output(); });
        const rejected = expect(pending).rejects.toThrow('shutdown'); await started; await second.onApplicationShutdown(); await rejected;
        expect((await rows()).find(row => row.id === foreign).status).toBe('pending'); expect((await rows()).filter(row => row.worker_id === second.workerId).map(row => row.status)).toEqual(['cancelled']);
    });
    it('scopes main, project admin and developer reports to current grants and personal calls', async () => {
        await call({}, 'owner@localhost', 'prj-a'); await call({}, 'other@localhost', 'prj-a'); await call({}, 'owner@localhost', 'prj-b'); await call({}, 'owner@localhost', null);
        expect((await report()).summary.requests).toBe(4); expect((await report(req('Админ проекта', 'admin@localhost'))).summary.requests).toBe(2);
        expect((await report(req('Разработчик', 'owner@localhost'))).summary.requests).toBe(2); revoked = true;
        expect((await report(req('Разработчик', 'owner@localhost'))).summary.requests).toBe(1);
        await expect(report(req('Наблюдатель'))).rejects.toBeInstanceOf(ForbiddenException); await expect(report(req('Админ проекта'), { projectId: 'prj-b' })).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('hides private usage from nonmembers in every aggregate and facet, preserving creator/member and legacy public history', async () => {
        const f = await privateRoom();
        try {
            await call();
            await withModelUsage({ purpose: 'chat', actorEmail: 'other@localhost', projectId: 'prj-a', turnId: randomUUID() }, () => service.observe(model, 'chat', async () => output()));
            await withModelUsage({ purpose: 'agent', actorEmail: 'private-actor@localhost', projectId: 'prj-a', agentId: 'private-agent', turnId: f.sourceId, privateProjectChatRoomId: f.roomId },
                () => service.observe({ ...model, id: 'private-model', name: 'private-model-name', runtime: 'remote-openai' }, 'chat', async () => output({ prompt_eval_count: 11, eval_count: 17 })));
            const hidden = await report(); expect(hidden.summary.requests).toBe(2);
            expect(JSON.stringify(hidden)).not.toMatch(/private-model|private-agent|private-actor|private source|remote-openai/);
            expect((await report(req(), { actorEmail: 'private-actor@localhost' })).summary.requests).toBe(0);
            expect((await report(req('Админ проекта', 'admin@localhost'))).summary.requests).toBe(2);
            expect((await report(req('Разработчик', 'owner@localhost'))).summary.requests).toBe(1);
            expect((await report(req('Главный админ', 'owner@localhost'))).summary.requests).toBe(3);
            expect((await report(req('Админ проекта', f.member))).summary).toMatchObject({ requests: 3, inputTokens: '11', outputTokens: '17' });
            expect((await rows()).find(row => row.purpose === 'agent')).toMatchObject({ private_project_chat_room_id: f.roomId });
            await db.query("DELETE FROM projects WHERE id='prj-a'");
            expect(await rows()).toHaveLength(3);
            expect((await db.query('SELECT id FROM project_chat_messages WHERE id=$1', [f.sourceId])).rows).toEqual([]);
            expect((await report(req('Главный админ', 'owner@localhost'))).summary.requests).toBe(2);
            expect(JSON.stringify(await report())).not.toMatch(/private-model|private-agent|private-actor/);
        } finally { await f.cleanup(); }
    });
    it('withholds facets outside the filtered history after private-room membership is revoked during the report', async () => {
        const f = await privateRoom();
        try {
            await call();
            await withModelUsage({ purpose: 'agent', actorEmail: 'owner@localhost', projectId: 'prj-a', turnId: f.sourceId, privateProjectChatRoomId: f.roomId }, () => service.observe(model, 'chat', async () => output()));
            const original = service.repository.report.bind(service.repository);
            vi.spyOn(service.repository, 'report').mockImplementation(async (...args) => {
                const result = await original(...args); expect(result.privateRooms).toEqual([{ projectId: 'prj-a', roomId: f.roomId }]);
                await db.query("DELETE FROM project_chat_room_members WHERE project_id='prj-a' AND room_id=$1 AND email=$2", [f.roomId, f.member]); return result;
            });
            await expect(report(req('Админ проекта', f.member), { purpose: 'chat', limit: '1' })).rejects.toBeInstanceOf(ForbiddenException);
        } finally { await f.cleanup(); }
    });
    it('withholds private usage when membership is revoked while the final actor lookup waits', async () => {
        const f = await privateRoom();
        try {
            await withModelUsage({ purpose: 'agent', actorEmail: 'owner@localhost', projectId: 'prj-a', turnId: f.sourceId, privateProjectChatRoomId: f.roomId }, () => service.observe(model, 'chat', async () => output()));
            const original = models.actor.bind(models); let lookups = 0;
            vi.spyOn(models, 'actor').mockImplementation(async request => {
                const actor = await original(request);
                if (++lookups === 2) await db.query("DELETE FROM project_chat_room_members WHERE project_id='prj-a' AND room_id=$1 AND email=$2", [f.roomId, f.member]);
                return actor;
            });
            await expect(report(req('Админ проекта', f.member))).rejects.toBeInstanceOf(ForbiddenException);
            expect(lookups).toBe(2);
        } finally { await f.cleanup(); }
    });
    it('keeps cursors precise across PostgreSQL microseconds and applies every page scope', async () => {
        for (let n = 0; n < 7; n++) await call({}, n === 2 ? 'other@localhost' : 'owner@localhost');
        await db.query("UPDATE model_usage_calls SET started_at=date_trunc('second',now())+interval '0.000123 seconds'");
        let page = await report(req('Разработчик', 'owner@localhost'), { limit: '2' }), seen = page.items.map(item => item.id);
        while (page.history.hasMore) { page = await report(req('Разработчик', 'owner@localhost'), { limit: '2', cursor: page.history.nextCursor! }); seen.push(...page.items.map(item => item.id)); }
        expect(new Set(seen).size).toBe(6); expect(seen).toHaveLength(6); expect(page.items.every(item => item.actorEmail === 'owner@localhost')).toBe(true);
    });
    it('honors time/status/model/purpose filters and rejects malformed or excessive input', async () => {
        await call(); await withModelUsage({ purpose: 'learning', actorEmail: 'owner@localhost', projectId: 'prj-a' }, () => service.observe({ ...model, id: 'model-other' }, 'chat', async () => output()));
        await db.query("UPDATE model_usage_calls SET started_at=now()-interval '8 days' WHERE purpose='chat'");
        expect((await report(req(), { days: '7' })).summary.requests).toBe(1); expect((await report(req(), { days: '30', modelId: model.id })).summary.requests).toBe(1);
        expect((await report(req(), { purpose: 'learning', status: 'success' })).byPurpose).toHaveLength(1);
        for (const query of [{ days: '2' }, { limit: '10000' }, { purpose: 'fake' }, { status: 'fake' }, { cursor: 'not-a-page' }, { extra: 'input' }]) await expect(report(req(), query)).rejects.toThrow();
    });
    it('withholds a completed report when project grants change during its query', async () => {
        await call(); const original = service.repository.report.bind(service.repository);
        vi.spyOn(service.repository, 'report').mockImplementation(async (...args) => { const data = await original(...args); revoked = true; return data; });
        await expect(report(req('Админ проекта', 'admin@localhost'))).rejects.toBeInstanceOf(ForbiddenException);
    });
});
