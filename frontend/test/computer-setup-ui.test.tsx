// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SetupProgress} from '../src/modules/Start/SetupProgress';
import {CliObservation} from '../src/features/ComputerSetup/CliObservation';
import {cliStorageKey} from '../src/features/ComputerSetup/storage';
import type {useBridge} from '../src/features/McpBridge/useBridge';
import {at, completed, deferred, deviceId, email, envelope, intent, job, jobId, request, requestKey} from './computer-setup.fixture';

const h = vi.hoisted(() => ({scope: '', enabled: true, role: 'Наблюдатель',
    capture: () => {const scope = h.scope; return () => scope === h.scope;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.scope, captureOwner: h.capture})}));
vi.mock('react-redux', () => ({useSelector: (selector: (state: unknown) => unknown) => selector({userBlock: {user: {
    id: 'own-actor', email: 'owner@example.test', activeRole: h.role, userRoles: ['Наблюдатель', 'Разработчик'], projectRoles: [], routePermissions: [],
}}})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: h.enabled, reason: h.enabled ? '' : 'Новые проверки выключены главным администратором'})}));
vi.mock('../src/features/ComputerSetup/api', () => ({cliObservationApi: {list: vi.fn(), create: vi.fn(), request: vi.fn(), cancel: vi.fn()}}));
import {cliObservationApi as api} from '../src/features/ComputerSetup/api';

let root: Root, container: HTMLDivElement, bridge: ReturnType<typeof useBridge>, sequence = 0;
let previousLocks: PropertyDescriptor | undefined;
const render = async (masterEnabled = true) => {await act(async () => root.render(createElement(SetupProgress, {bridge,
    cli: createElement(CliObservation, {bridge, canStart: masterEnabled})})));};
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
const eventually = async (check: () => void) => {await vi.waitFor(async () => {await act(async () => {await Promise.resolve();}); check();}, {timeout: 1000, interval: 5});};
const click = async (node: HTMLButtonElement) => {expect(node).toBeTruthy(); await act(async () => node.click());};

beforeEach(() => {
    vi.resetAllMocks(); h.scope = 'cli-ui-owner-' + ++sequence; h.enabled = true; h.role = 'Наблюдатель';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
    vi.stubGlobal('crypto', {subtle: webcrypto.subtle, randomUUID: () => requestKey});
    vi.stubGlobal('matchMedia', (query: string) => ({matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {configurable: true, value: {request: vi.fn(async (_key: string, _options: unknown, change: (lock: object) => unknown) => change({}))}});
    const device = {id: deviceId, name: 'Own Linux', online: true, role: 'Наблюдатель', fingerprint: 'own', lastSeen: at,
        report: {bridgeVersion: '0.9.25', protocolVersion: 2, platform: 'linux', capabilities: ['opencode-cli-v1']}};
    bridge = {device, devices: [device], devicesReady: true, errors: {devices: '', jobs: '', installations: ''}} as unknown as ReturnType<typeof useBridge>;
    vi.mocked(api.list).mockResolvedValue([]); vi.mocked(api.create).mockResolvedValue(job());
    vi.mocked(api.request).mockResolvedValue(envelope(intent, completed())); vi.mocked(api.cancel).mockResolvedValue(undefined);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); localStorage.clear();
    if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks); else Reflect.deleteProperty(navigator, 'locks');
    vi.unstubAllGlobals();
});

it('observes before any project selection only after fresh status, and heartbeat renders do not enqueue again', async () => {
    bridge = {...bridge, devicesReady: false}; await render(); await eventually(() => expect(api.list).toHaveBeenCalled());
    expect(api.create).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('OpenCode не найден');
    bridge = {...bridge, devicesReady: true}; await render();
    await eventually(() => expect(container.textContent).toContain('OpenCode 1.14.48'));
    expect(api.create).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
    expect(container.textContent).not.toContain('Выберите проект'); expect(container.textContent).not.toContain('opencode --version');
    bridge = {...bridge, device: {...bridge.device!, lastSeen: '2026-10-28T00:02:00.000Z', report: {...bridge.device!.report}}};
    await render(); expect(api.create).toHaveBeenCalledOnce();
});

it('an old bridge shows its actual version and update requirement without inventing missing CLI', async () => {
    bridge = {...bridge, device: {...bridge.device!, report: {bridgeVersion: '0.9.25', capabilities: []}}};
    await render(); await eventually(() => expect(api.list).toHaveBeenCalled());
    expect(container.textContent).toContain('Для проверки OpenCode обновите мост (сейчас 0.9.25)');
    expect(container.textContent).not.toContain('OpenCode не найден'); expect(api.create).not.toHaveBeenCalled();
});

it('legacy master OFF reads an accepted observation and preserves a usable read-only refresh', async () => {
    localStorage.setItem(cliStorageKey(email, deviceId), JSON.stringify({...intent, jobId})); await render(false);
    await eventually(() => expect(container.textContent).toContain('OpenCode 1.14.48'));
    const reads = vi.mocked(api.request).mock.calls.length; await click(button('Обновить состояние'));
    await eventually(() => expect(vi.mocked(api.request).mock.calls.length).toBeGreaterThan(reads));
    expect(container.textContent).toContain('OpenCode 1.14.48'); expect(api.create).not.toHaveBeenCalled();
});

