import './feature-flags-enabled';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelUsage } from '../src/features/ModelUsage/useModelUsage';
import { usageCount, usageFailure, usageLatency } from '../src/features/ModelUsage/presentation';
import type { UsageFilters, UsageReport } from '../src/features/ModelUsage/types';
import {usageReport as report} from './model-usage.fixture';
import {sameUsageScope} from '../src/features/ModelUsage/scope';

const hooks = vi.hoisted(() => {
    let cursor = 0; const slots: Array<{ value?: unknown; dependencies?: unknown[]; cleanup?: () => void }> = [], effects: Array<() => void> = [];
    const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    const memo = (factory: () => unknown, dependencies: unknown[]) => { const index = cursor++, previous = slots[index]; if (!previous || !same(previous.dependencies, dependencies)) slots[index] = { value: factory(), dependencies }; return slots[index].value; };
    return { begin: () => { cursor = 0; }, commit: () => { effects.splice(0).forEach(effect => effect()); }, dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial: T) { const slot = slots[cursor++] ??= { value: initial }; return [slot.value, (next: T | ((value: T) => T)) => { slot.value = typeof next === 'function' ? (next as (value: T) => T)(slot.value as T) : next; }]; },
        useRef<T>(initial?: T) { return (slots[cursor++] ??= { value: { current: initial } }).value; }, useCallback: (callback: unknown, dependencies: unknown[]) => memo(() => callback, dependencies),
        useLayoutEffect(effect: () => void | (() => void), dependencies: unknown[]) { const index = cursor++, previous = slots[index]; if (previous && same(previous.dependencies, dependencies)) return; const slot = slots[index] = { dependencies }; effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; }); },
    };
});
const fixture = vi.hoisted(() => ({ scope: 'main', owners: new Map<string, () => () => boolean>(), get: vi.fn() }));
vi.mock('react', () => hooks);
vi.mock('../src/core/api/base', () => ({ default: { get: fixture.get } }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {
    if (!fixture.owners.has(fixture.scope)) { const scope = fixture.scope; fixture.owners.set(scope, () => () => fixture.scope === scope); }
    return { scope: fixture.scope, captureOwner: fixture.owners.get(fixture.scope)! };
} }));
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
let filters: UsageFilters;
function render() { hooks.begin(); const result = useModelUsage(filters); hooks.commit(); return result; }
beforeEach(() => { vi.resetAllMocks(); fixture.scope = 'main'; fixture.owners.clear(); filters = { days: 7 }; fixture.get.mockResolvedValue({ data: report() }); });
afterEach(() => hooks.dispose());

