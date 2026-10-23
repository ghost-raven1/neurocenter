import {harness, ui} from './project-chat-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useProjectChatActivity} from '../src/features/ProjectChat/useProjectChatActivity';
import {projectChatActivityApi} from '../src/features/ProjectChat/activityApi';
import {projectMessage, projectRoom} from './project-chat-fixtures';
import type {ProjectChatActivity} from '../src/features/ProjectChat/activity.types';
import {DEFAULT_PROJECT_CHAT_ROOM} from '../src/features/ProjectChat/types';

vi.mock('../src/features/ProjectChat/activityApi', () => ({projectChatActivityApi: {read: vi.fn(), update: vi.fn()}}));
vi.mock('../src/core/socket/socketClient', () => ({default: {on: vi.fn(), off: vi.fn()}}));
let focused: boolean, visibility: string, roomId: string;
const denied = vi.fn();
const detail = projectRoom({messages: [projectMessage({id: 'own'}), projectMessage({id: 'incoming', author: {email: 'bob@example.test', displayName: 'Боб'}}), projectMessage({id: 'agent', kind: 'agent', author: null})]});
const snapshot = (patch: Partial<ProjectChatActivity> = {}): ProjectChatActivity => ({roomId, viewerEmail: 'alice@example.test', observedAt: new Date().toISOString(), members: [{email: 'alice@example.test', online: true, typing: false}, {email: 'bob@example.test', online: true, typing: false}], receipts: [], ...patch});
const render = () => {harness.begin(); const value = useProjectChatActivity('prj-one', roomId, detail, denied); harness.commit(); return value;};
const flush = async () => {for (let index = 0; index < 30; index++) await Promise.resolve();};
const ready = async () => {render(); await flush(); return render();};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;}); return {promise, resolve, reject};}
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); ui.flags.clear(); ui.owner = 'alice'; ui.scope = 'alice'; roomId = DEFAULT_PROJECT_CHAT_ROOM; focused = true; visibility = 'visible';
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.defineProperty(Object.assign(new EventTarget(), {hasFocus: () => focused}), 'visibilityState', {get: () => visibility}));
    vi.mocked(projectChatActivityApi.read).mockImplementation(async () => snapshot()); vi.mocked(projectChatActivityApi.update).mockResolvedValue(undefined);
});
afterEach(() => {harness.dispose(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('Активность комнаты принадлежит пользователю и фактическому просмотру', () => {
    it('GET истории и активности не создаёт просмотр или запрос модели', async () => {
        await ready(); expect(projectChatActivityApi.read).toHaveBeenCalledOnce(); expect(projectChatActivityApi.update).not.toHaveBeenCalled();
    });
    it('Явный viewport callback отмечает только входящие сообщения людей, без повторов', async () => {
        const value = await ready(); value.onVisible(['own', 'incoming', 'agent']); await vi.advanceTimersByTimeAsync(250); await flush();
        expect(projectChatActivityApi.update).toHaveBeenCalledOnce(); expect(vi.mocked(projectChatActivityApi.update).mock.calls[0][2]).toMatchObject({visibleMessageIds: ['incoming']});
        render().onVisible(['incoming']); await vi.advanceTimersByTimeAsync(500); expect(projectChatActivityApi.update).toHaveBeenCalledOnce();
    });
    it('Быстрый scroll убирает сообщение из отложенного250мс подтверждения до отправки', async () => {
        const value = await ready(); value.onVisible(['incoming']); await vi.advanceTimersByTimeAsync(200); value.onVisible([]);
        await vi.advanceTimersByTimeAsync(50); expect(projectChatActivityApi.update).not.toHaveBeenCalled();
        value.onVisible(['incoming']); await vi.advanceTimersByTimeAsync(250); expect(projectChatActivityApi.update).toHaveBeenCalledOnce();
    });
    it('Перед отправкой повторно проверяет модальное перекрытие, даже до следующего observer tick', async () => {
        const value = await ready(); let covered = false; value.onVisible(['incoming'], () => covered ? [] : ['incoming']);
        await vi.advanceTimersByTimeAsync(200); covered = true; await vi.advanceTimersByTimeAsync(50); expect(projectChatActivityApi.update).not.toHaveBeenCalled();
    });
    it('Печатает ограничен частотой, истекает после тишины и немедленно очищается при blur', async () => {
        const value = await ready(); value.onTyping('п'); value.onTyping('пр'); expect(projectChatActivityApi.update).toHaveBeenCalledTimes(1);
        expect(vi.mocked(projectChatActivityApi.update).mock.calls[0][2]).toMatchObject({online: true, typing: true});
        focused = false; window.dispatchEvent(new Event('blur')); expect(vi.mocked(projectChatActivityApi.update).mock.calls.at(-1)![2]).toMatchObject({online: false, typing: false});
        focused = true; value.onTyping('продолжаю'); await vi.advanceTimersByTimeAsync(4500); expect(vi.mocked(projectChatActivityApi.update).mock.calls.at(-1)![2]).toMatchObject({online: false, typing: false});
    });
    it('Скрытое окно не отмечает сообщения; OFF сохраняет receipts и разрешает только cleanup', async () => {
        const value = await ready(); visibility = 'hidden'; value.onVisible(['incoming']); value.onTyping('скрытый'); await vi.advanceTimersByTimeAsync(250); expect(projectChatActivityApi.update).not.toHaveBeenCalled();
        visibility = 'visible'; value.onTyping('текст'); ui.flags.set('chat_activity', false); render(); await flush();
        const count = vi.mocked(projectChatActivityApi.update).mock.calls.length; render().onVisible(['incoming']); render().onTyping('новый'); await vi.advanceTimersByTimeAsync(250);
        expect(projectChatActivityApi.update).toHaveBeenCalledTimes(count); expect(render().snapshot).toBeDefined(); expect(vi.mocked(projectChatActivityApi.update).mock.calls.at(-1)![2]).toMatchObject({online: false, typing: false});
    });
    it('403 очищает снимок и вызывает удаление истории комнаты; поздний GET не возвращает её', async () => {
        await ready(); const old = deferred<ProjectChatActivity>(); vi.mocked(projectChatActivityApi.read).mockReturnValueOnce(old.promise).mockRejectedValueOnce({isAxiosError: true, response: {status: 403}});
        await vi.advanceTimersByTimeAsync(4000); expect(denied).toHaveBeenCalledOnce(); expect(render().snapshot).toBeUndefined();
        old.resolve(snapshot()); await flush(); expect(render().snapshot).toBeUndefined();
    });
    it('Запоздалый PUT403 после выключения флага не удаляет доступную историю или receipts', async () => {
        const held = deferred<void>(); vi.mocked(projectChatActivityApi.update).mockReturnValueOnce(held.promise);
        const value = await ready(); value.onTyping('текст');
        // The held write fails before the browser has received the new flag snapshot.
        held.reject({isAxiosError: true, response: {status: 403, data: {code: 'feature_disabled'}}}); await flush();
        expect(denied).not.toHaveBeenCalled(); expect(render().snapshot).toBeDefined();
        ui.flags.set('chat_activity', false); render(); await flush(); expect(denied).not.toHaveBeenCalled(); expect(render().snapshot).toBeDefined();
    });
    it('Выключение именованных диалогов прекращает новые typing/read, сохраняя снимок', async () => {
        roomId = '11111111-1111-4111-8111-111111111111'; await ready(); ui.flags.set('project_chat_dialogs', false); render(); await flush();
        const count = vi.mocked(projectChatActivityApi.update).mock.calls.length; render().onTyping('текст'); render().onVisible(['incoming']); await vi.advanceTimersByTimeAsync(250);
        expect(projectChatActivityApi.update).toHaveBeenCalledTimes(count); expect(render().snapshot).toBeDefined();
    });
    it('Смена комнаты и unmount завершают lease с большей sequence; старый ответ не применится', async () => {
        const old = deferred<ProjectChatActivity>(); vi.mocked(projectChatActivityApi.read).mockReturnValueOnce(old.promise); const one = render(); one.onTyping('первая');
        const first = vi.mocked(projectChatActivityApi.update).mock.calls[0][2]; roomId = '11111111-1111-4111-8111-111111111111'; render(); await flush();
        old.resolve(snapshot({roomId: DEFAULT_PROJECT_CHAT_ROOM})); await flush(); expect(render().snapshot?.roomId).toBe(roomId);
        const cleanup = vi.mocked(projectChatActivityApi.update).mock.calls.find(call => call[1] === DEFAULT_PROJECT_CHAT_ROOM && !call[2].online)![2]; expect(cleanup.sequence).toBeGreaterThan(first.sequence); expect(cleanup.sessionId).toBe(first.sessionId);
        harness.dispose(); expect(vi.mocked(projectChatActivityApi.update).mock.calls.at(-1)![2]).toMatchObject({online: false, typing: false});
    });
});
