// @vitest-environment jsdom
import {act, createElement, StrictMode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useTabNotifications} from '../src/features/TabNotifications/useTabNotifications';
import {readTabSnapshot} from '../src/features/TabNotifications/read';
import {serviceTabSnapshot} from '../src/features/TabNotifications/snapshots';
import {useSystemRoleChat} from '../src/features/SystemRoleChat/useSystemRoleChat';
import {useSystemRole} from '../src/features/SystemRoles/useSystemRole';
import {systemRolesApi} from '../src/features/SystemRoles/api';
import {systemRoleChatsApi} from '../src/features/SystemRoleChat/api';
import type {TabSnapshot} from '../src/features/TabNotifications/types';
import {notificationRoleInput, notificationRoleOverview, notificationRoleRun, notificationServiceDetail, notificationServiceTurn} from './tab-notification-role-fixtures';
import {tabDeferred, tabRow, tabSnapshot} from './tab-notification-fixtures';

const h = vi.hoisted(() => {
    const state = {scope: 'alice', owner: {}, capture: () => {const owner = state.owner; return () => owner === state.owner;}};
    return state;
});
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.scope, captureOwner: h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: true})}));
vi.mock('../src/features/TabNotifications/read', () => ({readTabSnapshot: vi.fn()}));
vi.mock('../src/features/SystemRoles/api', () => ({systemRolesApi: {overview: vi.fn(), list: vi.fn(), get: vi.fn(), start: vi.fn(), action: vi.fn(), prepare: vi.fn()}}));
vi.mock('../src/features/SystemRoleChat/api', () => ({systemRoleChatsApi: {list: vi.fn(), read: vi.fn(), request: vi.fn()}}));

let chat: ReturnType<typeof useSystemRoleChat>, role: ReturnType<typeof useSystemRole>;
function Monitor() {useTabNotifications(true, 'alice@example.test'); return null;}
function Service() {chat = useSystemRoleChat('prj-one', true); return null;}
function Role() {role = useSystemRole('agent-ai-admin', 'prj-one'); return null;}
function App({pane}: {pane?: 'service' | 'role'}) {return createElement(StrictMode, null, createElement(Monitor), pane === 'service' ? createElement(Service) : pane === 'role' ? createElement(Role) : null);}
let root: Root, container: HTMLDivElement, head: string;
const render = async (pane?: 'service' | 'role') => {await act(async () => {root.render(createElement(App, {pane}));});};
const advance = async (ms = 4000) => {await act(async () => {await vi.advanceTimersByTimeAsync(ms);});};
const hide = (): void => {Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'}); document.dispatchEvent(new Event('visibilitychange'));};
const readService = (state: 'awaiting_review' | 'applying' | 'succeeded', revision: number): TabSnapshot => serviceTabSnapshot({
    ...notificationServiceDetail(), turns: [notificationServiceTurn(notificationRoleRun({state, revision, phase: state}))],
});
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.owner = {}; h.scope = 'alice';
    head = document.head.innerHTML; document.head.innerHTML = '<title>Нейроцентр</title><link rel="icon" href="/brand.svg">';
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    vi.mocked(systemRolesApi.overview).mockResolvedValue(notificationRoleOverview); vi.mocked(systemRolesApi.list).mockResolvedValue([]);
    vi.mocked(systemRoleChatsApi.list).mockResolvedValue([notificationServiceDetail().dialog]); vi.mocked(systemRoleChatsApi.read).mockResolvedValue(notificationServiceDetail());
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => {root.unmount();}); container.remove(); document.head.innerHTML = head;
    Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.unstubAllGlobals();
});
async function openProposal() {await render('service'); await act(async () => {await chat.select('dialog-one');}); expect(chat.detail?.turns[0].run?.revision).toBe(3);}
async function closeDuringApply() {
    let action!: Promise<void>;
    await act(async () => {action = chat.action(chat.detail!.turns[0], 'apply'); hide(); root.render(createElement(App, {}));});
    return {action};
}

