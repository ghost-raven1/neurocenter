// @vitest-environment jsdom
import {act, createElement, StrictMode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useTabNotifications} from '../src/features/TabNotifications/useTabNotifications';
import {tabNotifications} from '../src/features/TabNotifications/tracker';
import {serviceTabSource} from '../src/features/TabNotifications/snapshots';
import {useSystemRoleChat} from '../src/features/SystemRoleChat/useSystemRoleChat';
import {clearServiceIntent} from '../src/features/SystemRoleChat/intent';
import {systemRoleChatsApi} from '../src/features/SystemRoleChat/api';
import {systemRolesApi} from '../src/features/SystemRoles/api';
import type {ServiceTurn} from '../src/features/SystemRoleChat/types';
import {notificationRoleInput, notificationRoleOverview, notificationRoleRun, notificationServiceDetail, notificationServiceTurn} from './tab-notification-role-fixtures';
import {tabDeferred} from './tab-notification-fixtures';

const h = vi.hoisted(() => {
    const state = {owner: {}, capture: () => {const owner = state.owner; return () => owner === state.owner;}};
    return state;
});
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: 'alice', captureOwner: h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: true})}));
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn()}}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {read: vi.fn()}}));
vi.mock('../src/features/ProjectChat/api', () => ({projectChatApi: {read: vi.fn()}}));
vi.mock('../src/features/SystemRoles/api', () => ({systemRolesApi: {overview: vi.fn(), action: vi.fn()}}));
vi.mock('../src/features/SystemRoleChat/api', () => ({systemRoleChatsApi: {list: vi.fn(), create: vi.fn(), read: vi.fn(), prepare: vi.fn(), start: vi.fn(), request: vi.fn(), cancel: vi.fn()}}));

