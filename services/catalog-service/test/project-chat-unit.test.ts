import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectChatPolicy } from '../src/project-chat/project-chat.policy';
import { ProjectChatService } from '../src/project-chat/project-chat.service';
import { resolveProjectChatProject } from '../src/project-chat/project-chat-project';
import type { ModelsService } from '../src/models/models.service';
import type { ProjectChatInferenceService } from '../src/project-chat-inference/project-chat-inference.service';
import { projectChatPage, projectChatParticipants, projectChatSend, projectChatWatch } from '../src/project-chat/project-chat.validation';
import { projectChatSummary } from '../src/project-chat/project-chat.runner';
import type { ProjectChatDb, ProjectChatMessageRow } from '../src/project-chat/project-chat.types';

afterEach(() => vi.unstubAllEnvs());
describe('Shared project message admission', () => {
    it('does not require a shared revision or model for human messages', () => {
        const input = projectChatSend({ requestKey: randomUUID(), prompt: 'Коллеги, проверьте изменения.', targetAgentIds: [] });
        expect(input).toMatchObject({ prompt: 'Коллеги, проверьте изменения.', targetAgentIds: [], replyToId: null });
        expect(projectChatSend({ requestKey: randomUUID(), prompt: 'Только людям' }).targetAgentIds).toBeUndefined();
    });
    it('keeps the complete reply identity and hashes concrete text and explicit targets', () => {
        const key = randomUUID(), parent = randomUUID(), base = { requestKey: key, prompt: 'Ответ коллеге', replyToId: parent, targetAgentIds: ['agent-developer'] };
        const first = projectChatSend(base);
        expect(first.replyToId).toBe(parent); expect(projectChatSend(base).hash).toBe(first.hash);
        expect(projectChatSend({ ...base, prompt: 'Другое сообщение' }).hash).not.toBe(first.hash);
        expect(projectChatSend({ ...base, targetAgentIds: [] }).hash).not.toBe(first.hash);
        expect(projectChatSend({ ...base, replyToId: randomUUID() }).hash).not.toBe(first.hash);
    });
    it('enforces UTF-8 byte bounds and rejects empty text, null bytes and unknown fields', () => {
        const base = { requestKey: randomUUID(), prompt: 'а'.repeat(65536) };
        expect(projectChatSend(base).prompt).toHaveLength(65536);
        for (const input of [{ ...base, prompt: base.prompt + 'а' }, { ...base, prompt: ' ' }, { ...base, prompt: 'a\0b' }, { ...base, actor: 'other@localhost' }, { ...base, requestKey: 'x' }]) expect(() => projectChatSend(input)).toThrow(BadRequestException);
    });
    it('rejects duplicate, ambiguous and oversized explicit agent selections', () => {
        const input = { requestKey: randomUUID(), prompt: 'Проверьте по своей роли' };
        for (const targetAgentIds of [['agent-a', 'agent-a'], ['display-name'], Array.from({ length: 9 }, (_, id) => 'agent-' + id), 'agent-a']) expect(() => projectChatSend({ ...input, targetAgentIds })).toThrow(BadRequestException);
    });
    it('supports an empty initial human room without manufacturing model configuration', () => {
        expect(projectChatParticipants({ expectedRevision: 0, agentIds: [] })).toEqual({ expectedRevision: 0, agentIds: [], modelId: null, modelPin: null });
        expect(() => projectChatParticipants({ expectedRevision: 0, agentIds: ['agent-a'] })).toThrow(BadRequestException);
        expect(() => projectChatParticipants({ expectedRevision: 1, agentIds: [], modelId: 'model-a' })).toThrow(BadRequestException);
        expect(projectChatParticipants({ expectedRevision: 1, agentIds: ['agent-a'], modelId: 'model-a', expectedModelPin: 'a'.repeat(64) })).toMatchObject({ modelId: 'model-a', modelPin: 'a'.repeat(64) });
    });
    it('validates history cursors and bounds instead of accepting an unbounded transcript', () => {
        expect(projectChatPage()).toEqual({ before: undefined, limit: 50 });
        const id = randomUUID(); expect(projectChatPage(id, '10')).toEqual({ before: id, limit: 10 });
        for (const input of ['0', '51', '-1', '1.5', 'NaN']) expect(() => projectChatPage(id, input)).toThrow(BadRequestException);
        expect(() => projectChatPage('another-project-name')).toThrow(BadRequestException);
    });
    it('accepts at most fifty distinct exact message UUIDs for pending-message polling', () => {
        const ids = Array.from({ length: 50 }, () => randomUUID());
        expect(projectChatWatch()).toEqual([]); expect(projectChatWatch(ids.join(','))).toEqual(ids);
        for (const raw of ['', ids.concat(randomUUID()).join(','), ids[0] + ',' + ids[0], ids[0] + ',' + ids[0].toUpperCase(), ids[0] + ',other-room', ids as unknown as string]) expect(() => projectChatWatch(raw)).toThrow(BadRequestException);
    });
});

