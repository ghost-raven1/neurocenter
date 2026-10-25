import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferredSetup, flushSetup } from './admin-setup-hooks.fixture';
import type { RoleMcpTarget } from '../src/features/SystemRoles/types';
import type { RoleMcpDiscovery } from '../src/features/SystemRoleChat/mcpApi';
const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture');
    const state = { hooks: adminSetupHooks(), owner: 'alice', captureOwner: () => { const owner = state.owner; return () => owner === state.owner; } }; return state;
});
vi.mock('react', () => ({ useState: h.hooks.state, useRef: h.hooks.ref, useMemo: h.hooks.memo, useEffect: h.hooks.effect }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: h.owner, captureOwner: h.captureOwner }) }));
vi.mock('../src/features/SystemRoleChat/mcpApi', async original => ({ ...await original<typeof import('../src/features/SystemRoleChat/mcpApi')>(), roleMcpApi: { sources: vi.fn(), discover: vi.fn(), read: vi.fn() } }));
import { roleMcpApi as api } from '../src/features/SystemRoleChat/mcpApi';
import { useMcpTaskDiscovery, useMcpTaskSources } from '../src/features/SystemRoleChat/useMcpTaskTools';
let project: string | undefined, enabled: boolean, target: RoleMcpTarget, initial: string | undefined;
const row = (patch = {}): RoleMcpDiscovery => ({ id: 'discovery-one', state: 'ready', target, tools: [{ name: 'search', description: 'Actual discovered search', schemaDigest: 'b'.repeat(64), inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }], message: 'Ready', ...patch });
const render = () => { h.hooks.begin(); const value = useMcpTaskDiscovery(project, target, enabled, initial); h.hooks.commit(); return value; };
beforeEach(() => {
    h.hooks.dispose(); vi.resetAllMocks(); h.owner = 'alice'; project = 'prj-one'; enabled = true; initial = undefined;
    target = { runtime: 'server', assetId: 'asset-one', version: 1, manifest: 'a'.repeat(64) };
    vi.stubGlobal('crypto', { randomUUID: () => 'discovery-one' }); vi.stubGlobal('window', { setInterval, clearInterval }); vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.mocked(api.discover).mockImplementation(async () => row()); vi.mocked(api.read).mockImplementation(async () => row());
    vi.mocked(api.sources).mockResolvedValue({ enabled: true, assignments: [], limits: { targets: 2, selectedTools: 8, calls: 6 } });
});
afterEach(() => { h.hooks.dispose(); vi.unstubAllGlobals(); });
it('opening a picker does not discover or invoke tools; explicit discovery binds actual returned schemas to the chosen server', async () => {
    render(); await flushSetup(); expect(api.discover).not.toHaveBeenCalled(); expect(api.read).not.toHaveBeenCalled();
    await render().discover(); expect(api.discover).toHaveBeenCalledExactlyOnceWith(project, target, 'discovery-one'); expect(render().discovery?.tools[0].name).toBe('search'); expect(render().canSelect('discovery-one')).toBe(true);
});
it('lost discovery ACK retains the key and supports read-only recovery with the feature OFF', async () => {
    vi.mocked(api.discover).mockRejectedValueOnce(Error('ACK LOST')); render(); await render().discover(); expect(render().requestId).toBe('discovery-one'); expect(render().error).toContain('ACK LOST');
    enabled = false; await render().discover(); expect(api.discover).toHaveBeenCalledOnce(); await render().read(); expect(api.read).toHaveBeenCalledExactlyOnceWith('discovery-one'); expect(render().discovery?.state).toBe('ready');
});
it('unknown discovery 404 can only retry the same explicit key and never silently switches target', async () => {
    vi.mocked(api.discover).mockRejectedValueOnce(Error('ACK LOST')); vi.mocked(api.read).mockRejectedValueOnce({ response: { status: 404 } });
    render(); await render().discover(); await render().read(); expect(render().requestId).toBe('discovery-one'); await render().discover();
    expect(vi.mocked(api.discover).mock.calls[1]).toEqual(vi.mocked(api.discover).mock.calls[0]);
});
it('stored selected discovery reads its actual schema history even when new work is disabled', async () => {
    initial = 'discovery-one'; enabled = false; render(); await flushSetup(); expect(api.read).toHaveBeenCalledExactlyOnceWith(initial); expect(api.discover).not.toHaveBeenCalled(); expect(render().discovery?.tools[0].inputSchema).toHaveProperty('properties.query');
});
it.each(['project', 'project ABA', 'owner', 'target', 'unmount'])('a %s switch fences a late actual-tools response and retained discovery handler', async change => {
    const pending = deferredSetup<RoleMcpDiscovery>(); vi.mocked(api.discover).mockReturnValueOnce(pending.promise); render(); const old = render(), work = old.discover();
    if (change === 'project' || change === 'project ABA') { project = 'prj-two'; render(); if (change === 'project ABA') { project = 'prj-one'; render(); } }
    else if (change === 'owner') { h.owner = 'bob'; render(); }
    else if (change === 'target') { target = { ...target, version: 2 }; render(); }
    else h.hooks.dispose();
    pending.resolve(row()); await work; await old.discover(); expect(api.discover).toHaveBeenCalledOnce();
    if (change !== 'unmount') expect(render().discovery).toBeUndefined();
});
it('a mismatched target pin never provides selectable tools', async () => {
    vi.mocked(api.discover).mockResolvedValue(row({ target: { ...target, manifest: 'c'.repeat(64) } })); render(); await render().discover(); expect(render().canSelect('discovery-one')).toBe(false); expect(render().error).toContain('Источник инструментов изменился');
});
it('no-project global chat cannot start MCP discovery and still renders sources as optional', async () => {
    project = undefined; render(); await render().discover(); expect(api.discover).not.toHaveBeenCalled(); h.hooks.dispose();
    h.hooks.begin(); const value = useMcpTaskSources(project); h.hooks.commit(); await flushSetup(); expect(api.sources).not.toHaveBeenCalled(); expect(value.data).toBeUndefined();
});
it('StrictMode replay leaves one current generation that can explicitly discover', async () => {
    render(); h.hooks.replayEffects(); await flushSetup(); await render().discover(); expect(render().discovery?.state).toBe('ready'); expect(api.discover).toHaveBeenCalledOnce();
});
