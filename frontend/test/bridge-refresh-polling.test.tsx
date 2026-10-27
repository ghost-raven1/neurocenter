// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useBridge} from '../src/features/McpBridge/useBridge';
import {CONNECTED_DEVICE_EVENT} from '../src/features/McpBridge/pairingProgress';
import {bridgeFixture} from './opencode-provider.fixture';

const io = vi.hoisted(() => ({devices: vi.fn(), jobs: vi.fn(), installations: vi.fn(), listeners: new Map<string, () => void>(),
    user: {id: 'qa-owner', email: 'qa@example.invalid', activeRole: 'Администратор', userRoles: [], routePermissions: [], projectRoles: []}}));
vi.mock('../src/features/McpBridge/api', () => ({bridgeApi: io}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: io.user, policies: {}}})}));
vi.mock('../src/core/socket/socketClient', () => ({default: {connect: vi.fn(), on: (name: string, callback: () => void) => io.listeners.set(name, callback),
    off: (name: string) => io.listeners.delete(name)}}));

function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
let value: ReturnType<typeof useBridge>, root: Root, container: HTMLDivElement;
function Probe() { value = useBridge(); return createElement('span', null, value.errors.jobs); }
const render = async () => { await act(async () => { root.render(createElement(Probe)); }); };
const changed = async () => { await act(async () => { io.listeners.get('bridge:changed')?.(); await vi.advanceTimersByTimeAsync(151); }); };

beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); io.listeners.clear();
    io.user.email = 'qa@example.invalid'; Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    io.devices.mockResolvedValue(bridgeFixture().devices); io.installations.mockResolvedValue([]); io.jobs.mockResolvedValue([]);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Bridge background refresh ownership', () => {
    it('accepts a slow current response while background events arrive instead of superseding it forever', async () => {
        const pending = deferred<unknown[]>(); io.jobs.mockReturnValueOnce(pending.promise); await render();
        await changed(); await changed(); await changed();
        await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
        const latest = [{id: 'completed', state: 'succeeded'}]; await act(async () => pending.resolve(latest));
        expect(io.jobs).toHaveBeenCalledTimes(1); expect(value.jobs).toEqual(latest); expect(value.jobsReady).toBe(true); expect(value.loading).toBe(false);
    });
    it('shows a slow failed read and recovers on the next background refresh', async () => {
        const pending = deferred<unknown[]>(); io.jobs.mockReturnValueOnce(pending.promise); await render(); await changed();
        await act(async () => pending.reject(Error('HTTP503')));
        expect(value.errors.jobs).toContain('Не удалось загрузить статусы установок'); expect(value.jobsReady).toBe(false);
        await changed(); expect(value.errors.jobs).toBe(''); expect(value.jobsReady).toBe(true);
    });
    it('keeps explicit refresh authoritative over an older in-flight response', async () => {
        const old = deferred<unknown[]>(); io.jobs.mockReturnValueOnce(old.promise); await render();
        const latest = [{id: 'fresh', state: 'running'}]; io.jobs.mockResolvedValueOnce(latest);
        await act(async () => { await value.reload(); }); await act(async () => old.resolve([{id: 'stale'}]));
        expect(io.jobs).toHaveBeenCalledTimes(2); expect(value.jobs).toEqual(latest);
    });
    it('clears old-owner data and rejects a late response after an auth scope change', async () => {
        const old = deferred<unknown[]>(); io.jobs.mockReturnValueOnce(old.promise); await render();
        io.user.email = 'next@example.invalid'; const next = [{id: 'next-owner'}]; io.jobs.mockResolvedValueOnce(next); await render();
        await act(async () => old.resolve([{id: 'old-owner'}])); expect(value.jobs).toEqual(next); expect(value.jobsReady).toBe(true);
    });
    it('forces a fresh device read for an explicitly paired computer while the old read is pending', async () => {
        const old = deferred<unknown[]>(); io.devices.mockReturnValueOnce(old.promise); await render();
        const paired = {...bridgeFixture().devices[0], id: 'new-computer'}; io.devices.mockResolvedValueOnce([paired]);
        await act(async () => { window.dispatchEvent(new CustomEvent(CONNECTED_DEVICE_EVENT, {detail: paired.id})); await vi.advanceTimersByTimeAsync(151); });
        await act(async () => old.resolve(bridgeFixture().devices));
        expect(io.devices).toHaveBeenCalledTimes(2); expect(value.device?.id).toBe(paired.id); expect(value.devicesReady).toBe(true);
    });
});
