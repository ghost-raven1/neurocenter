import 'reflect-metadata';
import { ForbiddenException, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAccessClaims } from '../src/access/access.model';
import { createModelDispatchMetrics, currentModelDispatchMetrics, withModelDispatchMetrics } from '../src/model-usage/model-dispatch-metrics';
import { modelUsageFilter } from '../src/model-usage/model-usage.query';
import { modelUsageReportQuery, readModelUsageReport } from '../src/model-usage/model-usage-report';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import type { ModelsService } from '../src/models/models.service';
import type { IModel } from '../src/models/model.types';
import type { ModelUsageQuery, UsageTerminal } from '../src/model-usage/model-usage.types';

vi.mock('../src/database/pool', () => ({ createPool: () => ({ end: vi.fn(async () => undefined) }) }));
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: vi.fn(async () => undefined) }));
afterEach(() => { vi.restoreAllMocks(); });
const model = { id: 'model-detailed-usage', name: 'Detailed usage', runtime: 'remote-openai' } as IModel;
const req = { headers: {} } as Request;
const project = (id: string, role: string) => ({ projectId: id, projectName: id === 'prj-a' ? 'Alpha' : 'Beta', role });
function fixture(activeRole = 'Главный админ') {
    const claims: IAccessClaims = { email: 'owner@localhost', userRoles: ['Главный админ', 'Админ проекта', 'Разработчик'],
        projects: [project('prj-a', 'Админ проекта'), project('prj-b', 'Разработчик')], pluginIds: [], skillPaths: [] };
    const actor = vi.fn(async () => ({ email: claims.email, activeRole, claims }));
    const service = new ModelUsageService({ actor } as unknown as ModelsService);
    vi.spyOn(service.repository, 'begin').mockResolvedValue(undefined);
    const finish = vi.spyOn(service.repository, 'finish').mockResolvedValue(undefined);
    const canonical = vi.spyOn(service.repository, 'canonicalProject').mockResolvedValue('prj-a');
    const report = vi.spyOn(service.repository, 'report').mockResolvedValue({ windowTo: '2026-10-23T00:00:00.000Z',
        summary: { requests: 0 }, byModel: [], byPurpose: [], byActor: [], byProject: [], byEndpoint: [], byAgent: [], series: [],
        facets: { users: [], projects: [], models: [], agents: [], providers: [] }, items: [], hasMore: false, cursor: null } as never);
    return { service, claims, actor, finish, report, canonical };
}