describe('Role action acceptance is distinct from an attempted POST', () => {
    it('a definitive apply conflict followed by unchanged review revision does not create a fresh notification', async () => {
        const attempt = tabDeferred<ReturnType<typeof notificationRoleRun>>(); vi.mocked(systemRolesApi.action).mockReturnValueOnce(attempt.promise);
        vi.mocked(readTabSnapshot).mockResolvedValue(readService('awaiting_review', 3)); await openProposal();
        const {action} = await closeDuringApply(); await act(async () => {attempt.reject({response: {status: 409}}); await action;});
        await advance(); expect(systemRolesApi.action).toHaveBeenCalledOnce(); expect(document.title).toBe('Нейроцентр');
        expect(readTabSnapshot).toHaveBeenCalled();
    });
    it('an accepted apply transitions through the newer applying revision and notifies on the confirmed terminal result', async () => {
        const attempt = tabDeferred<ReturnType<typeof notificationRoleRun>>(); vi.mocked(systemRolesApi.action).mockReturnValueOnce(attempt.promise);
        vi.mocked(readTabSnapshot).mockResolvedValueOnce(readService('applying', 4)).mockResolvedValueOnce(readService('succeeded', 5)); await openProposal();
        const {action} = await closeDuringApply(); await act(async () => {attempt.resolve(notificationRoleRun({state: 'applying', phase: 'applying', revision: 4})); await action;});
        await advance(); expect(document.title).toBe('Нейроцентр'); await advance(); expect(document.title).toBe('(1) Нейроцентр');
        expect(systemRolesApi.action).toHaveBeenCalledOnce();
    });
    it('an unknown apply ACK keeps observing a future authoritative transition without repeating the action', async () => {
        const attempt = tabDeferred<ReturnType<typeof notificationRoleRun>>(); vi.mocked(systemRolesApi.action).mockReturnValueOnce(attempt.promise);
        vi.mocked(readTabSnapshot).mockResolvedValueOnce(readService('applying', 4)).mockResolvedValueOnce(readService('succeeded', 5)); await openProposal();
        const {action} = await closeDuringApply(); await act(async () => {attempt.reject(Error('ACK lost')); await action;});
        await advance(); expect(document.title).toBe('Нейроцентр'); await advance(); expect(document.title).toBe('(1) Нейроцентр');
        expect(systemRolesApi.action).toHaveBeenCalledOnce();
    });
    it('an unknown ACK preserves its baseline across an unchanged GET and a fast terminal revision without observing applying', async () => {
        const attempt = tabDeferred<ReturnType<typeof notificationRoleRun>>(); vi.mocked(systemRolesApi.action).mockReturnValueOnce(attempt.promise);
        vi.mocked(readTabSnapshot).mockResolvedValueOnce(readService('awaiting_review', 3)).mockResolvedValueOnce(readService('succeeded', 5)); await openProposal();
        const {action} = await closeDuringApply(); await act(async () => {attempt.reject(Error('ACK lost')); await action;});
        await advance(); expect(document.title).toBe('Нейроцентр'); await advance(); expect(document.title).toBe('(1) Нейроцентр');
        expect(systemRolesApi.action).toHaveBeenCalledOnce(); expect(readTabSnapshot).toHaveBeenCalledTimes(2);
    });
});

it('a direct system-role accepted operation remains observable after its modal closes without opening Operations', async () => {
    const run = notificationRoleRun({state: 'queued', phase: 'queued', revision: 1, canApply: false});
    vi.mocked(systemRolesApi.start).mockResolvedValue(run);
    const source = {kind: 'operation' as const, id: run.operationId, projectId: run.projectId};
    vi.mocked(readTabSnapshot).mockResolvedValue(tabSnapshot(source, [tabRow(run.operationId, 'terminal', '2026-10-25T00:01:00Z')], 2));
    await render('role'); await act(async () => {await role.start(notificationRoleInput);}); expect(role.run?.operationId).toBe(run.operationId);
    hide(); await render(); await advance();
    expect(systemRolesApi.start).toHaveBeenCalledExactlyOnceWith('agent-ai-admin', notificationRoleInput);
    expect(readTabSnapshot).toHaveBeenCalledExactlyOnceWith(source, expect.any(AbortSignal), [run.operationId]);
    expect(document.title).toBe('(1) Нейроцентр');
});
