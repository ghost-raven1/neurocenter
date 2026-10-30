// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ComputerEnvironmentProvider} from '../src/features/ComputerSetup/ComputerEnvironment';
import {ComputerHeader} from '../src/features/ComputerSetup/ComputerHeader';
import UnifiedProjectSetup from '../src/modules/Start/UnifiedProjectSetup';
import type {useBridge} from '../src/features/McpBridge/useBridge';
import type {CliIntent} from '../src/features/ComputerSetup/model';
import {at, completed, deferred, deviceId, email, envelope, job, jobId, observed} from './computer-setup.fixture';
import {httpError} from './computer-setup.fixture';

const h = vi.hoisted(() => ({scope: '', enabled: true, role: 'Наблюдатель', pathname: '/start', search: '',
    bridge: undefined as unknown as ReturnType<typeof useBridge>, push: vi.fn(), replace: vi.fn(),
    capture: () => {const scope = h.scope; return () => scope === h.scope;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.scope, captureOwner: h.capture})}));
vi.mock('react-redux', () => ({useSelector: (select: (value: unknown) => unknown) => select({userBlock: {user: {
    id: 'own-header-actor', email: 'owner@example.test', activeRole: h.role, userRoles: ['Наблюдатель'], projectRoles: [], routePermissions: [],
}}})}));
vi.mock('react-router-dom', () => ({useLocation: () => ({pathname: h.pathname, search: h.search, hash: ''}), useHistory: () => ({push: h.push, replace: h.replace})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: h.enabled, reason: h.enabled ? '' : 'Проверки выключены'})}));
vi.mock('../src/features/McpBridge/useBridge', () => ({useBridge: () => h.bridge}));
vi.mock('../src/features/McpBridge/useBridgeInstaller', () => ({useBridgeInstaller: () => ({loading: false, error: '', reload: vi.fn(),
    devSupply: {version: '0.9.28', buildId: 'a'.repeat(64), targets: ['linux-x64']}})}));
vi.mock('../src/modules/Projects/useAvailableProjects', () => ({useAvailableProjects: () => ({projects: [], ready: true, error: '', loading: false, refresh: vi.fn()})}));
vi.mock('../src/modules/Store/useProjectCatalog', () => ({useProjectCatalog: () => ({assets: [], ready: true, error: '', refresh: vi.fn()})}));
vi.mock('../src/features/McpBridge/BridgeInstallerCommand', () => ({BridgeInstallerCommand: () => null}));
vi.mock('../src/features/McpBridge/WorkspaceBindingWizard', () => ({WorkspaceBindingWizard: () => null}));
vi.mock('../src/features/McpBridge/LocalInstallations', () => ({LocalInstallations: () => null}));
vi.mock('../src/features/AgentCatalog/AgentCatalog', () => ({AgentCatalog: () => null}));
vi.mock('../src/modules/Projects/local/LocalProjectsFolder', () => ({LocalProjectsFolder: () => null}));
vi.mock('../src/modules/Start/BridgeSetup', () => ({BridgeSetup: () => null}));
vi.mock('../src/modules/Start/StartProjectAssets', () => ({StartProjectAssets: () => null}));
vi.mock('../src/features/ComputerSetup/api', () => ({cliObservationApi: {list: vi.fn(), create: vi.fn(), request: vi.fn(), cancel: vi.fn()}}));
import {cliObservationApi as api} from '../src/features/ComputerSetup/api';

let root: Root, container: HTMLDivElement, sequence = 0, previousLocks: PropertyDescriptor | undefined;
const receipts = new Map<string, {intent: CliIntent; value: ReturnType<typeof job>}>();
const render = async () => {await act(async () => root.render(createElement(ComputerEnvironmentProvider, {children:
    createElement('div', null, createElement(ComputerHeader, {onSetup: h.push}), createElement(UnifiedProjectSetup))})));};
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
const eventually = async (check: () => void) => {await vi.waitFor(async () => {await act(async () => {await Promise.resolve();}); check();}, {timeout: 1200, interval: 5});};
const click = async (node: HTMLButtonElement) => {expect(node).toBeTruthy(); await act(async () => node.click());};

