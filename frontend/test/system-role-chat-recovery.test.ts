import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferredSetup, flushSetup } from './admin-setup-hooks.fixture';
import { authDataScope } from '../src/features/UserBlock/authDataScope';
import type { IAuthMe } from '../src/core/interfaces';
import type { RoleOverview, RoleRun } from '../src/features/SystemRoles/types';
import type { ServicePreview, ServiceTurn } from '../src/features/SystemRoleChat/types';

const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture');
    const value = { hooks: adminSetupHooks(), scope: '', generation: 0, auth: undefined as { scope: string; generation: number; captureOwner: () => () => boolean } | undefined };
    return value;
});
vi.mock('react', () => ({ useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect, useMemo: h.hooks.memo }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {
    if (!h.auth || h.auth.scope !== h.scope || h.auth.generation !== h.generation) {
        const scope = h.scope, generation = h.generation;
        h.auth = { scope, generation, captureOwner: () => () => scope === h.scope && generation === h.generation };
    }
    return h.auth;
} }));
vi.mock('../src/features/SystemRoles/api', () => ({ systemRolesApi: { overview: vi.fn(), action: vi.fn() } }));
vi.mock('../src/features/SystemRoleChat/api', () => ({ systemRoleChatsApi: { list: vi.fn(), create: vi.fn(), read: vi.fn(), prepare: vi.fn(), start: vi.fn(), request: vi.fn(), cancel: vi.fn() } }));
import { systemRoleChatsApi as api } from '../src/features/SystemRoleChat/api';
import { systemRolesApi } from '../src/features/SystemRoles/api';
import { clearServiceIntent as clearOriginalIntent } from '../src/features/SystemRoleChat/intent';
import { useSystemRoleChat } from '../src/features/SystemRoleChat/useSystemRoleChat';

const project = 'prj-recovery', dialogId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const model = { id: 'model-recovery', name: 'Model', pin: 'a'.repeat(64) };
const dialog = { id: dialogId, title: 'Original task', projectId: project, createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' };
const selection = { projectId: project, instruction: 'Original consented task', diagnostics: [], targets: [] };
const preview: ServicePreview = { selection, prepared: { preview: 'Selected own context', consentDigest: 'b'.repeat(64), definitionPin: 'c'.repeat(64), targets: [] } };
const turn: ServiceTurn = { id: requestId, agentId: 'agent-coordinator', instruction: selection.instruction, createdAt: dialog.createdAt, cancelRequested: false,
    run: { id: 'run-recovery', projectId: project, state: 'succeeded', revision: 1, result: { summary: 'Accepted original' } } as RoleRun };
const originalAuth = () => ({ user: { id: 'alice-id', email: 'alice@example.test', activeRole: 'Админ проекта', userRoles: ['Админ проекта', 'Наблюдатель'], routePermissions: ['models'],
    projectRoles: [{ projectId: project, projectName: 'Recovery', role: 'Админ проекта' }] }, policies: { models: ['Админ проекта'] } }) as unknown as IAuthMe;
const selectAuth = (auth: IAuthMe) => { h.scope = authDataScope(auth); h.generation++; };
let enabled: boolean;
const render = () => { h.hooks.begin(); const value = useSystemRoleChat(project, enabled); h.hooks.commit(); return value; };
function defaults(chatApi: typeof api, roleApi: typeof systemRolesApi) {
    vi.mocked(roleApi.overview).mockResolvedValue({ definitions: [], models: [model], targets: [] } as unknown as RoleOverview);
    vi.mocked(chatApi.list).mockResolvedValue([dialog]); vi.mocked(chatApi.create).mockResolvedValue(dialog);
    vi.mocked(chatApi.read).mockResolvedValue({ dialog, turns: [] }); vi.mocked(chatApi.prepare).mockResolvedValue(preview);
    vi.mocked(chatApi.start).mockResolvedValue(turn); vi.mocked(chatApi.request).mockRejectedValue({ response: { status: 404 } });
}
async function loseAck() {
    render(); await flushSetup(); await render().prepare('agent-coordinator', selection, false, model.id);
    const pending = deferredSetup<ServiceTurn>(); vi.mocked(api.start).mockReturnValueOnce(pending.promise);
    const sending = render().start(model.id); expect(api.start).toHaveBeenCalledOnce();
    pending.reject(Error('Lost ACK after POST may have committed')); await sending;
    return structuredClone(vi.mocked(api.start).mock.calls[0]);
}
async function reopenFromStorage() {
    h.hooks.dispose(); vi.resetModules();
    const { useSystemRoleChat: freshHook } = await import('../src/features/SystemRoleChat/useSystemRoleChat');
    const { systemRoleChatsApi: chatApi } = await import('../src/features/SystemRoleChat/api');
    const { systemRolesApi: roleApi } = await import('../src/features/SystemRoles/api');
    defaults(chatApi, roleApi); vi.mocked(chatApi.start).mockClear(); vi.mocked(chatApi.request).mockClear();
    const renderFresh = () => { h.hooks.begin(); const value = freshHook(project, enabled); h.hooks.commit(); return value; };
    renderFresh(); await flushSetup(); return { render: renderFresh, api: chatApi };
}
beforeEach(() => {
    h.hooks.dispose(); vi.resetAllMocks(); selectAuth(originalAuth()); enabled = true;
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce(dialogId).mockReturnValueOnce(requestId).mockReturnValue('33333333-3333-4333-8333-333333333333') });
    vi.stubGlobal('window', { setInterval, clearInterval }); vi.stubGlobal('document', { visibilityState: 'visible' }); defaults(api, systemRolesApi);
});
afterEach(async () => {
    h.hooks.dispose();
    // Clear both old and reloaded module caches; sessionStorage is replaced on the next test.
    const { clearServiceIntent } = await import('../src/features/SystemRoleChat/intent');
    const auth = originalAuth(), base = authDataScope(auth);
    for (const key of [JSON.stringify([base, project]), JSON.stringify([JSON.stringify([auth.user.id, auth.user.email]), project])]) { clearOriginalIntent(key); clearServiceIntent(key); }
    vi.unstubAllGlobals();
});