it('feature OFF retains the result and cancellation of an already accepted job without another POST', async () => {
    vi.mocked(api.request).mockResolvedValue(envelope()); await render();
    await eventually(() => expect(button('Отменить проверку')).toBeTruthy()); h.enabled = false; await render();
    vi.mocked(api.request).mockResolvedValue(envelope(intent, job({state: 'cancelled'})));
    await click(button('Отменить проверку')); await eventually(() => expect(container.textContent).toContain('Проверка отменена'));
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(jobId, expect.any(AbortSignal)); expect(api.create).toHaveBeenCalledOnce();
});

it('a worker failure before observation shows no missing status or fabricated check timestamp', async () => {
    vi.mocked(api.request).mockResolvedValue(envelope(intent, job({state: 'failed', result: {}}))); await render();
    await eventually(() => expect(container.textContent).toContain('Проверка не завершена'));
    expect(container.textContent).not.toContain('OpenCode не найден'); expect(container.textContent).not.toContain('Проверено'); expect(api.create).toHaveBeenCalledOnce();
});

it('a partial initial history failure has an explicit continuation and never starts until reading succeeds', async () => {
    vi.mocked(api.list).mockRejectedValueOnce(Error('Controlled unavailable')).mockResolvedValue([]); await render();
    await eventually(() => expect(button('Обновить состояние')).toBeTruthy()); expect(api.create).not.toHaveBeenCalled();
    await click(button('Обновить состояние')); await eventually(() => expect(container.textContent).toContain('OpenCode 1.14.48'));
    expect(api.create).toHaveBeenCalledOnce();
});

it('missing WebLock keeps server history readable and never starts an automatic request', async () => {
    Object.defineProperty(navigator, 'locks', {configurable: true, value: undefined});
    vi.mocked(api.list).mockResolvedValue([completed()]); await render();
    await eventually(() => expect(container.textContent).toContain('OpenCode 1.14.48'));
    expect(container.textContent).toContain('Автопроверка недоступна в этом браузере'); expect(api.create).not.toHaveBeenCalled();
});

it('corrupt storage stays intact and exposes read-only recovery without a POST', async () => {
    const key = cliStorageKey(email, deviceId); localStorage.setItem(key, '{broken'); await render();
    await eventually(() => expect(container.textContent).toContain('Сохранённая отправка OpenCode не прочитана'));
    expect(button('Проверить отправку')).toBeUndefined(); expect(button('Обновить состояние')).toBeTruthy();
    await click(button('Обновить состояние')); expect(localStorage.getItem(key)).toBe('{broken'); expect(api.create).not.toHaveBeenCalled();
});

it('switching active role while POST ACK is held only reads the saved original request', async () => {
    const sent = deferred<void>(), ack = deferred<unknown>();
    vi.mocked(api.create).mockImplementation(() => {sent.resolve(); return ack.promise;}); vi.mocked(api.request).mockResolvedValue(envelope());
    await render(); await act(async () => sent.promise);
    h.scope += '-new-role'; h.role = 'Разработчик'; await render();
    await eventually(() => expect(api.request).toHaveBeenCalled());
    await act(async () => ack.resolve(job()));
    expect(api.create).toHaveBeenCalledOnce(); expect(container.textContent).toContain('исходную активную роль');
    expect(localStorage.getItem(cliStorageKey(email, deviceId))).toContain('Наблюдатель');
});

it('switching selected device before held ACK cannot show the previous device result or overwrite its saved body', async () => {
    const sent = deferred<void>(), ack = deferred<unknown>(); vi.mocked(api.create).mockImplementation(() => {sent.resolve(); return ack.promise;});
    await render(); await act(async () => sent.promise); const raw = localStorage.getItem(cliStorageKey(email, deviceId));
    bridge = {...bridge, device: {...bridge.device!, id: requestKey, name: 'Other Linux'}, devicesReady: false}; await render();
    await act(async () => ack.resolve(completed()));
    expect(container.textContent).toContain('Other Linux'); expect(container.textContent).not.toContain('OpenCode 1.14.48');
    expect(localStorage.getItem(cliStorageKey(email, deviceId))).toBe(raw); expect(api.create).toHaveBeenCalledOnce();
});

it('a cross-tab journal change pauses sending until an explicit exact receipt read', async () => {
    vi.mocked(api.request).mockResolvedValue(envelope()); await render();
    await eventually(() => expect(button('Отменить проверку')).toBeTruthy());
    const foreign = {...intent, request: {...request, requestKey: jobId}}, key = cliStorageKey(email, deviceId);
    await act(async () => {localStorage.setItem(key, JSON.stringify(foreign)); window.dispatchEvent(new StorageEvent('storage', {key}));});
    expect(container.textContent).toContain('Отправка изменена в другой вкладке'); expect(api.create).toHaveBeenCalledOnce();
    vi.mocked(api.request).mockResolvedValue(envelope(foreign, job({state: 'cancelled'})));
    await click(button('Проверить отправку'));
    await eventually(() => expect(container.textContent).toContain('Проверка отменена'));
    expect(api.request).toHaveBeenLastCalledWith(jobId, expect.any(AbortSignal));
    expect(api.cancel).not.toHaveBeenCalled(); expect(api.create).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(key)!).request).toEqual(foreign.request);
});
