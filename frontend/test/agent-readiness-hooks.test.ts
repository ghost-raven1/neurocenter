import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferredSetup, flushSetup } from './admin-setup-hooks.fixture';
import { readiness, readinessItem, trial } from './agent-readiness.fixture';
import type { IAgentReadiness, IAgentTrial } from '../src/features/AgentCatalog/readinessTypes';
const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture');
    const state = { hooks: adminSetupHooks(), owner: 'alice', active: true, flags: true, search: true,
        update: undefined as undefined | (() => void), captureOwner: () => { const owner = state.owner; return () => state.active && owner === state.owner; } };
    return state;
});
vi.mock('react', () => ({ useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect, useCallback: h.hooks.callback }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: h.owner, captureOwner: h.captureOwner }) }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({ useFeatureAvailability: (...keys: string[]) => ({ enabled: keys.includes('project_search') ? h.search : h.flags, reason: 'Функция выключена' }) }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: (_: string[], update: () => void) => { h.update = update; } }));
vi.mock('../src/features/AgentCatalog/readinessApi', () => ({ agentReadinessApi: { list: vi.fn(), start: vi.fn(), read: vi.fn(), cancel: vi.fn() } }));
import { agentReadinessApi as api } from '../src/features/AgentCatalog/readinessApi';
import { useAgentReadiness } from '../src/features/AgentCatalog/useAgentReadiness';
let project: string | undefined, canRead: boolean, catalogRevision: number | null;
const render = () => { h.hooks.begin(); const value = useAgentReadiness(project, canRead, catalogRevision); h.hooks.commit(); return value; };
const mounted = async () => { render(); await flushSetup(); return render(); };
beforeEach(() => {
    h.hooks.dispose(); vi.resetAllMocks(); h.owner = 'alice'; h.active = true; h.flags = true; h.search = true; project = 'project-one'; canRead = true; catalogRevision = 3;
    vi.mocked(api.list).mockResolvedValue(readiness()); vi.mocked(api.start).mockImplementation(async (_project, _agent, input) => trial({ requestId: input.requestId })); vi.mocked(api.cancel).mockResolvedValue(trial({ status: 'cancelled' }));
    let sequence = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `11111111-1111-4111-8111-${String(++sequence).padStart(12, '0')}` });
    vi.stubGlobal('window', { setInterval, clearInterval }); vi.stubGlobal('document', { visibilityState: 'visible' });
});
afterEach(() => { h.hooks.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('mount, manual refresh and live invalidation read metadata only; no role or project means no work', async () => {
    let value = await mounted(); expect(value.items).toHaveLength(1); await value.refresh(); h.update?.(); await flushSetup();
    expect(api.list).toHaveBeenCalledTimes(3); expect(api.start).not.toHaveBeenCalled(); expect(api.read).not.toHaveBeenCalled();
    canRead = false; expect(render().items).toEqual([]); await flushSetup(); await render().refresh(); expect(api.list).toHaveBeenCalledTimes(3);
    canRead = true; project = undefined; render(); await flushSetup(); await render().refresh(); expect(api.list).toHaveBeenCalledTimes(3);
});
it('only explicit start uses current revision/pins; double clicks cannot purchase duplicate work', async () => {
    const pending = deferredSetup<IAgentTrial>(); vi.mocked(api.start).mockReturnValueOnce(pending.promise);
    const value = await mounted(), item = value.items[0]; const first = value.start(item, 'model-one', 'none', false); const duplicate = value.start(item, 'model-one', 'none', false);
    expect(api.start).toHaveBeenCalledOnce(); expect(render().busy).toBe(true); expect(vi.mocked(api.start).mock.calls[0][2]).toMatchObject({ expectedRevision: 3, expectedAgentPin: item.currentPin, modelId: 'model-one', expectedModelPin: 'e'.repeat(64), tool: 'none' });
    pending.resolve(trial({ requestId: vi.mocked(api.start).mock.calls[0][2].requestId })); await Promise.all([first, duplicate]); expect(render().busy).toBe(false); expect(api.list).toHaveBeenCalledTimes(2);
});
it('inherited models require a choice, fixed models cannot be substituted, and search requires explicit consent', async () => {
    let value = await mounted(); await value.start(value.items[0], '', 'none', false); await value.start(value.items[0], 'missing', 'none', false);
    const fixed = readinessItem({ eligibility: { ...readinessItem().eligibility, modelSelection: 'fixed', resolvedModelId: 'different-model' } });
    await value.start(fixed, 'model-one', 'none', false); await value.start(value.items[0], 'model-one', 'project_search', false); expect(api.start).not.toHaveBeenCalled();
    h.search = false; value = render(); await value.start(value.items[0], 'model-one', 'project_search', true); expect(api.start).not.toHaveBeenCalled();
    h.search = true; value = render(); await value.start(value.items[0], 'model-one', 'project_search', true); expect(vi.mocked(api.start).mock.calls[0][2]).toMatchObject({ tool: 'project_search', toolConsent: true });
});
it('known flags, eligibility, a fresh read and a terminal prior trial gate new inference', async () => {
    let value = await mounted(), item = value.items[0]; h.flags = false; value = render(); await value.start(item, 'model-one', 'none', false);
    h.flags = true; value = render(); await value.start(readinessItem({ eligibility: { ...item.eligibility, canRun: false } }), 'model-one', 'none', false);
    await value.start(readinessItem({ latestTrial: trial({ status: 'running' }) }), 'model-one', 'none', false); expect(api.start).not.toHaveBeenCalled();
    const pending = deferredSetup<IAgentReadiness>(); vi.mocked(api.list).mockReturnValueOnce(pending.promise); const read = value.refresh(); await render().start(item, 'model-one', 'none', false); expect(api.start).not.toHaveBeenCalled();
    pending.reject(Error('READ FAILED')); await read; value = render(); expect(value.error).toContain('READ FAILED'); await value.start(item, 'model-one', 'none', false); expect(api.start).not.toHaveBeenCalled();
});
it('unknown start acknowledgement replays the exact request even with flags off; no new request may bypass recovery', async () => {
    vi.mocked(api.start).mockRejectedValueOnce(Error('ACK LOST')); let value = await mounted(); await value.start(value.items[0], 'model-one', 'none', false);
    value = render(); expect(value.uncertain).toBe(true); const first = vi.mocked(api.start).mock.calls[0][2]; await value.start(value.items[0], 'model-one', 'project_search', true); expect(api.start).toHaveBeenCalledOnce();
    h.flags = false; value = render(); await value.replay(); expect(vi.mocked(api.start).mock.calls[1][2]).toEqual(first); expect(render().uncertain).toBe(false);
});
it('metadata may confirm a lost receipt without inference; a terminal retry then gets a new key', async () => {
    vi.mocked(api.start).mockRejectedValueOnce({ response: { status: 503 } }); let value = await mounted(); await value.start(value.items[0], 'model-one', 'none', false);
    const requestId = vi.mocked(api.start).mock.calls[0][2].requestId; vi.mocked(api.list).mockResolvedValue(readiness(readinessItem({ latestTrial: trial({ requestId }) })));
    await render().refresh(); value = render(); expect(value.uncertain).toBe(false); await value.replay(); expect(api.start).toHaveBeenCalledOnce();
    await value.start(value.items[0], 'model-one', 'none', false); expect(vi.mocked(api.start).mock.calls[1][2].requestId).not.toBe(requestId);
});
it('known rejection is not an unknown paid start, and secure UUID failure never starts inference', async () => {
    vi.mocked(api.start).mockRejectedValueOnce({ response: { status: 409, data: { message: 'PIN CHANGED' } } }); let value = await mounted(); await value.start(value.items[0], 'model-one', 'none', false);
    value = render(); expect(value.uncertain).toBe(false); await value.replay(); expect(api.start).toHaveBeenCalledOnce();
    await value.refresh(); vi.stubGlobal('crypto', { randomUUID: () => { throw Error('No secure UUID'); } }); value = render();
    const different = readinessItem({ latestTrial: trial() }); await value.start(different, 'model-one', 'none', false); expect(api.start).toHaveBeenCalledOnce(); expect(render().error).toContain('HTTPS');
});
it.each(['owner', 'project', 'role'] as const)('%s changes abort pending reads and ignore old metadata and error payloads', async change => {
    const old = deferredSetup<IAgentReadiness>(); vi.mocked(api.list).mockReturnValueOnce(old.promise); render(); const signal = vi.mocked(api.list).mock.calls[0][1];
    if (change === 'owner') h.owner = 'bob'; else if (change === 'project') project = 'project-two'; else canRead = false;
    expect(render().items).toEqual([]); expect(signal.aborted).toBe(true); old.resolve(readiness(readinessItem({ agentId: 'PRIVATE OLD AGENT' }))); await flushSetup();
    expect(render().items.some(item => item.agentId === 'PRIVATE OLD AGENT')).toBe(false); expect(render().error).toBe('');
});
it.each(['resolve', 'reject'] as const)('old mutation %s cannot replace or unlock a new owner request', async action => {
    const old = deferredSetup<IAgentTrial>(), next = deferredSetup<IAgentTrial>(); vi.mocked(api.start).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    let value = await mounted(); const previous = value.start(value.items[0], 'model-one', 'none', false); const signal = vi.mocked(api.start).mock.calls[0][3];
    h.owner = 'bob'; render(); expect(signal.aborted).toBe(true); await flushSetup(); value = render(); const current = value.start(value.items[0], 'model-one', 'none', false);
    if (action === 'resolve') old.resolve(trial({ message: 'PRIVATE OLD RESULT' })); else old.reject(Error('PRIVATE OLD ERROR')); await previous;
    value = render(); expect(value.busy).toBe(true); expect(value.error).toBe(''); expect(value.items[0].latestTrial).toBeNull(); await value.start(value.items[0], 'model-one', 'none', false); expect(api.start).toHaveBeenCalledTimes(2);
    next.resolve(trial({ requestId: vi.mocked(api.start).mock.calls[1][2].requestId })); await current; expect(render().busy).toBe(false);
});
it('a late start result cannot upgrade a changed pin; a failed refresh keeps the historical receipt visible', async () => {
    const pending = deferredSetup<IAgentTrial>(); vi.mocked(api.start).mockReturnValueOnce(pending.promise); let value = await mounted(); const run = value.start(value.items[0], 'model-one', 'none', false);
    vi.mocked(api.list).mockResolvedValueOnce(readiness(readinessItem({ currentPin: 'f'.repeat(64), projectRevision: 4 }))); await value.refresh();
    vi.mocked(api.list).mockRejectedValueOnce(Error('Metadata temporarily unavailable')); pending.resolve(trial({ requestId: vi.mocked(api.start).mock.calls[0][2].requestId })); await run; value = render();
    expect(value.items[0].latestTrial).toMatchObject({ status: 'succeeded', current: false }); expect(value.error).toContain('Metadata temporarily unavailable');
});
it('out-of-order reads cannot overwrite newer metadata or resurrect a removed assignment', async () => {
    const old = deferredSetup<IAgentReadiness>(); let value = await mounted(); vi.mocked(api.list).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ executionSurface: 'server_chat', items: [] });
    const prior = value.refresh(); await value.refresh(); old.resolve(readiness()); await prior; expect(render().items).toEqual([]);
});
it('a newer catalog revision blocks stale handlers and triggers a fresh read without declaring historical proof stale', async () => {
    vi.mocked(api.list).mockResolvedValueOnce(readiness(readinessItem({ latestTrial: trial() }))); const initial = await mounted();
    const oldRead = deferredSetup<IAgentReadiness>(), fresh = deferredSetup<IAgentReadiness>();
    vi.mocked(api.list).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(fresh.promise); const pending = initial.refresh();
    catalogRevision = 4; render(); await initial.start(initial.items[0], 'model-one', 'none', false); expect(api.start).not.toHaveBeenCalled();
    oldRead.resolve(readiness(readinessItem({ projectRevision: 3, latestTrial: trial() }))); await pending; expect(render().loading).toBe(true);
    fresh.resolve(readiness(readinessItem({ projectRevision: 4, latestTrial: trial() }))); await flushSetup(); const current = render();
    expect(current.items[0]).toMatchObject({ projectRevision: 4, latestTrial: { current: true, status: 'succeeded' } });
    await initial.start(initial.items[0], 'model-one', 'none', false); expect(api.start).not.toHaveBeenCalled();
    await current.start(current.items[0], 'model-one', 'none', false); expect(vi.mocked(api.start).mock.calls[0][2].expectedRevision).toBe(4);
});
it('polling is metadata-only, pauses while hidden/inflight and stops after terminal result or unmount', async () => {
    vi.useFakeTimers(); vi.stubGlobal('window', { setInterval, clearInterval });
    vi.mocked(api.list).mockResolvedValue(readiness(readinessItem({ latestTrial: trial({ status: 'running', canCancel: true }) }))); await mounted();
    await vi.advanceTimersByTimeAsync(3000); expect(api.list).toHaveBeenCalledTimes(2); expect(api.start).not.toHaveBeenCalled();
    vi.stubGlobal('document', { visibilityState: 'hidden' }); await vi.advanceTimersByTimeAsync(3000); expect(api.list).toHaveBeenCalledTimes(2);
    vi.stubGlobal('document', { visibilityState: 'visible' }); const pending = deferredSetup<IAgentReadiness>(); vi.mocked(api.list).mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(6000); expect(api.list).toHaveBeenCalledTimes(3); pending.resolve(readiness(readinessItem({ latestTrial: trial() }))); await flushSetup(); render();
    await vi.advanceTimersByTimeAsync(6000); expect(api.list).toHaveBeenCalledTimes(3); h.hooks.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it('cancellation follows server ownership and remains available with new-work flags off', async () => {
    const running = trial({ status: 'running', canCancel: true, finishedAt: null }); vi.mocked(api.list).mockResolvedValue(readiness(readinessItem({ latestTrial: running })));
    let value = await mounted(); h.flags = false; value = render(); await value.cancel('agent-review', trial({ canCancel: false })); expect(api.cancel).not.toHaveBeenCalled();
    await value.cancel('agent-review', running); expect(api.cancel).toHaveBeenCalledExactlyOnceWith('project-one', 'agent-review', running, expect.any(AbortSignal)); expect(api.start).not.toHaveBeenCalled();
});
it.each(['success', 'error'] as const)('cancel another trial (%s) preserves an unresolved start and its exact replay body', async outcome => {
    const running = trial({ id: 'trial-other', requestId: '22222222-2222-4222-8222-222222222222', status: 'running', canCancel: true });
    const data = { executionSurface: 'server_chat' as const, items: [readinessItem(), readinessItem({ agentId: 'agent-other', latestTrial: running })] };
    vi.mocked(api.list).mockResolvedValue(data); vi.mocked(api.start).mockRejectedValueOnce(Error('A ACK LOST'));
    const initial = await mounted(); await initial.start(initial.items[0], 'model-one', 'none', false); const saved = structuredClone(vi.mocked(api.start).mock.calls[0][2]);
    if (outcome === 'success') vi.mocked(api.cancel).mockResolvedValueOnce(trial({ ...running, status: 'cancelled', finishedAt: '2026-10-22T00:00:01Z', canCancel: false }));
    else vi.mocked(api.cancel).mockRejectedValueOnce({ response: { status: 409 } });
    await render().cancel('agent-other', running); expect(render().uncertain).toBe(true);
    await initial.start(initial.items[0], 'model-one', 'project_search', true); expect(api.start).toHaveBeenCalledOnce();
    h.flags = false; await render().replay(); expect(vi.mocked(api.start).mock.calls[1][2]).toEqual(saved); expect(render().uncertain).toBe(false);
});
it('an unrelated acknowledgement or rejected replay cannot resolve an unknown start', async () => {
    vi.mocked(api.start).mockResolvedValueOnce(trial({ requestId: '22222222-2222-4222-8222-222222222222' })).mockRejectedValueOnce({ response: { status: 403 } });
    let value = await mounted(); await value.start(value.items[0], 'model-one', 'none', false); value = render(); expect(value.uncertain).toBe(true);
    const body = structuredClone(vi.mocked(api.start).mock.calls[0][2]); await value.replay(); expect(render().uncertain).toBe(true);
    expect(vi.mocked(api.start).mock.calls[1][2]).toEqual(body); await render().replay(); expect(vi.mocked(api.start).mock.calls[2][2]).toEqual(body); expect(render().uncertain).toBe(false);
});