const source = serviceTabSource('dialog-one', 'prj-one'), intentScope = JSON.stringify(['alice', 'prj-one']);
const selection = {projectId: 'prj-one', instruction: 'Проверь проект', diagnostics: [], targets: []};
const emptyDetail = {...notificationServiceDetail(), turns: []};
const queued = notificationServiceTurn(notificationRoleRun({state: 'queued', phase: 'queued', revision: 1, canApply: false}));
const terminal = notificationServiceTurn(notificationRoleRun({state: 'succeeded', phase: 'succeeded', revision: 2, canApply: false}));
let chat: ReturnType<typeof useSystemRoleChat>, root: Root, container: HTMLDivElement, head: string;
function Monitor() {useTabNotifications(true, 'alice@example.test'); return null;}
function Service() {chat = useSystemRoleChat('prj-one', true); return null;}
function App({pane}: {pane: boolean}) {return createElement(StrictMode, null, createElement(Monitor), pane && createElement(Service));}
const render = async (pane = false) => {await act(async () => {root.render(createElement(App, {pane}));});};
const advance = async (ms = 4000) => {await act(async () => {await vi.advanceTimersByTimeAsync(ms);});};
const hide = (): void => {Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'}); document.dispatchEvent(new Event('visibilitychange'));};
async function prepareSend() {
    await render(true); await act(async () => {await chat.select('dialog-one');});
    await act(async () => {await chat.prepare('agent-ai-admin', selection, false, 'model-one');}); expect(chat.prepared).toBeDefined();
}
async function closeDuringSend() {
    let sending!: Promise<void>;
    await act(async () => {sending = chat.start('model-one'); hide(); root.render(createElement(App, {pane: false}));});
    return {sending};
}
beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.owner = {};
    const storage = new Map<string, string>(); vi.stubGlobal('sessionStorage', {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key)});
    vi.stubGlobal('crypto', {randomUUID: () => 'request-one'}); clearServiceIntent(intentScope);
    head = document.head.innerHTML; document.head.innerHTML = '<title>Нейроцентр</title><link rel="icon" href="/brand.svg">';
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    vi.mocked(systemRolesApi.overview).mockResolvedValue({...notificationRoleOverview, models: [{id: 'model-one', name: 'Модель', pin: notificationRoleInput.expectedModelPin}]});
    vi.mocked(systemRoleChatsApi.list).mockResolvedValue([emptyDetail.dialog]); vi.mocked(systemRoleChatsApi.read).mockResolvedValue(emptyDetail);
    vi.mocked(systemRoleChatsApi.prepare).mockResolvedValue({selection, prepared: {preview: 'Контекст', consentDigest: notificationRoleInput.consentDigest, definitionPin: notificationRoleInput.expectedDefinitionPin, targets: []}});
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => {root.unmount();}); container.remove(); clearServiceIntent(intentScope); document.head.innerHTML = head;
    Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('A service request may commit after its exact GET first returns 404', () => {
    it('retains the known request while its dialog remains authorized, then notifies late completion without replaying the POST', async () => {
        const attempt = tabDeferred<ServiceTurn>(); vi.mocked(systemRoleChatsApi.start).mockReturnValueOnce(attempt.promise);
        vi.mocked(systemRoleChatsApi.request).mockRejectedValueOnce({response: {status: 404}}).mockResolvedValue(terminal);
        await prepareSend(); const {sending} = await closeDuringSend(); await advance(); expect(document.title).toBe('Нейроцентр');
        await act(async () => {attempt.resolve(queued); await sending;}); await advance(20000);
        expect(document.title).toBe('(1) Нейроцентр'); expect(tabNotifications.pendingIds('alice', source)).toEqual([]);
        expect(systemRoleChatsApi.start).toHaveBeenCalledOnce(); expect(systemRolesApi.action).not.toHaveBeenCalled();
    });
    it.each([403, 404])('a dialog %s still removes the watch and a later result cannot recreate it', async status => {
        const attempt = tabDeferred<ServiceTurn>(); vi.mocked(systemRoleChatsApi.start).mockReturnValueOnce(attempt.promise);
        vi.mocked(systemRoleChatsApi.request).mockRejectedValue({response: {status: 404}});
        await prepareSend(); const {sending} = await closeDuringSend(); vi.mocked(systemRoleChatsApi.read).mockRejectedValue({response: {status}});
        await advance(); expect(tabNotifications.pendingIds('alice', source)).toEqual([]);
        vi.mocked(systemRoleChatsApi.read).mockResolvedValue(emptyDetail); vi.mocked(systemRoleChatsApi.request).mockResolvedValue(terminal);
        await act(async () => {attempt.resolve(queued); await sending;}); await advance(20000);
        expect(document.title).toBe('Нейроцентр'); expect(systemRoleChatsApi.start).toHaveBeenCalledOnce();
    });
});

describe('Sending distinguishes a definitive rejection from an unknown ACK', () => {
    it('a first definitive send rejection releases its unconfirmed pending slot even after the chat unmounts', async () => {
        const attempt = tabDeferred<ServiceTurn>(); vi.mocked(systemRoleChatsApi.start).mockReturnValueOnce(attempt.promise);
        await prepareSend(); const {sending} = await closeDuringSend();
        await act(async () => {attempt.reject({response: {status: 409}}); await sending;});
        expect(tabNotifications.pendingIds('alice', source)).toEqual([]);
        await advance(20000); expect(document.title).toBe('Нейроцентр'); expect(systemRoleChatsApi.start).toHaveBeenCalledOnce();
    });
    it('an unknown send ACK can still notify a fast first terminal GET after the chat closes', async () => {
        vi.mocked(systemRoleChatsApi.start).mockRejectedValueOnce(Error('ACK lost')); vi.mocked(systemRoleChatsApi.request).mockResolvedValue(terminal);
        await prepareSend(); await act(async () => {await chat.start('model-one');}); expect(chat.receipt?.requestId).toBe('request-one');
        hide(); await render(); await advance(); expect(document.title).toBe('(1) Нейроцентр'); expect(systemRoleChatsApi.start).toHaveBeenCalledOnce();
    });
});