beforeEach(() => {
    vi.resetAllMocks(); h.scope = 'computer-header-owner-' + ++sequence; h.enabled = true; h.role = 'Наблюдатель'; h.pathname = '/start'; h.search = '';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); receipts.clear();
    vi.stubGlobal('crypto', {subtle: webcrypto.subtle, randomUUID: () => webcrypto.randomUUID()});
    vi.stubGlobal('matchMedia', (query: string) => ({matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {configurable: true, value: {request: vi.fn(async (_key: string, _options: unknown, change: (lock: object) => unknown) => change({}))}});
    const device = {id: deviceId, name: 'Рабочий Linux', online: true, role: 'Наблюдатель', fingerprint: 'owned-header', lastSeen: at,
        report: {bridgeVersion: '0.9.27', protocolVersion: 2, platform: 'linux', arch: 'x64', capabilities: ['opencode-cli-v1']}};
    h.bridge = {device, devices: [device], jobs: [], installations: [], devicesReady: true, jobsReady: true, installationsReady: true,
        loading: false, errors: {devices: '', jobs: '', installations: ''}, error: '', choose: vi.fn(), reload: vi.fn()} as ReturnType<typeof useBridge>;
    vi.mocked(api.list).mockImplementation(async () => [...receipts.values()].map(item => item.value));
    vi.mocked(api.create).mockImplementation(async input => {
        const id = webcrypto.randomUUID(), intent: CliIntent = {version: 1, email, role: h.role, request: input};
        receipts.set(input.requestKey, {intent, value: job({id, deviceId: input.deviceId, state: 'succeeded', result: {...observed(), jobId: id, deviceId: input.deviceId}})});
        return job({id, deviceId: input.deviceId});
    });
    vi.mocked(api.request).mockImplementation(async key => {const receipt = receipts.get(key); if (!receipt) throw Error('Unknown owned receipt'); return envelope(receipt.intent, receipt.value);});
    vi.mocked(api.cancel).mockResolvedValue(undefined);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); localStorage.clear();
    if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks); else Reflect.deleteProperty(navigator, 'locks');
    vi.unstubAllGlobals();
});