it.each([401, 403, 409])('lost ACK followed by replay %i preserves the immutable request through full reload and blocks a new key', async status => {
    const original = await loseAck();
    vi.mocked(api.start).mockRejectedValueOnce({ isAxiosError: true, response: { status, data: { message: 'Replay currently rejected' } } });
    await render().replay(); expect(vi.mocked(api.start).mock.calls[1]).toEqual(original);
    const reopened = await reopenFromStorage();
    expect(reopened.render().receipt?.requestId).toBe(requestId);
    expect(reopened.render().pendingIntent?.input).toEqual(original[2]);
    expect(reopened.api.request).toHaveBeenCalledWith(dialogId, requestId);
    const uuidCount = vi.mocked(crypto.randomUUID).mock.calls.length;
    reopened.render().newDialog(); await reopened.render().prepare('agent-coordinator', { ...selection, instruction: 'Different task' }, false, model.id); await reopened.render().start(model.id);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(uuidCount); expect(reopened.api.start).not.toHaveBeenCalled();
    await reopened.render().replay(); expect(reopened.api.start).toHaveBeenCalledExactlyOnceWith(...original);
});

it.each(['activeRole', 'projectRoles', 'policies'])('same principal retains readonly recovery after %s changes while stale handlers are fenced', async change => {
    const original = await loseAck(), retained = render(), next = originalAuth();
    if (change === 'activeRole') next.user.activeRole = 'Наблюдатель';
    else if (change === 'projectRoles') next.user.projectRoles = [{ projectId: project, projectName: 'Renamed project', role: 'Наблюдатель' }];
    else next.policies = { models: ['Главный админ'] };
    selectAuth(next); enabled = false;
    await retained.replay(); expect(api.start).toHaveBeenCalledOnce();
    const reopened = await reopenFromStorage();
    expect(reopened.api.request).toHaveBeenCalledWith(dialogId, requestId);
    expect(reopened.render().receipt?.requestId).toBe(requestId);
    expect(reopened.render().pendingIntent?.input).toEqual(original[2]);
    expect(reopened.api.start).not.toHaveBeenCalled();
});

it.each(['id', 'email'])('another principal with a different %s cannot read or replay the original receipt', async field => {
    await loseAck(); const next = originalAuth(); next.user[field] = field === 'id' ? 'bob-id' : 'bob@example.test'; selectAuth(next);
    const reopened = await reopenFromStorage();
    expect(reopened.render().pendingIntent).toBeUndefined(); expect(reopened.render().receipt).toBeUndefined();
    expect(reopened.api.request).not.toHaveBeenCalled(); await reopened.render().replay(); expect(reopened.api.start).not.toHaveBeenCalled();
});

it('a first definitive rejection can release its unaccepted request and requires new consent', async () => {
    render(); await flushSetup(); await render().prepare('agent-coordinator', selection, false, model.id);
    vi.mocked(api.start).mockRejectedValueOnce({ response: { status: 409 } }); await render().start(model.id);
    expect(render().receipt).toBeUndefined(); expect(render().prepared).toBeUndefined();
    await render().replay(); expect(api.start).toHaveBeenCalledOnce();
});

it('denied durable storage blocks the POST while preserving the prepared task and readable history', async () => {
    render(); await flushSetup(); await render().prepare('agent-coordinator', selection, false, model.id);
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    await render().start(model.id);
    expect(api.start).not.toHaveBeenCalled(); expect(render().prepared?.selection).toEqual(selection);
    expect(render().receipt).toBeUndefined(); expect(render().error).toContain('браузер');
    await render().refresh(); expect(render().dialogs).toEqual([dialog]);
});
