// @vitest-environment jsdom
import {act, createElement, StrictMode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {useTabNotifications} from '../src/features/TabNotifications/useTabNotifications';
import {tabNotifications} from '../src/features/TabNotifications/tracker';
import {projectTabSource} from '../src/features/TabNotifications/snapshots';
import {useProjectChat} from '../src/features/ProjectChat/useProjectChat';
import {projectChatApi} from '../src/features/ProjectChat/api';
import {projectMessage, projectRoom} from './project-chat-fixtures';

const h = vi.hoisted(() => {
    const state = {owner: {}, capture: () => {const owner = state.owner; return () => owner === state.owner;}};
    return state;
});
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: 'alice', captureOwner: h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: true})}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: () => undefined}));
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn()}}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {read: vi.fn()}}));
vi.mock('../src/features/SystemRoleChat/api', () => ({systemRoleChatsApi: {read: vi.fn(), request: vi.fn()}}));
vi.mock('../src/features/ProjectChat/api', () => ({projectChatApi: {read: vi.fn(), send: vi.fn(), cancel: vi.fn()}}));

const source = projectTabSource('prj-one', 'room-one');
let chat: ReturnType<typeof useProjectChat>, root: Root, container: HTMLDivElement, head: string;
function Monitor() {useTabNotifications(true, 'alice@example.test'); return null;}
function Project() {chat = useProjectChat('prj-one', 'room-one'); return null;}
function App({pane}: {pane: boolean}) {return createElement(StrictMode, null, createElement(Monitor), pane && createElement(Project));}
const render = async (pane = false) => {await act(async () => {root.render(createElement(App, {pane}));});};
beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.owner = {};
    head = document.head.innerHTML; document.head.innerHTML = '<title>Нейроцентр</title><link rel="icon" href="/brand.svg">';
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => {root.unmount();}); container.remove(); document.head.innerHTML = head;
    Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.unstubAllGlobals();
});

it('an old TEAM result already received by the open chat does not become a fresh notification after closing it', async () => {
    const value = projectRoom(), older = projectMessage({id: 'older-slot', roomId: source.id, position: '1', kind: 'agent', author: null, status: 'running'});
    const newer = Array.from({length: 50}, (_, index) => projectMessage({id: `newer-${index}`, roomId: source.id, position: String(index + 2)}));
    const baseline = {...value, room: {...value.room, id: source.id}, messages: [older, ...newer]};
    vi.mocked(projectChatApi.read).mockResolvedValue(baseline); await render(true);
    expect(chat.detail?.messages.find(message => message.id === older.id)?.status).toBe('running');
    vi.mocked(projectChatApi.read).mockImplementation(async (_project, _signal, watch = []) => ({...baseline, room: {...baseline.room, revision: 2},
        messages: [...(watch.includes(older.id) ? [{...older, status: 'done' as const, content: 'Старый ответ готов'}] : []), ...newer]}));
    await act(async () => {await chat.refresh();});
    expect(chat.detail?.messages.find(message => message.id === older.id)).toMatchObject({status: 'done', content: 'Старый ответ готов'});
    expect(document.title).toBe('Нейроцентр');
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'}); document.dispatchEvent(new Event('visibilitychange'));
    await render(); await act(async () => {await vi.advanceTimersByTimeAsync(20000);});
    expect(document.title).toBe('Нейроцентр'); expect(tabNotifications.pendingIds('alice', source)).toEqual([]);
    expect(projectChatApi.send).not.toHaveBeenCalled(); expect(projectChatApi.cancel).not.toHaveBeenCalled();
});