function policyDb(input: { enabled?: boolean; main?: boolean; state?: string; missingProject?: boolean; grants?: Array<{ project_id: string; role: string }> } = {}) {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM platform_users') ? [{ enabled: input.enabled !== false, is_main_admin: input.main === true, display_name: 'Алексей' }]
        : sql.includes('FROM project_members') ? input.grants ?? [{ project_id: 'prj-one', role: 'Разработчик' }]
            : sql.includes('FROM projects') ? input.missingProject ? [] : [{ state: input.state ?? 'ACTIVE' }] : [] }));
    return { query } as unknown as ProjectChatDb;
}
describe('Shared chat current project access', () => {
    const policy = new ProjectChatPolicy(), developer = { email: 'alex@localhost', activeRole: 'Разработчик' };
    it('requires the trusted server boundary and refuses device or fabricated identities', () => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'test-only-team');
        const headers = { 'x-neurocenter-internal': 'test-only-team', 'x-bridge-actor': encodeURIComponent(JSON.stringify(developer)) };
        expect(policy.input({ headers } as unknown as Request)).toEqual(developer);
        expect(() => policy.input({ headers: { ...headers, 'x-neurocenter-device-id': randomUUID() } } as unknown as Request)).toThrow(ForbiddenException);
        expect(() => policy.input({ headers: { ...headers, 'x-neurocenter-internal': 'forged' } } as unknown as Request)).toThrow(ForbiddenException);
        expect(() => policy.input({ headers: { ...headers, 'x-bridge-actor': '%' } } as unknown as Request)).toThrow(ForbiddenException);
    });
    it('allows current developers to post but not configure, and observers to read only', async () => {
        expect((await policy.authorize(policyDb(), 'prj-one', developer, 2)).level).toBe(2);
        await expect(policy.authorize(policyDb(), 'prj-one', developer, 3)).rejects.toBeInstanceOf(ForbiddenException);
        const observer = { ...developer, activeRole: 'Наблюдатель' }, db = policyDb({ grants: [{ project_id: 'prj-one', role: 'Наблюдатель' }] });
        expect((await policy.authorize(db, 'prj-one', observer)).level).toBe(1);
        await expect(policy.authorize(db, 'prj-one', observer, 2)).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('denies a valid role on another project and a removed or disabled account', async () => {
        await expect(policy.authorize(policyDb(), 'prj-other', developer)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(policy.authorize(policyDb({ grants: [] }), 'prj-one', developer)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(policy.authorize(policyDb({ enabled: false }), 'prj-one', developer)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(policy.authorize(policyDb({ grants: [{ project_id: 'prj-one', role: 'Админ проекта' }] }), 'prj-one', developer)).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('requires an assigned main administrator and keeps archived/deleted projects read-only', async () => {
        const main = { ...developer, activeRole: 'Главный админ' };
        expect((await policy.authorize(policyDb({ main: true, grants: [] }), 'prj-one', main, 3)).level).toBe(4);
        await expect(policy.authorize(policyDb(), 'prj-one', main)).rejects.toBeInstanceOf(ForbiddenException);
        expect((await policy.authorize(policyDb({ state: 'ARCHIVED' }), 'prj-one', developer)).level).toBe(2);
        expect((await policy.authorize(policyDb({ state: 'ARCHIVED' }), 'prj-one', developer)).writable).toBe(false);
        await expect(policy.authorize(policyDb({ state: 'ARCHIVED' }), 'prj-one', developer, 2)).rejects.toBeInstanceOf(ForbiddenException);
        expect((await policy.authorize(policyDb({ state: 'ARCHIVED' }), 'prj-one', developer, 2, true, true)).level).toBe(2);
        await expect(policy.authorize(policyDb({ state: 'ARCHIVED', grants: [{ project_id: 'prj-one', role: 'Наблюдатель' }] }), 'prj-one', { ...developer, activeRole: 'Наблюдатель' }, 2, true, true)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(policy.authorize(policyDb({ missingProject: true }), 'prj-one', developer)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('locks current account and membership rows before a mutation', async () => {
        const db = policyDb(); await policy.authorize(db, 'prj-one', developer, 2, true);
        const calls = vi.mocked(db.query).mock.calls.map(args => String(args[0]));
        expect(calls.filter(sql => sql.includes('platform_users') || sql.includes('project_members')).every(sql => sql.endsWith('FOR SHARE'))).toBe(true);
        expect(calls.find(sql => sql.includes('FROM projects'))).toMatch(/FOR SHARE$/);
    });
});

describe('Stack-oriented project result source attribution', () => {
    const source = { id: randomUUID() } as ProjectChatMessageRow;
    const response = (name: string, content: string, status = 'done'): ProjectChatMessageRow => ({ id: randomUUID(), kind: 'agent', content, status,
        snapshot: { agentId: 'agent-' + name.toLowerCase(), name, slug: name.toLowerCase(), definition: { description: name === 'Frontend' ? 'React и интерфейс' : 'Postgres и API' } }, error: status === 'done' ? null : 'Подключение недоступно.' } as ProjectChatMessageRow);
    it('does not manufacture a summary for zero, one or repeated successful identities', () => {
        const a = response('Frontend', 'Один самостоятельный ответ'), b = response('Backend', '', 'failed');
        expect(projectChatSummary(source, [])).toBe('');
        expect(projectChatSummary(source, [a])).toBe('');
        expect(projectChatSummary(source, [a, b])).toBe('');
        expect(projectChatSummary(source, [a, { ...a, id: randomUUID() }])).toBe('');
    });
    it('keeps every specialist, its explicit role and its original message linked to the exact question', () => {
        const a = response('Frontend', 'Добавить ответ рядом с сообщением.'), b = response('Backend', 'Проверить API'), summary = projectChatSummary(source, [a, b]);
        for (const value of [source.id, a.id, b.id, 'React и интерфейс', 'Postgres и API', 'Добавить ответ', 'Проверить API']) expect(summary).toContain(value);
        expect(summary.indexOf('Frontend')).toBeLessThan(summary.indexOf('Backend'));
    });
    it('summarizes two successful agents while leaving a failed peer in its original message', () => {
        const a=response('Frontend','Готовый UI'), b=response('Backend','Готовый API'), failed=response('Native','','failed');
        const summary=projectChatSummary(source,[a,b,failed]);
        expect(summary).toContain(a.content);expect(summary).toContain(b.content);
        expect(summary).not.toContain(failed.id);expect(summary).not.toContain(failed.error);
    });
    it('bounds the derived result while retaining references to the full specialist answers', () => {
        const a = response('Frontend', 'a'.repeat(100000)), summary = projectChatSummary(source, [a, response('Backend', 'Короткий ответ')]);
        expect(summary.length).toBeLessThan(6000); expect(summary).toContain(a.id); expect(a.content).toHaveLength(100000);
    });
    it('uses human-readable references and escapes catalog metadata as text', () => {
        const a = response('[Fake](https://invalid.test)', 'Реальный ответ');
        a.snapshot!.definition.description = '# New section\n[Скрытый переход](https://invalid.test)';
        const summary = projectChatSummary(source, [a, response('Backend', 'Ответ второго агента')]);
        expect(summary).toContain(`[Сообщение пользователя](#project-chat-message-${source.id})`);
        expect(summary).toContain(`[Полный ответ агента](#project-chat-message-${a.id})`);
        expect(summary).not.toContain('### [Fake]'); expect(summary).not.toContain('\n# New section');
        expect(summary).toContain('\\[Скрытый переход\\]\\(https://invalid\\.test\\)');
    });
});

describe('Archived project lost-acknowledgement recovery', () => {
    function fixture() {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'test-only-team');
        const actor = { email: 'alex@localhost', activeRole: 'Разработчик', level: 2, displayName: 'Алексей', writable: false };
        const req = { headers: { 'x-neurocenter-internal': 'test-only-team', 'x-bridge-actor': encodeURIComponent(JSON.stringify(actor)) } } as unknown as Request;
        const modelCalls = vi.fn(), claims = { email: actor.email, userRoles: [actor.activeRole], projects: [{ projectId: 'prj-one', projectName: 'One', role: actor.activeRole }], pluginIds: [], skillPaths: [] };
        const service = new ProjectChatService({ pool: { query: async () => ({ rows: [{ id: 'prj-one', name: 'One', state: 'ARCHIVED' }] }) }, actor: async () => ({ ...actor, claims }) } as unknown as ModelsService, { resolve: modelCalls } as unknown as ProjectChatInferenceService);
        const query = vi.fn(async () => ({ rows: [] as Array<{ message_id: string }> })), room = { project_id: 'prj-one', revision: 5, agent_ids: [], model_id: null, model_pin: null };
        const source = { id: randomUUID(), author_email: actor.email, author_name: actor.displayName, kind: 'user', content: 'Сохранённый вопрос', target_agent_ids: [], status: 'done', created_at: '2026-10-23T00:00:00Z', position: '1', reply_to_id: null, source_message_id: null, snapshot: null } as unknown as ProjectChatMessageRow;
        vi.spyOn(service.repository, 'scoped').mockImplementation(async (_project, _actor, minimum, _write, action, recovery) => {
            expect(minimum).toBe(2); expect(recovery).toBe(true);
            return action({ query } as unknown as ProjectChatDb, room, actor);
        });
        vi.spyOn(service.runner, 'schedule').mockImplementation(() => undefined);
        return { service, req, source, query, modelCalls };
    }
    it('retrieves an exact accepted send after archive but refuses a new question without model or flag calls', async () => {
        const { service, req, source, modelCalls } = fixture(), body = { requestKey: randomUUID(), prompt: source.content, targetAgentIds: [] };
        source.request_hash = projectChatSend(body).hash;
        const prior = vi.spyOn(service.repository, 'prior').mockResolvedValue(source);
        expect((await service.send(req, 'prj-one', body)).message.id).toBe(source.id);
        prior.mockResolvedValue(undefined);
        await expect(service.send(req, 'prj-one', { ...body, requestKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenException);
        expect(modelCalls).not.toHaveBeenCalled();
    });
    it('retrieves a prior retry receipt after archive while refusing an unaccepted retry', async () => {
        const { service, req, source, query, modelCalls } = fixture();
        source.status = 'failed'; source.target_agent_ids = ['agent-a'];
        vi.spyOn(service.repository, 'message').mockResolvedValue(source);
        query.mockResolvedValueOnce({ rows: [{ message_id: source.id }] });
        expect((await service.retry(req, 'prj-one', source.id, { requestKey: randomUUID() })).message.id).toBe(source.id);
        await expect(service.retry(req, 'prj-one', source.id, { requestKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenException);
        expect(modelCalls).not.toHaveBeenCalled();
    });
    it('seeds the accepted response slots in the receipt before the first history refresh', async () => {
        const { service, req, source } = fixture(), body = { requestKey: randomUUID(), prompt: source.content, targetAgentIds: ['agent-a'] };
        source.request_hash = projectChatSend(body).hash; source.target_agent_ids = ['agent-a'];
        const response = { ...source, id: randomUUID(), kind: 'agent', author_email: null, author_name: null, content: '', status: 'queued', source_message_id: source.id,
            snapshot: { agentId: 'agent-a', name: 'Разработчик', slug: 'nc-developer', modelId: 'model-a', modelPin: 'a'.repeat(64), definition: { prompt: 'PRIVATE PROFILE SENTINEL' } } } as unknown as ProjectChatMessageRow;
        vi.spyOn(service.repository, 'prior').mockResolvedValue(source); vi.spyOn(service.repository, 'children').mockResolvedValue([response]);
        const receipt = await service.send(req, 'prj-one', body);
        expect(receipt.messages?.map(row => row.id)).toEqual([source.id, response.id]);
        expect(receipt.messages?.[1].status).toBe('queued'); expect(JSON.stringify(receipt)).not.toContain('PRIVATE PROFILE SENTINEL');
    });
});

describe('Lightweight shared project identity', () => {
    const req = {} as Request, actor = { email: 'alex@localhost', activeRole: 'Разработчик', claims: { email: 'alex@localhost', userRoles: ['Разработчик'],
        projects: [{ projectId: 'prj-one', projectName: 'One', role: 'Разработчик' }], pluginIds: [], skillPaths: [] } };
    it('uses a bounded identity query without project statistics, RAG or model configuration', async () => {
        const identity = { id: 'prj-one', name: 'One', state: 'ACTIVE' }, query = vi.fn(async () => ({ rows: [identity] }));
        const models = { actor: vi.fn(async () => actor), resolveProject: vi.fn(() => { throw new Error('Live statistics must not run'); }) };
        expect(await resolveProjectChatProject(models, { query } as unknown as ProjectChatDb, req, 'prj-one', 2)).toEqual(identity);
        expect(models.resolveProject).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledTimes(1);
    });
    it('resolves a granted display name only to the same canonical project', async () => {
        const models = { actor: async () => actor }, query = vi.fn(async () => ({ rows: [{ id: 'prj-one', name: 'One', state: 'ACTIVE' }] }));
        expect((await resolveProjectChatProject(models, { query } as unknown as ProjectChatDb, req, 'One')).id).toBe('prj-one');
        query.mockResolvedValueOnce({ rows: [{ id: 'prj-other', name: 'One', state: 'ACTIVE' }] });
        await expect(resolveProjectChatProject(models, { query } as unknown as ProjectChatDb, req, 'One')).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('never treats a reserved project ID as another project display-name grant', async () => {
        const current = { ...actor, claims: { ...actor.claims, projects: [{ projectId: 'prj-owned', projectName: 'prj-victim', role: 'Разработчик' }] } }, query = vi.fn();
        await expect(resolveProjectChatProject({ actor: async () => current }, { query } as unknown as ProjectChatDb, req, 'prj-victim')).rejects.toBeInstanceOf(ForbiddenException);
        expect(query).not.toHaveBeenCalled();
    });
    it('rechecks assigned active roles and reports a deleted allowed project', async () => {
        const db = { query: vi.fn(async () => ({ rows: [] })) } as unknown as ProjectChatDb;
        await expect(resolveProjectChatProject({ actor: async () => ({ ...actor, claims: { ...actor.claims, userRoles: [] } }) }, db, req, 'prj-one')).rejects.toBeInstanceOf(ForbiddenException);
        await expect(resolveProjectChatProject({ actor: async () => actor }, db, req, 'prj-one')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('retains archived history identity but denies model admission after a reservation wait', async () => {
        const db = { query: vi.fn(async () => ({ rows: [{ id: 'prj-one', name: 'One', state: 'ARCHIVED' }] })) } as unknown as ProjectChatDb;
        expect((await resolveProjectChatProject({ actor: async () => actor }, db, req, 'prj-one', 1)).state).toBe('ARCHIVED');
        await expect(resolveProjectChatProject({ actor: async () => actor }, db, req, 'prj-one', 2)).rejects.toBeInstanceOf(ForbiddenException);
    });
});
