import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferredSetup, flushSetup } from './admin-setup-hooks.fixture';
import type { RoleOverview, RoleRun } from '../src/features/SystemRoles/types';
import type { ServicePreview, ServiceTurn } from '../src/features/SystemRoleChat/types';

const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture');
    const state = { hooks: adminSetupHooks(), owner: 'alice', generation: 0, captureOwner: () => { const owner = state.owner, generation = state.generation; return () => owner === state.owner && generation === state.generation; } };
    return state;
});
vi.mock('react', () => ({ useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect, useMemo: h.hooks.memo }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: h.owner, captureOwner: h.captureOwner }) }));
vi.mock('../src/features/SystemRoles/api', () => ({ systemRolesApi: { overview: vi.fn(), action: vi.fn() } }));
vi.mock('../src/features/SystemRoleChat/api', () => ({ systemRoleChatsApi: { list: vi.fn(), create: vi.fn(), read: vi.fn(), prepare: vi.fn(), start: vi.fn(), request: vi.fn(), cancel: vi.fn() } }));
import { systemRoleChatsApi as api } from '../src/features/SystemRoleChat/api';
import { systemRolesApi } from '../src/features/SystemRoles/api';
import { clearServiceIntent, saveServiceIntent } from '../src/features/SystemRoleChat/intent';
import { useSystemRoleChat } from '../src/features/SystemRoleChat/useSystemRoleChat';

let project: string | undefined, enabled: boolean, options: Parameters<typeof useSystemRoleChat>[2];
const model = { id: 'model-one', name: 'Model', pin: 'a'.repeat(64) };
const dialog = { id: 'dialog-one', title: 'Задача', projectId: 'prj-one', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' };
const selection = { projectId: 'prj-one', instruction: 'Проверь проект', diagnostics: [], targets: [] };
const prepared: ServicePreview = { selection, prepared: { preview: 'Exact own context', consentDigest: 'b'.repeat(64), definitionPin: 'c'.repeat(64), targets: [] } };
const turn = (patch = {}): ServiceTurn => ({ id: 'explicit-request', agentId: 'agent-coordinator', instruction: selection.instruction, createdAt: dialog.createdAt, cancelRequested: false,
    run: { id: 'run-one', projectId: 'prj-one', state: 'succeeded', revision: 1, canCancel: false, canApply: false, canRollback: false, result: { summary: 'OWN ANSWER' }, ...patch } as RoleRun });
const render = () => { h.hooks.begin(); const value = useSystemRoleChat(project, enabled, options); h.hooks.commit(); return value; };
const prepare = async () => { render(); await flushSetup(); await render().prepare('agent-coordinator', selection, false, model.id); return render(); };
beforeEach(() => {
    h.hooks.dispose(); vi.resetAllMocks(); h.owner = 'alice'; h.generation++; project = 'prj-one'; enabled = true; options = undefined;
    const storage = new Map<string, string>(); vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    for (const owner of ['alice', 'bob']) for (const scope of ['prj-one', 'prj-two', null]) clearServiceIntent(JSON.stringify([owner, scope]));
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'explicit-request') }); vi.stubGlobal('window', { setInterval, clearInterval }); vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.mocked(systemRolesApi.overview).mockResolvedValue({ definitions: [], models: [model], targets: [] } as unknown as RoleOverview);
    vi.mocked(api.list).mockResolvedValue([dialog]); vi.mocked(api.create).mockImplementation(async input => ({ ...dialog, id: input.id })); vi.mocked(api.read).mockResolvedValue({ dialog, turns: [] });
    vi.mocked(api.prepare).mockResolvedValue(prepared); vi.mocked(api.start).mockResolvedValue(turn()); vi.mocked(api.request).mockResolvedValue(turn());
});
afterEach(() => { h.hooks.dispose(); for (const owner of ['alice', 'bob']) for (const scope of ['prj-one', 'prj-two', null]) clearServiceIntent(JSON.stringify([owner, scope])); vi.unstubAllGlobals(); });

