import './feature-flags-enabled';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelUsage } from '../src/features/ModelUsage/useModelUsage';
import { usageCount, usageLatency } from '../src/features/ModelUsage/presentation';
import type { UsageFilters, UsageReport } from '../src/features/ModelUsage/types';

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
const totals = { requests: 1, success: 1, error: 0, cancelled: 0, interrupted: 0, pending: 0, inputTokens: null, outputTokens: '0', knownInputRequests: 0, knownOutputRequests: 1, unknownInputRequests: 1, unknownOutputRequests: 0, averageLatencyMs: 50 };
const report = (ids = ['call-a'], cursor: string | null = null): UsageReport => ({ window: { days: 7, from: '', to: '' }, summary: totals, byModel: [], byPurpose: [],
    items: ids.map(id => ({ id, modelId: 'model-a', modelName: 'Model A', provider: 'remote-openai', endpoint: 'chat', purpose: 'chat', actorEmail: 'main@localhost', projectId: null, agentId: null, turnId: null, operationId: null,
        status: 'success', startedAt: '2026-10-21T10:00:00Z', finishedAt: '2026-10-21T10:00:01Z', latencyMs: 50, inputTokens: null, outputTokens: 0 })), history: { hasMore: !!cursor, nextCursor: cursor } });
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
});