describe('Usage counters', () => {
    it('distinguishes no counter, zero and exact totals larger than safe numbers', () => {
        expect(usageCount(null)).toBe('Нет данных'); expect(usageCount(0)).toBe('0');
        expect(usageCount('18014398509481982').replace(/\s/g, '')).toBe('18014398509481982');
    });
    it('formats measured latency without inventing it', () => { expect(usageLatency(null)).toBe('Нет данных'); expect(usageLatency(0)).toBe('0 мс'); expect(usageLatency(1250)).toBe('1,3 с'); });
    it('explains each recorded failure in Russian with a safe unknown fallback', () => {
        for (const code of ['cancelled', 'rate_wait_timeout', 'rate_store_unavailable', 'feature_disabled', 'permission_denied', 'provider_error', 'internal_error']) expect(usageFailure(code)).not.toBe('Не удалось выполнить запрос');
        expect(usageFailure('PRIVATE_UNKNOWN_CODE')).toBe('Не удалось выполнить запрос');
    });
});
describe('Usage report lifecycle', () => {
    it('loads once, with the chosen window, preserving absent provider counters', async () => {
        render(); await flush(); expect(render().data?.items[0]).toMatchObject({ inputTokens: null, outputTokens: 0 }); render();
        expect(fixture.get).toHaveBeenCalledOnce(); expect(fixture.get).toHaveBeenCalledWith('/api/model-usage', { params: { days: 7 }, signal: expect.any(AbortSignal) });
    });
    it('discards a late report and failure across role changes and an ABA return', async () => {
        const old = deferred<{ data: UsageReport }>(); fixture.get.mockReturnValueOnce(old.promise); render(); const signal = fixture.get.mock.calls[0][1].signal;
        fixture.scope = 'developer'; fixture.get.mockResolvedValue({ data: report(['developer-call']) }); render(); await flush();
        fixture.scope = 'main'; fixture.get.mockResolvedValue({ data: report(['fresh-main']) }); render(); await flush();
        expect(signal.aborted).toBe(true); old.resolve({ data: report(['private-old']) }); await flush(); expect(render().data?.items.map(item => item.id)).toEqual(['fresh-main']);
    });
    it('aborts an older filter request and never mixes its rows with the new report', async () => {
        const old = deferred<{ data: UsageReport }>(); fixture.get.mockReturnValueOnce(old.promise); render();
        filters = { days: 30, purpose: 'learning' }; fixture.get.mockResolvedValue({ data: report(['learning-call']) }); render(); await flush();
        old.reject(new Error('late failure')); await flush(); expect(render().error).toBe(''); expect(render().data?.items.map(item => item.id)).toEqual(['learning-call']);
        expect(fixture.get.mock.calls[1][1].params).toEqual(filters);
    });
    it('loads older pages by cursor, de-duplicates a repeated row, and refresh replaces them', async () => {
        fixture.get.mockResolvedValueOnce({ data: report(['call-a'], 'cursor-a') }); render(); await flush();
        fixture.get.mockResolvedValueOnce({ data: report(['call-a', 'call-b']) }); await render().more();
        expect(render().data?.items.map(item => item.id)).toEqual(['call-a', 'call-b']); expect(fixture.get.mock.calls[1][1].params.cursor).toBe('cursor-a');
        fixture.get.mockResolvedValueOnce({ data: report(['newest']) }); await render().refresh(); expect(render().data?.items.map(item => item.id)).toEqual(['newest']);
    });
    it('keeps a loaded page during an explicit retryable error, and recovers on refresh', async () => {
        render(); await flush(); fixture.get.mockRejectedValueOnce(new Error('Сервис недоступен')); await render().refresh(); expect(render().data?.items).toHaveLength(1); expect(render().error).toBe('Сервис недоступен');
        fixture.get.mockResolvedValueOnce({ data: report(['recovered']) }); await render().refresh(); expect(render().error).toBe(''); expect(render().data?.items[0].id).toBe('recovered');
    });
    it('closing the screen aborts its request and ignores a later resolution', async () => {
        const pending = deferred<{ data: UsageReport }>(); fixture.get.mockReturnValueOnce(pending.promise); render(); const signal = fixture.get.mock.calls[0][1].signal;
        hooks.dispose(); expect(signal.aborted).toBe(true); pending.resolve({ data: report() }); await flush(); expect(fixture.get).toHaveBeenCalledOnce();
    });
    it.each([401, 403, 404])('fresh %s clears loaded rows and scoped filter facets', async status => {
        render(); await flush(); expect(render().facets?.users[0].displayName).toBe('Алиса');
        fixture.get.mockRejectedValueOnce({isAxiosError: true, response: {status, data: {message: 'Нет доступа'}}}); await render().refresh();
        expect(render().data).toBeUndefined(); expect(render().facets).toBeUndefined(); expect(render().error).toContain('Нет доступа');
    });
    it('keeps authorized period facets during a new filter, never carrying them across owners or periods', async () => {
        render(); await flush(); const next = deferred<{data: UsageReport}>(); fixture.get.mockReturnValueOnce(next.promise);
        filters = {days: 7, projectId: 'project-a', actorEmail: '__system__', modelId: 'model-b', agentId: 'agent-a', endpoint: 'embed', provider: 'remote-openai'};
        render(); expect(render().data).toBeUndefined(); expect(render().facets?.models.map(model => model.id)).toEqual(['model-a', 'model-b']);
        expect(fixture.get.mock.calls[1][1].params).toEqual(filters);
        const period = deferred<{data: UsageReport}>(); fixture.get.mockReturnValueOnce(period.promise); filters = {...filters, days: 30}; render(); expect(render().facets).toBeUndefined();
        fixture.scope = 'project-admin'; fixture.get.mockResolvedValueOnce({data: {...report(), facets: {...report().facets, users: []}}}); render(); await flush();
        next.resolve({data: report(['private-main'])}); period.resolve({data: report(['old-period'])}); await flush();
        expect(render().facets?.users).toEqual([]); expect(render().data?.items[0].id).toBe('call-a');
    });
    it('a late denied response from a former owner cannot clear the new owner report', async () => {
        const old = deferred<{data: UsageReport}>(); fixture.get.mockReturnValueOnce(old.promise); render();
        fixture.scope = 'developer'; fixture.get.mockResolvedValueOnce({data: report(['mine'])}); render(); await flush();
        old.reject({isAxiosError: true, response: {status: 403}}); await flush();
        expect(render().data?.items[0].id).toBe('mine'); expect(render().facets?.users).toHaveLength(2); expect(render().error).toBe('');
    });
    it('a successful older-page receipt with revoked server projects clears old rows and restarts at the fresh first page', async () => {
        const first = {...report(['secret-a', 'allowed-b'], 'cursor-a'), scope: {kind: 'projects' as const, actorEmail: null, projectIds: ['project-a', 'project-b']}};
        fixture.get.mockResolvedValueOnce({data: first}); render(); await flush(); const reset = deferred<{data: UsageReport}>();
        const narrowed = {...report(['older-b']), scope: {...first.scope, projectIds: ['project-b']}, facets: {...first.facets, users: [{email: 'bob@example.test', displayName: 'Боб'}]}};
        fixture.get.mockResolvedValueOnce({data: narrowed}).mockReturnValueOnce(reset.promise); const pending = render().more(); await flush();
        expect(fixture.scope).toBe('main'); expect(render().data).toBeUndefined(); expect(render().facets).toBeUndefined(); expect(fixture.get.mock.calls[2][1].params).toEqual({days: 7});
        reset.resolve({data: {...narrowed, items: report(['fresh-first-b']).items}}); await pending;
        expect(render().data?.items.map(item => item.id)).toEqual(['fresh-first-b']); expect(render().facets?.users[0].displayName).toBe('Боб'); expect(fixture.get).toHaveBeenCalledTimes(3);
    });
    it.each(['previous', 'next', 'both', 'malformed'])('missing or malformed %s scope never authorizes appending old rows', async missing => {
        const first = report(['old-private'], 'cursor-a'), page = report(['older-page']), reset = report(['authoritative-first']);
        if (missing === 'previous' || missing === 'both') (first as unknown as {scope: unknown}).scope = undefined;
        if (missing === 'next' || missing === 'both') (page as unknown as {scope: unknown}).scope = undefined;
        if (missing === 'malformed') (page as unknown as {scope: unknown}).scope = {kind: 'other', actorEmail: null, projectIds: []};
        fixture.get.mockResolvedValueOnce({data: first}); render(); await flush(); fixture.get.mockResolvedValueOnce({data: page}).mockResolvedValueOnce({data: reset}); await render().more();
        expect(render().data?.items.map(item => item.id)).toEqual([missing === 'previous' ? 'authoritative-first' : 'older-page']);
        if (missing === 'previous') expect(fixture.get.mock.calls[2][1].params).not.toHaveProperty('cursor');
        else expect(fixture.get).toHaveBeenCalledTimes(2);
    });
    it('legacy history advances across cursor pages by replacing each page, with refresh restoring its first page', async () => {
        const legacy = (id: string, cursor: string | null) => ({...report([id], cursor), scope: undefined} as unknown as UsageReport);
        fixture.get.mockResolvedValueOnce({data: legacy('first-a', 'cursor-a')}); render(); await flush();
        fixture.get.mockResolvedValueOnce({data: legacy('older-b', 'cursor-b')}); await render().more(); expect(render().data?.items.map(item => item.id)).toEqual(['older-b']);
        fixture.get.mockResolvedValueOnce({data: legacy('older-c', null)}); await render().more(); expect(render().data?.items.map(item => item.id)).toEqual(['older-c']);
        expect(fixture.get.mock.calls[1][1].params.cursor).toBe('cursor-a'); expect(fixture.get.mock.calls[2][1].params.cursor).toBe('cursor-b'); expect(fixture.get).toHaveBeenCalledTimes(3);
        fixture.get.mockResolvedValueOnce({data: legacy('fresh-first', 'new-cursor')}); await render().refresh(); expect(render().data?.items[0].id).toBe('fresh-first'); expect(fixture.get.mock.calls[3][1].params).not.toHaveProperty('cursor');
    });
    it('server project ordering and duplicate grants do not trigger a false scope reset', async () => {
        const first = {...report(['a'], 'cursor-a'), scope: {kind: 'projects' as const, actorEmail: null, projectIds: ['project-a', 'project-b']}};
        fixture.get.mockResolvedValueOnce({data: first}); render(); await flush(); fixture.get.mockResolvedValueOnce({data: {...report(['b']), scope: {...first.scope, projectIds: ['project-b', 'project-a', 'project-a']}}}); await render().more();
        expect(render().data?.items.map(item => item.id)).toEqual(['a', 'b']); expect(fixture.get).toHaveBeenCalledTimes(2);
    });
    it('malformed scope receipts never validate earlier-page ownership', () => {
        const scope = report().scope;
        for (const invalid of [undefined, null, {}, {...scope, kind: 'other'}, {...scope, kind: {toString: 'all'}}, {...scope, actorEmail: 1}, {...scope, actorEmail: ''}, {...scope, projectIds: [1]}, {...scope, projectIds: ['']}, {...scope, projectIds: 'project-a'}]) {
            expect(sameUsageScope(scope, invalid)).toBe(false); expect(sameUsageScope(invalid, scope)).toBe(false);
        }
        expect(sameUsageScope(scope, {...scope, actorEmail: 'other@example.test'})).toBe(false);
    });
    it('a failed first-page reset never restores revoked cached rows and can be retried explicitly', async () => {
        fixture.get.mockResolvedValueOnce({data: report(['private-a'], 'cursor-a')}); render(); await flush();
        const narrowed = {...report(['older-b']), scope: {kind: 'projects' as const, actorEmail: null, projectIds: ['project-b']}};
        fixture.get.mockResolvedValueOnce({data: narrowed}).mockRejectedValueOnce(new Error('Reset offline')); await render().more();
        expect(render().data).toBeUndefined(); expect(render().facets).toBeUndefined(); expect(render().error).toBe('Reset offline');
        fixture.get.mockResolvedValueOnce({data: {...narrowed, items: report(['fresh-b']).items}}); await render().refresh(); expect(render().data?.items[0].id).toBe('fresh-b');
    });
});