it('shares one automatic inspection between header and setup, and an installed CLI exposes a real fixed check', async () => {
    await render(); await eventually(() => expect(button('Проверить OpenCode')).toBeTruthy());
    expect(api.create).toHaveBeenCalledOnce(); expect(container.querySelectorAll('.computer-header__trigger')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Состояние настройки окружения"]')).toHaveLength(0);
    expect(button('Начать настройку')).toBeUndefined();
    await click(button('Проверить OpenCode')); await eventually(() => expect(api.create).toHaveBeenCalledTimes(2));
    const inputs = vi.mocked(api.create).mock.calls.map(([input]) => input);
    expect(inputs.every(input => input.kind === 'inspect-opencode-cli' && input.scope === 'global' && input.deviceId === deviceId)).toBe(true);
    expect(inputs[0].requestKey).not.toBe(inputs[1].requestKey);
    h.pathname = '/projects'; await render(); h.pathname = '/start'; await render();
    expect(api.create).toHaveBeenCalledTimes(2);
});

it('other pages read available history without an automatic POST, and entering setup probes only once', async () => {
    h.pathname = '/projects'; await render(); await eventually(() => expect(api.list).toHaveBeenCalled());
    expect(api.create).not.toHaveBeenCalled(); h.pathname = '/start'; await render();
    await eventually(() => expect(container.textContent).toContain('OpenCode 1.14.48')); expect(api.create).toHaveBeenCalledOnce();
});

it('details retain bridge version, fresh check time and recovery controls; Escape returns focus', async () => {
    await render(); await eventually(() => expect(container.textContent).toContain('OpenCode 1.14.48'));
    const trigger = container.querySelector<HTMLButtonElement>('.computer-header__trigger')!;
    await click(trigger); await eventually(() => expect(document.querySelector('[aria-label="Сведения о компьютере и OpenCode"]')).toBeTruthy());
    const details = document.querySelector<HTMLElement>('[aria-label="Сведения о компьютере и OpenCode"]')!;
    expect(details.textContent).toContain('Мост 0.9.27'); expect(details.textContent).toContain('Проверено');
    expect(details.textContent).toContain('Доступен мост 0.9.28'); expect(details.textContent).toContain('Проверить подключение');
    await eventually(() => expect(document.activeElement).toBe(details));
    await act(async () => details.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
    expect(trigger.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(trigger);
});

it('feature OFF and a stale device retain history without permitting another check', async () => {
    h.enabled = false; h.bridge = {...h.bridge, devicesReady: false}; vi.mocked(api.list).mockResolvedValue([completed()]);
    await render(); await eventually(() => expect(container.textContent).toContain('OpenCode 1.14.48'));
    expect(container.textContent).toContain('статус не проверен'); expect(api.create).not.toHaveBeenCalled();
    expect(button('Посмотреть состояние и настройку')).toBeTruthy();
});

it('a device switch before held ACK never shows the former version in the header', async () => {
    const sent = deferred<void>(), ack = deferred<unknown>();
    vi.mocked(api.create).mockImplementation(() => {sent.resolve(); return ack.promise;});
    await render(); await act(async () => sent.promise);
    h.bridge = {...h.bridge, device: {...h.bridge.device!, id: jobId, name: 'Другой компьютер'}, devicesReady: false};
    await render(); await act(async () => ack.resolve(job()));
    expect(container.textContent).toContain('Другой компьютер'); expect(container.textContent).not.toContain('OpenCode 1.14.48');
    expect(api.create).toHaveBeenCalledOnce();
});

it('an empty header gives the connection path without fabricating an installed CLI', async () => {
    h.bridge = {...h.bridge, device: undefined, devices: []}; await render();
    expect(container.textContent).toContain('Компьютер не выбран'); expect(container.textContent).not.toContain('OpenCode 1.14.48');
    expect(api.create).not.toHaveBeenCalled();
});

it('only a confirmed missing CLI offers installation; an unavailable known computer keeps the check disabled', async () => {
    vi.mocked(api.list).mockResolvedValue([completed('missing')]); await render();
    await eventually(() => expect(button('Начать настройку')).toBeTruthy());
    expect(api.create).not.toHaveBeenCalled();
    await click(button('Начать настройку')); expect(h.replace).toHaveBeenCalledWith('/start?step=0&setupFlow=bridge-first&setup=1');
    h.bridge = {...h.bridge, device: {...h.bridge.device!, online: false}};
    h.scope += '-read-known-history'; vi.mocked(api.list).mockResolvedValue([completed()]); await render();
    await eventually(() => expect(button('Проверить OpenCode')).toBeTruthy());
    expect(button('Проверить OpenCode').disabled).toBe(true); expect(button('Начать настройку')).toBeUndefined();
    expect(button('Настроить проект')).toBeTruthy(); expect(api.create).not.toHaveBeenCalled();
});

const bundledInstallation=()=>job({kind:'install-opencode-cli',state:'succeeded',result:{schemaVersion:1,scope:'global',deviceId,jobId,checkedAt:at,
    source:{buildId:'a'.repeat(64),target:'darwin-arm64',version:'1.14.48',sha256:'b'.repeat(64)},status:'installed',installedVersion:'1.14.48',commandVersion:null,commandReady:false,nextAction:'inspect-path'}});
it('a confirmed bundled installation is shared with the header and navigation causes no extra inspection',async()=>{
    const installed=bundledInstallation();h.bridge.jobs=[installed] as unknown as ReturnType<typeof useBridge>['jobs'];vi.mocked(api.list).mockResolvedValue([installed]);
    await render();await eventually(()=>expect(container.textContent).toContain('OpenCode 1.14.48 · проверьте PATH'));expect(api.create).not.toHaveBeenCalled();
    h.pathname='/projects';await render();h.pathname='/start';await render();expect(api.create).not.toHaveBeenCalled();
    await click(button('Проверить OpenCode'));await eventually(()=>expect(api.create).toHaveBeenCalledOnce());expect(vi.mocked(api.create).mock.calls[0][0].kind).toBe('inspect-opencode-cli');
});
it('a denied receipt cannot resurrect an installed version from the bridge history snapshot',async()=>{
    const installed=bundledInstallation();h.bridge.jobs=[installed] as unknown as ReturnType<typeof useBridge>['jobs'];vi.mocked(api.list).mockResolvedValue([installed]);
    await render();await eventually(()=>expect(container.textContent).toContain('OpenCode 1.14.48'));
    vi.mocked(api.request).mockRejectedValue(httpError(403));await click(button('Проверить OpenCode'));
    await eventually(()=>expect(container.textContent).not.toContain('OpenCode 1.14.48'));expect(h.bridge.jobs).toHaveLength(1);
    expect(api.create).toHaveBeenCalledOnce();
});
