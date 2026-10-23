import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferredSetup, flushSetup } from './admin-setup-hooks.fixture';
import type { RoleOverview, RoleRun, RoleStart } from '../src/features/SystemRoles/types';
const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture');
    const state = { hooks: adminSetupHooks(), owner: 'alice', captureOwner: () => { const owner = state.owner; return () => owner === state.owner; } }; return state;
});
vi.mock('react', () => ({ useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect, useCallback: h.hooks.callback }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: h.owner, captureOwner: h.captureOwner }) }));
vi.mock('../src/features/SystemRoles/api', () => ({ systemRolesApi: { overview: vi.fn(), list: vi.fn(), get: vi.fn(), prepare: vi.fn(), start: vi.fn(), action: vi.fn() } }));
import { systemRolesApi as api } from '../src/features/SystemRoles/api';
import { useSystemRole } from '../src/features/SystemRoles/useSystemRole';
let project: string | undefined, initial: string | undefined;
const render = () => { h.hooks.begin(); const value = useSystemRole('agent-ai-admin', project, initial); h.hooks.commit(); return value; };
const row = (patch = {}) => ({ id: 'run-one', agentId: 'agent-ai-admin', projectId: 'prj-one', state: 'succeeded', result: { summary: 'Private result' }, ...patch } as RoleRun);
const input = { projectId: 'prj-one', instruction: 'Check', diagnostics: [], targets: [], requestId: 'request-one', modelId: 'model-one', expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: 'b'.repeat(64), consentDigest: 'c'.repeat(64) } as RoleStart;
beforeEach(() => { h.hooks.dispose(); vi.resetAllMocks(); h.owner = 'alice'; project = 'prj-one'; initial = undefined;
    vi.mocked(api.overview).mockResolvedValue({ models: [], definitions: [], targets: [] } as unknown as RoleOverview); vi.mocked(api.list).mockResolvedValue([]); vi.mocked(api.start).mockResolvedValue(row());
    vi.stubGlobal('window', { setInterval, clearInterval }); vi.stubGlobal('document', { visibilityState: 'visible' }); vi.stubGlobal('crypto', { randomUUID: () => 'request-action' });
});
afterEach(() => { h.hooks.dispose(); vi.unstubAllGlobals(); });
it('mount, exact-run open and history refresh never purchase a model call', async () => {
    initial = 'chosen-run'; vi.mocked(api.get).mockResolvedValue(row({ id: initial })); render(); await flushSetup(); let value = render();
    expect(value.run?.id).toBe('chosen-run'); expect(api.get).toHaveBeenCalledWith('agent-ai-admin', 'chosen-run');
    await value.refresh(); value = render(); expect(value.run?.id).toBe('chosen-run'); expect(api.start).not.toHaveBeenCalled(); expect(api.prepare).not.toHaveBeenCalled();
});
it('one explicit start keeps a stable intent on unknown ACK and double click cannot start twice', async () => {
    const pending = deferredSetup<RoleRun>(); vi.mocked(api.start).mockReturnValueOnce(pending.promise); render(); await flushSetup(); const value = render();
    const first = value.start(input), duplicate = value.start({ ...input, requestId: 'other' }); expect(api.start).toHaveBeenCalledOnce();
    pending.reject(Error('ACK LOST')); await Promise.all([first, duplicate]); expect(render().uncertain).toBe(true);
    await render().start({ ...input, requestId: 'third' }); expect(api.start).toHaveBeenCalledOnce();
    await render().replay(); expect(vi.mocked(api.start).mock.calls[1]).toEqual(['agent-ai-admin', input]); expect(render().uncertain).toBe(false);
});
it('definitive pin/permission rejection preserves the form without trapping a new explicit intent', async () => {
    vi.mocked(api.start).mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { message: 'PIN CHANGED' } } }); render(); await flushSetup(); await render().start(input);
    expect(render().uncertain).toBe(false); expect(render().error).toContain('PIN CHANGED'); await render().replay(); expect(api.start).toHaveBeenCalledOnce();
    await render().start({ ...input, requestId: 'new-request' }); expect(api.start).toHaveBeenCalledTimes(2);
});
it('a target/model catalog outage cannot cut off accepted history', async () => {
    vi.mocked(api.overview).mockRejectedValue(Error('optional catalog failed')); vi.mocked(api.list).mockResolvedValue([row()]);
    render(); await flushSetup(); expect(render().history[0].id).toBe('run-one'); expect(render().error).toContain('Часть данных'); expect(api.start).not.toHaveBeenCalled();
});
it.each(['owner', 'project'])('a %s switch hides private state immediately and fences retained handlers and late responses', async change => {
    const pending = deferredSetup<RoleRun>(); vi.mocked(api.start).mockReturnValueOnce(pending.promise); render(); await flushSetup(); const old = render(), running = old.start(input);
    if (change === 'owner') h.owner = 'bob'; else project = 'prj-two';
    expect(render().run).toBeNull(); await old.start({ ...input, requestId: 'stale' }); expect(api.start).toHaveBeenCalledOnce();
    pending.resolve(row({ message: 'OLD PRIVATE RESULT' })); await running; await flushSetup(); expect(JSON.stringify(render())).not.toContain('OLD PRIVATE RESULT');
});
it('history cancellation remains available as a real owner action without creating a new run', async () => {
    vi.mocked(api.list).mockResolvedValue([row({ state: 'awaiting_review', canCancel: true })]); vi.mocked(api.action).mockResolvedValue(row({ state: 'cancelled' }));
    render(); await flushSetup(); render().select(render().history[0]); await render().action('cancel'); expect(api.action).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-one' }), 'cancel', 'request-action'); expect(api.start).not.toHaveBeenCalled();
});