describe('Detailed usage filters and scope', () => {
    it('accepts exact actor/agent/API/provider filters and a separate server-job identity', () => {
        expect(modelUsageFilter({ actorEmail: 'OWNER@LOCALHOST', agentId: 'agent-planner', endpoint: 'embed', provider: 'remote-openai' })).toMatchObject({ actorEmail: 'owner@localhost', agentId: 'agent-planner', endpoint: 'embed', provider: 'remote-openai' });
        expect(modelUsageFilter({ actorEmail: '__system__' }).actorEmail).toBeNull();
    });
    it.each([{ days: ['7'] }, { limit: 10 }, { provider: 'fake' }, { endpoint: 'images' }, { actorEmail: 'not-an-email' }, { agentId: 'bad\nvalue' }, { extra: 'scope' }])('refuses malformed HTTP filters %j', query => {
        expect(() => modelUsageFilter(query as ModelUsageQuery)).toThrow();
    });
    it('main admin sees all actors and resolves a project without accessing RAG or local files', async () => {
        const f = fixture(), result = await f.service.report(req, { projectId: 'Alpha' });
        expect(f.canonical).toHaveBeenCalledWith('Alpha');
        expect(f.report).toHaveBeenCalledWith({ all: true, actor: null, projectIds: ['prj-a', 'prj-b'] }, expect.objectContaining({ projectId: 'prj-a' }));
        expect(result.scope?.kind).toBe('all'); expect(result.window.to).toBe('2026-10-23T00:00:00.000Z');
    });
    it('project admin sees every actor only in projects they administer, including actor filtering', async () => {
        const f = fixture('Админ проекта');
        const result = await f.service.report(req, { projectId: 'Alpha', actorEmail: 'other@localhost' });
        expect(f.report).toHaveBeenCalledWith({ all: false, actor: null, projectIds: ['prj-a'] }, expect.objectContaining({ projectId: 'prj-a', actorEmail: 'other@localhost' }));
        expect(result.scope?.kind).toBe('projects');
        f.report.mockClear(); await expect(f.service.report(req, { projectId: 'prj-b' })).rejects.toBeInstanceOf(ForbiddenException); expect(f.report).not.toHaveBeenCalled();
    });
    it('developer retains personal scope and cannot request other actors or server jobs', async () => {
        const f = fixture('Разработчик');
        await f.service.report(req, { actorEmail: 'owner@localhost' });
        expect(f.report).toHaveBeenCalledWith({ all: false, actor: 'owner@localhost', projectIds: ['prj-a', 'prj-b'] }, expect.any(Object));
        for (const actorEmail of ['other@localhost', '__system__']) await expect(f.service.report(req, { actorEmail })).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('withholds facets and completed details after a membership or active-role change', async () => {
        const f = fixture('Админ проекта');
        f.actor.mockResolvedValueOnce({ email: f.claims.email, activeRole: 'Админ проекта', claims: structuredClone(f.claims) });
        f.report.mockImplementationOnce(async () => { f.claims.projects = []; return { windowTo: '2026-10-23T00:00:00.000Z' } as never; });
        await expect(f.service.report(req, {})).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('rejects device and observer access before reading any user details', async () => {
        const f = fixture('Наблюдатель');
        await expect(f.service.report(req, {})).rejects.toBeInstanceOf(ForbiddenException);
        await expect(f.service.report({ headers: { 'x-neurocenter-device-id': 'device' } } as Request, {})).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.report).not.toHaveBeenCalled();
    });
    it('binds filter values and keeps facets in the authorized unfiltered period', () => {
        const hostile = "model-' OR true--", query = modelUsageReportQuery({ all: false, actor: null, projectIds: ['prj-a'] }, { days: 7, limit: 10, modelId: hostile, actorEmail: null });
        expect(query.sql).not.toContain(hostile); expect(query.values).toContain(hostile);
        expect(query.sql).toContain('actor_email IS NULL'); expect(query.sql).toContain('FROM scoped GROUP BY actor_email');
        expect(query.sql).toContain('FROM filtered GROUP BY actor_email'); expect(query.values.slice(0, 4)).toEqual([7, false, null, ['prj-a']]);
    });
    it('keeps PostgreSQL microseconds in the next cursor and normalizes only display timestamps', async () => {
        const at = '2026-10-23T00:00:00.000123Z', id = '12345678-1234-4123-8123-123456789012';
        const db = { query: vi.fn(async () => ({ rows: [{ windowTo: new Date('2026-10-23T01:00:00Z'), items: [{ id, startedAt: at, cursorAt: at, finishedAt: null, dispatchedAt: null }, { id: 'other', startedAt: at, cursorAt: at }] }] })) };
        const result = await readModelUsageReport(db as never, { all: true, actor: null, projectIds: [] }, { days: 7, limit: 1 });
        expect(result.hasMore).toBe(true); expect(result.items[0].startedAt).toBe('2026-10-23T00:00:00.000Z'); expect(result.cursor).toEqual({ startedAt: at, id });
        const cursor = Buffer.from(JSON.stringify(result.cursor)).toString('base64url'); expect(modelUsageFilter({ cursor }).cursor?.startedAt).toBe(at);
    });
    it('refuses normalized but nonexistent calendar dates before querying PostgreSQL', () => {
        const cursor = Buffer.from(JSON.stringify({ id: '12345678-1234-4123-8123-123456789012', startedAt: '2026-02-30T00:00:00.000123Z' })).toString('base64url');
        expect(() => modelUsageFilter({ cursor })).toThrow('Некорректная страница');
    });
    it('refuses a UUID array instead of coercing it into a PostgreSQL uuid parameter', () => {
        const cursor = Buffer.from(JSON.stringify({ id: ['12345678-1234-4123-8123-123456789012'], startedAt: '2026-10-23T00:00:00.000123Z' })).toString('base64url');
        expect(() => modelUsageFilter({ cursor })).toThrow('Некорректная страница');
    });
});

describe('Actual dispatch accounting', () => {
    it('isolates concurrent operations and restores the outer metrics after nested work', async () => {
        const states = [createModelDispatchMetrics(), createModelDispatchMetrics()];
        await Promise.all(states.map((state, index) => withModelDispatchMetrics(state, async () => {
            await Promise.resolve(); currentModelDispatchMetrics()!.dispatchCount = index + 1;
            withModelDispatchMetrics(createModelDispatchMetrics(), () => { currentModelDispatchMetrics()!.dispatchCount = 99; });
            expect(currentModelDispatchMetrics()).toBe(state);
        })));
        expect(states.map(item => item.dispatchCount)).toEqual([1, 2]); expect(currentModelDispatchMetrics()).toBeUndefined();
    });
    it('records a cancelled rate wait as zero API calls and keeps provider latency unknown', async () => {
        const f = fixture(), abort = new AbortController();
        await expect(f.service.observe(model, 'chat', async () => { currentModelDispatchMetrics()!.rateWaitMs = 23; abort.abort(new Error('private reason')); throw abort.signal.reason; }, abort.signal)).rejects.toThrow('private reason');
        const terminal = f.finish.mock.calls[0][2]; expect(terminal).toMatchObject({ status: 'cancelled', dispatchCount: 0, dispatchedAt: null, rateWaitMs: 23, providerLatencyMs: null, failureCode: 'cancelled' });
        expect(JSON.stringify(terminal)).not.toContain('private');
    });
    it.each([['MODEL_RATE_WAIT_TIMEOUT', 429, 'rate_wait_timeout'], ['MODEL_RATE_STORE_UNAVAILABLE', 503, 'rate_store_unavailable'], ['feature-disabled', 403, 'feature_disabled']])('records only safe failure category %s', async (code, status, failureCode) => {
        const f = fixture(); await expect(f.service.observe(model, 'chat', async () => { throw new HttpException({ code, message: 'private provider body' }, Number(status)); })).rejects.toThrow();
        expect(f.finish.mock.calls[0][2]).toMatchObject({ dispatchCount: 0, providerLatencyMs: null, failureCode });
        expect(JSON.stringify(f.finish.mock.calls[0][2])).not.toContain('private');
    });
    it('preserves counted attempts on provider failure and retries only a failed receipt write', async () => {
        const f = fixture(), terminals: UsageTerminal[] = [], actual = vi.fn(async () => {
            Object.assign(currentModelDispatchMetrics()!, { dispatchCount: 1, dispatchedAt: '2026-10-23T01:00:00.000Z', rateWaitMs: 10, providerLatencyMs: 42 });
            throw new Error('private failure');
        });
        f.finish.mockImplementation(async (_id, _worker, terminal) => { terminals.push(structuredClone(terminal)); if (terminals.length === 1) throw new Error('ACK unknown'); });
        await expect(f.service.observe(model, 'chat', actual)).rejects.toThrow('private failure');
        await (f.service as unknown as { flush(): Promise<void> }).flush();
        expect(actual).toHaveBeenCalledOnce(); expect(terminals).toHaveLength(2); expect(terminals[0]).toEqual(terminals[1]);
        expect(terminals[0]).toMatchObject({ dispatchCount: 1, providerLatencyMs: 42, failureCode: 'provider_error' });
    });
});
