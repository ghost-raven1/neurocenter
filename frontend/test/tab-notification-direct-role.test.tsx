// @vitest-environment jsdom
import {act, createElement, StrictMode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {useTabNotifications} from '../src/features/TabNotifications/useTabNotifications';
import {readTabSnapshot} from '../src/features/TabNotifications/read';
import {useSystemRole} from '../src/features/SystemRoles/useSystemRole';
import {systemRolesApi} from '../src/features/SystemRoles/api';
import {notificationRoleInput, notificationRoleOverview, notificationRoleRun} from './tab-notification-role-fixtures';
import {tabRow, tabSnapshot} from './tab-notification-fixtures';

const h = vi.hoisted(() => {
    const state = {scope: 'alice', owner: {}, capture: () => {const owner = state.owner; return () => owner === state.owner;}};
    return state;
});
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.scope, captureOwner: h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: true})}));
vi.mock('../src/features/TabNotifications/read', () => ({readTabSnapshot: vi.fn()}));
vi.mock('../src/features/SystemRoles/api', () => ({systemRolesApi: {overview: vi.fn(), list: vi.fn(), get: vi.fn(), start: vi.fn(), action: vi.fn(), prepare: vi.fn()}}));

let role: ReturnType<typeof useSystemRole>, root: Root, container: HTMLDivElement, head: string;
function Monitor() {useTabNotifications(true, 'alice@example.test'); return null;}
function Role() {role = useSystemRole('agent-ai-admin', 'prj-one'); return null;}
function App({pane}: {pane: boolean}) {return createElement(StrictMode, null, createElement(Monitor), pane && createElement(Role));}
const render = async (pane = false) => {await act(async () => {root.render(createElement(App, {pane}));});};
const advance = async (ms = 4000) => {await act(async () => {await vi.advanceTimersByTimeAsync(ms);});};
const hide = (): void => {Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'}); document.dispatchEvent(new Event('visibilitychange'));};
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.owner = {}; h.scope = 'alice';
    head = document.head.innerHTML; document.head.innerHTML = '<title>Нейроцентр</title><link rel="icon" href="/brand.svg">';
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    vi.mocked(systemRolesApi.overview).mockResolvedValue(notificationRoleOverview); vi.mocked(systemRolesApi.list).mockResolvedValue([]);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => {root.unmount();}); container.remove(); document.head.innerHTML = head;
    Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.unstubAllGlobals();
});

it('a direct system-role accepted operation remains observable after its modal closes without opening Operations', async () => {
    const run = notificationRoleRun({state: 'queued', phase: 'queued', revision: 1, canApply: false});
    vi.mocked(systemRolesApi.start).mockResolvedValue(run);
    const source = {kind: 'operation' as const, id: run.operationId, projectId: run.projectId};
    vi.mocked(readTabSnapshot).mockResolvedValue(tabSnapshot(source, [tabRow(run.operationId, 'terminal', '2026-10-25T00:01:00Z')], 2));
    await render(true); await act(async () => {await role.start(notificationRoleInput);}); expect(role.run?.operationId).toBe(run.operationId);
    hide(); await render(); await advance();
    expect(systemRolesApi.start).toHaveBeenCalledExactlyOnceWith('agent-ai-admin', notificationRoleInput);
    expect(readTabSnapshot).toHaveBeenCalledExactlyOnceWith(source, expect.any(AbortSignal), [run.operationId]);
    expect(document.title).toBe('(1) Нейроцентр');
});