it('opening, refresh and preparing context never purchase inference; sends the exact server-selected receipt only on explicit start', async () => {
    render(); await flushSetup(); expect(api.start).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
    await render().refresh(); await render().prepare('agent-coordinator', selection, true, model.id); render();
    expect(api.prepare).toHaveBeenCalledWith('explicit-request', 'agent-coordinator', selection, true); expect(api.start).not.toHaveBeenCalled();
    await render().start(model.id);
    expect(api.start).toHaveBeenCalledExactlyOnceWith('explicit-request', 'agent-coordinator', expect.objectContaining({ ...selection, requestId: 'explicit-request', modelId: model.id, expectedModelPin: model.pin, expectedDefinitionPin: prepared.prepared.definitionPin, consentDigest: prepared.prepared.consentDigest }));
});
it('pins follow-up context returned by the server rather than rebuilding it from unrelated histories', async () => {
    const ownContext = { kind: 'dialog-context' as const, id: 'own-completed-answer-snapshot' };
    vi.mocked(api.prepare).mockResolvedValue({ ...prepared, selection: { ...selection, targets: [ownContext] } });
    await prepare(); await render().start(model.id);
    expect(vi.mocked(api.start).mock.calls[0][2].targets).toEqual([ownContext]);
});
it('a lost ACK blocks double-click and another draft; explicit retry uses the same immutable key and pinned selection', async () => {
    await prepare(); const pending = deferredSetup<ServiceTurn>(); vi.mocked(api.start).mockReturnValueOnce(pending.promise);
    const first = render().start(model.id), duplicate = render().start(model.id); expect(api.start).toHaveBeenCalledOnce();
    pending.reject(Error('ACK LOST')); await Promise.all([first, duplicate]);
    expect(render().receipt?.requestId).toBe('explicit-request'); await render().start(model.id); expect(api.start).toHaveBeenCalledOnce();
    const firstInput = structuredClone(vi.mocked(api.start).mock.calls[0]); await render().replay();
    expect(vi.mocked(api.start).mock.calls[1]).toEqual(firstInput); expect(render().receipt).toBeUndefined();
});
it('read-only recovery after remount and flag-off finds the exact accepted request without replaying inference', async () => {
    await prepare(); vi.mocked(api.start).mockRejectedValueOnce(Error('ACK LOST')); await render().start(model.id);
    h.hooks.dispose(); enabled = false; vi.mocked(api.read).mockResolvedValue({ dialog: { ...dialog, id: 'explicit-request' }, turns: [turn()] });
    render(); await flushSetup(); expect(api.request).toHaveBeenCalledWith('explicit-request', 'explicit-request');
    expect(api.start).toHaveBeenCalledOnce(); expect(render().detail?.turns[0].run?.result?.summary).toBe('OWN ANSWER'); expect(render().receipt).toBeUndefined();
});
it('definitive rejection invalidates consent while preserving a retryable task', async () => {
    await prepare(); vi.mocked(api.start).mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { message: 'MODEL PIN CHANGED' } } });
    await render().start(model.id); expect(render().receipt).toBeUndefined(); expect(render().prepared).toBeUndefined(); expect(render().error).toContain('MODEL PIN CHANGED');
    await render().replay(); expect(api.start).toHaveBeenCalledOnce(); await render().prepare('agent-coordinator', selection, false, model.id); expect(render().prepared).toBeDefined();
});
it('catalog failure keeps accepted history, cancellation and rollback usable when execution is disabled', async () => {
    enabled = false; vi.mocked(systemRolesApi.overview).mockRejectedValue(Error('CATALOG DOWN'));
    const item = turn({ state: 'running', canCancel: true }); vi.mocked(api.read).mockResolvedValue({ dialog, turns: [item] }); vi.mocked(api.cancel).mockResolvedValue(turn({ state: 'cancelled' }));
    render(); await flushSetup(); expect(render().dialogs).toEqual([dialog]); expect(render().error).toContain('Часть данных');
    await render().select(dialog.id); await render().action(item, 'cancel'); expect(api.cancel).toHaveBeenCalledWith(dialog.id, item, 'explicit-request'); expect(api.start).not.toHaveBeenCalled();
});
it('uses the canonical origin binding rather than the provisional dialog UUID, and notifies only confirmed acceptance', async () => {
    const create = vi.fn().mockResolvedValue({...dialog, id: 'canonical-origin-dialog'}), accepted = vi.fn();
    options = {origin: 'origin-canonical', transport: {...api, create}, onAccepted: accepted};
    await prepare();
    expect(api.create).not.toHaveBeenCalled(); expect(api.prepare).toHaveBeenCalledWith('canonical-origin-dialog', 'agent-coordinator', selection, false);
    expect(accepted).not.toHaveBeenCalled();
    await render().start(model.id);
    expect(api.start).toHaveBeenCalledWith('canonical-origin-dialog', 'agent-coordinator', expect.any(Object)); expect(accepted).toHaveBeenCalledOnce();
});
it('an unsaved host chat remains suspended and never reads unrelated legacy service history', async () => {
    options = {suspended: true}; render(); await flushSetup();
    expect(api.list).not.toHaveBeenCalled(); expect(systemRolesApi.overview).not.toHaveBeenCalled();
    expect(render().loading).toBe(false);
});
it('origin switches isolate an unknown receipt while preserving exact recovery for its original chat', async () => {
    options = {origin: 'origin-A'}; await prepare(); vi.mocked(api.start).mockRejectedValueOnce(Error('ACK LOST')); await render().start(model.id);
    expect(render().receipt).toBeDefined(); options = {origin: 'origin-B'}; render(); await flushSetup();
    expect(render().receipt).toBeUndefined(); expect(api.request).not.toHaveBeenCalled();
    options = {origin: 'origin-A'}; enabled = false; render(); await flushSetup();
    expect(api.request).toHaveBeenCalledWith('explicit-request', 'explicit-request'); expect(api.start).toHaveBeenCalledOnce();
});
it.each(['project', 'owner', 'project ABA', 'auth ABA', 'unmount'])('fences late previews, paid starts and retained handlers after %s', async change => {
    const pending = deferredSetup<ServicePreview>(); vi.mocked(api.prepare).mockReturnValueOnce(pending.promise);
    const old = await prepareForPending(); const preparing = old.prepare('agent-coordinator', selection, false, model.id); await flushSetup();
    if (change === 'project' || change === 'project ABA') { project = 'prj-two'; render(); if (change === 'project ABA') { project = 'prj-one'; render(); } }
    else if (change === 'unmount') h.hooks.dispose();
    else { h.owner = 'bob'; h.generation++; render(); if (change === 'auth ABA') { h.owner = 'alice'; h.generation++; render(); } }
    pending.resolve(prepared); await preparing; await old.start(model.id); expect(api.start).not.toHaveBeenCalled();
    if (change !== 'unmount') expect(render().prepared).toBeUndefined();
});
async function prepareForPending() { render(); await flushSetup(); return render(); }
it('editing while preview is in flight discards its consent snapshot', async () => {
    const pending = deferredSetup<ServicePreview>(); vi.mocked(api.prepare).mockReturnValueOnce(pending.promise);
    render(); await flushSetup(); const value = render(), preparing = value.prepare('agent-coordinator', selection, false, model.id); await flushSetup();
    value.invalidate(); pending.resolve(prepared); await preparing; expect(render().prepared).toBeUndefined(); await render().start(model.id); expect(api.start).not.toHaveBeenCalled();
});
it('a catalog pin change after consent never silently replaces the model identity on a paid start', async () => {
    await prepare(); vi.mocked(systemRolesApi.overview).mockResolvedValue({ definitions: [], models: [{ ...model, pin: 'd'.repeat(64) }], targets: [] } as unknown as RoleOverview);
    await render().refresh(); await render().start(model.id); expect(api.start).not.toHaveBeenCalled(); expect(render().prepared).toBeUndefined(); expect(render().error).toContain('Модель изменилась');
});
it('a pin change while the free preview is pending discards that preview instead of consenting to the new pin', async () => {
    const pending = deferredSetup<ServicePreview>(); vi.mocked(api.prepare).mockReturnValueOnce(pending.promise);
    render(); await flushSetup(); const work = render().prepare('agent-coordinator', selection, false, model.id); await flushSetup();
    vi.mocked(systemRolesApi.overview).mockResolvedValue({ definitions: [], models: [{ ...model, pin: 'd'.repeat(64) }], targets: [] } as unknown as RoleOverview);
    await render().refresh(); pending.resolve(prepared); await work; expect(render().prepared).toBeUndefined(); expect(render().error).toContain('Модель изменилась'); expect(api.start).not.toHaveBeenCalled();
});
it('a successful refresh clears a transient catalog warning without hiding saved history', async () => {
    vi.mocked(systemRolesApi.overview).mockRejectedValueOnce(Error('DOWN')); render(); await flushSetup(); expect(render().error).toContain('Часть данных');
    await render().refresh(); expect(render().error).toBe(''); expect(render().dialogs).toEqual([dialog]);
});
it('StrictMode effect replay invalidates prior work and still permits a new explicit task', async () => {
    render(); h.hooks.replayEffects(); await flushSetup(); await render().prepare('agent-coordinator', selection, false, model.id); await render().start(model.id); expect(api.start).toHaveBeenCalledOnce();
});
it('retains the consented input in this browser session without runtime responses, snapshots or model credentials', async () => {
    const write = vi.spyOn(sessionStorage, 'setItem'); await prepare(); vi.mocked(api.start).mockRejectedValue(Error('ACK LOST')); await render().start(model.id);
    const saved = JSON.parse(write.mock.calls[0][1]); expect(saved).toMatchObject({ version: 1, intent: { dialogId: 'explicit-request', agentId: 'agent-coordinator', input: { ...selection, requestId: 'explicit-request' } } });
    expect(Object.keys(saved.intent).sort()).toEqual(['agentId', 'dialogId', 'input']); expect(write.mock.calls.map(call => call[1]).join('')).not.toContain('Exact own context'); expect(write.mock.calls.map(call => call[1]).join('')).not.toContain('OWN ANSWER');
});
it('full module reload restores the original request body and a readonly 404 still permits only that same-key explicit replay', async () => {
    await prepare(); vi.mocked(api.start).mockRejectedValueOnce(Error('ACK LOST')); await render().start(model.id);
    const original = structuredClone(vi.mocked(api.start).mock.calls[0]); h.hooks.dispose(); vi.resetModules(); enabled = false;
    const { useSystemRoleChat: freshHook } = await import('../src/features/SystemRoleChat/useSystemRoleChat');
    const { systemRoleChatsApi: freshApi } = await import('../src/features/SystemRoleChat/api');
    vi.mocked(freshApi.request).mockRejectedValue({ response: { status: 404 } });
    const renderFresh = () => { h.hooks.begin(); const value = freshHook(project, enabled); h.hooks.commit(); return value; };
    renderFresh(); await flushSetup(); expect(renderFresh().pendingIntent?.input).toEqual(original[2]); expect(renderFresh().receipt?.requestId).toBe('explicit-request');
    expect(freshApi.request).toHaveBeenCalled(); const count = vi.mocked(freshApi.start).mock.calls.length; await renderFresh().replay(); expect(freshApi.start).toHaveBeenCalledTimes(count);
    enabled = true; await renderFresh().replay(); expect(vi.mocked(freshApi.start).mock.calls.at(-1)).toEqual(original);
});
it('read-only 404 keeps the original receipt because an unknown POST can still commit later', async () => {
    saveServiceIntent(JSON.stringify(['alice', 'prj-one']), { dialogId: dialog.id, agentId: 'agent-coordinator', input: { ...selection, requestId: 'missing', modelId: model.id, expectedModelPin: model.pin, expectedDefinitionPin: prepared.prepared.definitionPin, consentDigest: prepared.prepared.consentDigest } });
    vi.mocked(api.request).mockRejectedValue({ response: { status: 404 } }); render(); await flushSetup(); expect(render().receipt?.requestId).toBe('missing'); expect(render().error).toContain('пока не подтвердил'); expect(api.start).not.toHaveBeenCalled();
    await render().prepare('agent-coordinator', selection, false, model.id); expect(api.prepare).not.toHaveBeenCalled(); await render().replay(); expect(api.start).toHaveBeenCalledExactlyOnceWith(dialog.id, 'agent-coordinator', expect.objectContaining({ requestId: 'missing' }));
});
