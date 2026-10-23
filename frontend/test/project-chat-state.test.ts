import {harness, ui} from './project-chat-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useProjectChat} from '../src/features/ProjectChat/useProjectChat';
import {projectChatApi} from '../src/features/ProjectChat/api';
import {mergeProjectMessages} from '../src/features/ProjectChat/model';
import {projectMessage, projectRoom} from './project-chat-fixtures';
import type {ProjectChatDetail, ProjectChatReceipt} from '../src/features/ProjectChat/types';

vi.mock('../src/features/ProjectChat/api', () => ({projectChatApi: {read: vi.fn(), history: vi.fn(), send: vi.fn(), retry: vi.fn(), cancel: vi.fn(), participants: vi.fn()}}));
const render = (projectId = 'prj-one') => {harness.begin(); const value = useProjectChat(projectId); harness.commit(); return value;};
const flush = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
const ready = async () => {render(); await flush(); return render();};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;}); return {promise, resolve, reject};}
beforeEach(() => {vi.clearAllMocks(); ui.owner = 'alice'; ui.scope = 'alice'; vi.stubGlobal('document', {visibilityState: 'visible'}); vi.mocked(projectChatApi.read).mockResolvedValue(projectRoom()); vi.mocked(projectChatApi.history).mockResolvedValue({messages: [], history: {hasMore: false, nextCursor: null}});});
afterEach(() => {harness.dispose(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('Общий чат: независимые вопросы и авторитетное состояние', () => {
    it('Открытие читает комнату без создания чата или платного запроса', async () => {
        const chat = await ready(); expect(chat.detail?.members.map(member => member.displayName)).toEqual(['Алиса', 'Боб']); expect(projectChatApi.read).toHaveBeenCalledOnce(); expect(projectChatApi.send).not.toHaveBeenCalled();
    });
    it('Принимает несколько коротких ACK, пока предыдущий вопрос ещё в очереди агентов', async () => {
        vi.mocked(projectChatApi.send).mockImplementation(async (_project, intent) => ({message: projectMessage({id: intent.requestKey, content: intent.prompt, status: 'queued', position: intent.requestKey === 'first' ? '1' : '2'}), roomRevision: intent.requestKey === 'first' ? 2 : 3}));
        const chat = await ready(); await chat.send({requestKey: 'first', prompt: 'Вопрос Алисы', targetAgentIds: ['developer']}); await chat.send({requestKey: 'second', prompt: 'Второй вопрос', targetAgentIds: ['reviewer']});
        expect(projectChatApi.send).toHaveBeenCalledTimes(2); expect(render().detail?.messages.map(value => value.content)).toEqual(['Вопрос Алисы', 'Второй вопрос']);
    });
    it('Старый GET после нового ACK не стирает принятое сообщение или более новую версию', async () => {
        const old = deferred<ProjectChatDetail>(); const chat = await ready(); vi.mocked(projectChatApi.read).mockReturnValueOnce(old.promise); const read = chat.refresh();
        vi.mocked(projectChatApi.send).mockResolvedValueOnce({message: projectMessage(), roomRevision: 5}); await chat.send({requestKey: 'request', prompt: 'Новый вопрос', targetAgentIds: []});
        old.resolve(projectRoom({room: {...projectRoom().room, revision: 2}, messages: []})); await read; await flush();
        expect(render().detail?.room.revision).toBe(5); expect(render().detail?.messages[0].id).toBe('human-one');
    });
    it('Ранняя страница добавляет историю, но не заменяет завершённый ответ старым running', async () => {
        const answer = projectMessage({id: 'answer', kind: 'agent', position: '3', content: 'Готовый ответ', status: 'done'});
        vi.mocked(projectChatApi.read).mockResolvedValue(projectRoom({messages: [answer], history: {hasMore: true, nextCursor: 'answer'}}));
        const history = deferred<Awaited<ReturnType<typeof projectChatApi.history>>>(); vi.mocked(projectChatApi.history).mockReturnValueOnce(history.promise); const chat = await ready(); const one = chat.loadEarlier(); void chat.loadEarlier();
        history.resolve({messages: [projectMessage({id: 'older', position: '1'}), {...answer, status: 'running', content: ''}], history: {hasMore: false, nextCursor: null}}); await one;
        expect(projectChatApi.history).toHaveBeenCalledOnce(); expect(render().detail?.messages.map(value => value.id)).toEqual(['older', 'answer']); expect(render().detail?.messages[1].content).toBe('Готовый ответ');
    });
    it('Отзыв доступа очищает историю, поздний HTTP старого пользователя её не возвращает', async () => {
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({messages: [projectMessage()]})); const chat = await ready();
        vi.mocked(projectChatApi.read).mockRejectedValueOnce({isAxiosError: true, response: {status: 403}}); await chat.refresh(); expect(render().detail).toBeUndefined();
        const late = deferred<ProjectChatDetail>(); vi.mocked(projectChatApi.read).mockReturnValueOnce(late.promise); const read = render().refresh(); ui.owner = 'bob'; late.resolve(projectRoom({messages: [projectMessage()]})); await read; expect(render().detail).toBeUndefined();
    });
    it('Фоновая проверка видит чужой вопрос; скрытая вкладка не делает лишнего опроса', async () => {
        vi.useFakeTimers(); await ready(); vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({room: {...projectRoom().room, revision: 2}, messages: [projectMessage({author: {email: 'bob@example.test', displayName: 'Боб'}})]}));
        await vi.advanceTimersByTimeAsync(4000); expect(render().detail?.messages[0].author?.displayName).toBe('Боб');
        vi.stubGlobal('document', {visibilityState: 'hidden'}); const count = vi.mocked(projectChatApi.read).mock.calls.length; await vi.advanceTimersByTimeAsync(8000); expect(projectChatApi.read).toHaveBeenCalledTimes(count);
    });
    it('Повтор неизвестного результата использует тот же ключ, следующая явная попытка — новый', async () => {
        vi.mocked(projectChatApi.retry).mockRejectedValueOnce(new Error('ACK lost')).mockResolvedValue({message: projectMessage(), roomRevision: 1}); const chat = await ready();
        expect(await chat.retry('human-one')).toBe(false); expect(await render().retry('human-one')).toBe(true); expect(await render().retry('human-one')).toBe(true);
        const requests = vi.mocked(projectChatApi.retry).mock.calls; expect(requests[0][2]).toBe(requests[1][2]); expect(requests[2][2]).not.toBe(requests[1][2]);
    });
    it('Закрытие прерывает транспорт без отмены сохранённой серверной очереди', async () => {
        const ack = deferred<ProjectChatReceipt>(); vi.mocked(projectChatApi.send).mockReturnValueOnce(ack.promise); const chat = await ready(); const pending = chat.send({requestKey: 'request', prompt: 'Долгий вопрос', targetAgentIds: ['developer']});
        const signal = vi.mocked(projectChatApi.send).mock.calls[0][2]; harness.dispose(); expect(signal.aborted).toBe(true); expect(projectChatApi.cancel).not.toHaveBeenCalled();
        ack.resolve({message: projectMessage(), roomRevision: 2}); await pending;
    });
    it('Сортирует bigint-позиции без потери точности и history не деградирует текущий результат', () => {
        const current = projectMessage({id: 'large', position: '9007199254740993', content: 'Готово'}), before = projectMessage({id: 'before', position: '9007199254740992'});
        expect(mergeProjectMessages([current], [before, {...current, content: ''}], true)).toEqual([before, current]);
    });
    it('Следит за старым ответом после 100 новых сообщений и убирает завершённый слот из watch', async () => {
        const source = projectMessage({id: '88c4bfc0-91f7-49c2-8a1a-21a45b65a133', position: '1', status: 'running'});
        const response = projectMessage({id: 'c0ced080-0385-4fab-8fb2-e4da7efbd3e9', position: '2', kind: 'agent', status: 'running', content: '', replyToId: source.id, sourceMessageId: source.id});
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({messages: [source, response]})); const chat = await ready();
        expect(vi.mocked(projectChatApi.read).mock.calls[0][2]).toBeUndefined();
        const later = Array.from({length: 100}, (_, index) => projectMessage({id: 'later-' + index, position: String(index + 3), content: 'Позднее сообщение ' + index}));
        vi.mocked(projectChatApi.read).mockImplementation(async (_project, _signal, watch = []) => projectRoom({room: {...projectRoom().room, revision: 105},
            messages: [...(watch.includes(source.id) ? [{...source, status: 'done' as const}] : []), ...(watch.includes(response.id) ? [{...response, status: 'done' as const, content: 'Старый ответ завершён'}] : []), ...later.slice(-50)], history: {hasMore: true, nextCursor: later[50].id}}));
        await chat.refresh(); let value = render();
        expect(vi.mocked(projectChatApi.read).mock.calls[1][2]).toEqual([source.id, response.id]);
        expect(value.detail?.messages.find(message => message.id === response.id)).toMatchObject({status: 'done', content: 'Старый ответ завершён'});
        await value.refresh(); value = render(); expect(vi.mocked(projectChatApi.read).mock.calls[2][2]).toBeUndefined();
        expect(value.detail?.messages.find(message => message.id === response.id)?.status).toBe('done'); expect(projectChatApi.send).not.toHaveBeenCalled();
    });
    it('Watch ограничен 50 самыми ранними незавершёнными сообщениями, включая подгруженную историю', async () => {
        const pending = Array.from({length: 70}, (_, index) => projectMessage({id: '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'), position: String(index + 1), status: index % 2 ? 'queued' : 'running'}));
        vi.mocked(projectChatApi.read).mockResolvedValue(projectRoom({messages: pending.slice(20), history: {hasMore: true, nextCursor: pending[20].id}}));
        vi.mocked(projectChatApi.history).mockResolvedValueOnce({messages: pending.slice(0, 20), history: {hasMore: false, nextCursor: null}});
        const chat = await ready(); await chat.loadEarlier(); await render().refresh();
        expect(vi.mocked(projectChatApi.read).mock.calls[1][2]).toEqual(pending.slice(0, 50).map(message => message.id));
    });
    it('Смена владельца и проекта не переносит watch; поздняя старая страница не меняет новую комнату', async () => {
        const old = projectMessage({id: 'b9a04ea6-3971-4baf-a7f0-af18e84eeaab', status: 'running'});
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({messages: [old]})); const alice = await ready();
        const delayed = deferred<ProjectChatDetail>(); vi.mocked(projectChatApi.read).mockReturnValueOnce(delayed.promise); const request = alice.refresh();
        expect(vi.mocked(projectChatApi.read).mock.calls[1][2]).toEqual([old.id]); harness.dispose(); ui.owner = 'bob'; ui.scope = 'bob';
        const second = projectRoom({room: {...projectRoom().room, projectId: 'prj-two'}, messages: []}); vi.mocked(projectChatApi.read).mockResolvedValue(second); render('prj-two'); await flush();
        expect(vi.mocked(projectChatApi.read).mock.calls[2][0]).toBe('prj-two'); expect(vi.mocked(projectChatApi.read).mock.calls[2][2]).toBeUndefined();
        delayed.resolve(projectRoom({room: {...projectRoom().room, revision: 100}, messages: [{...old, status: 'done'}]})); await request;
        expect(render('prj-two').detail?.room.projectId).toBe('prj-two'); expect(render('prj-two').detail?.messages).toEqual([]);
    });
    it('После отказа доступа не посылает прежние message IDs в следующий запрос', async () => {
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({messages: [projectMessage({status: 'queued'})]})); const chat = await ready();
        vi.mocked(projectChatApi.read).mockRejectedValueOnce({isAxiosError: true, response: {status: 403}}); await chat.refresh();
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom()); await render().refresh(); expect(vi.mocked(projectChatApi.read).mock.calls[2][2]).toBeUndefined();
    });
    it('Открывает пропущенный диапазон после 100 новых сообщений; свой ACK и watch не маскируют разрыв', async () => {
        const initial = [projectMessage({id: 'first', position: '1'}), projectMessage({id: 'second', position: '2'}), projectMessage({id: 'old-pending', position: '3', status: 'running'})];
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({messages: initial})); const chat = await ready();
        const later = Array.from({length: 100}, (_, index) => projectMessage({id: 'new-' + index, position: String(index + 4)})), ownAck = later[99], tail = later.slice(-50);
        vi.mocked(projectChatApi.send).mockResolvedValueOnce({message: ownAck, roomRevision: 2});
        vi.mocked(projectChatApi.read).mockImplementation(async (_project, _signal, watch = []) => projectRoom({room: {...projectRoom().room, revision: 105},
            messages: [...(watch.includes(initial[2].id) ? [{...initial[2], status: 'done' as const}] : []), ...tail], history: {hasMore: true, nextCursor: tail[0].id}}));
        await chat.send({requestKey: 'own-ack', prompt: 'Свой новый вопрос', targetAgentIds: []}); await flush();
        let current = render(); expect(current.detail?.history).toEqual({hasMore: true, nextCursor: tail[0].id}); expect(current.detail?.messages.find(message => message.id === initial[2].id)?.status).toBe('done');
        vi.mocked(projectChatApi.history).mockResolvedValueOnce({messages: later.slice(0, 50), history: {hasMore: true, nextCursor: later[0].id}});
        await current.loadEarlier(); current = render(); await current.refresh();
        expect(render().detail?.history).toEqual({hasMore: true, nextCursor: later[0].id});
        vi.mocked(projectChatApi.history).mockResolvedValueOnce({messages: initial.map(message => ({...message, status: 'done'})), history: {hasMore: false, nextCursor: null}});
        await render().loadEarlier(); current = render(); expect(current.detail?.history.hasMore).toBe(false);
        expect(current.detail?.messages.map(message => message.position)).toEqual(Array.from({length: 103}, (_, index) => String(index + 1)));
        await current.refresh(); expect(render().detail?.history.hasMore).toBe(false);
    });
    it('ACK сразу открывает IDs всех слотов: дальнейший watch получает ответы даже после ухода вопроса из tail', async () => {
        const source = projectMessage({id: 'c2fec13a-3d94-4e46-9069-bdbd2596b219', position: '1', status: 'queued'});
        const response = projectMessage({id: '8207de5d-63de-4a9d-9cb1-d1ab98a28935', position: '2', kind: 'agent', status: 'queued', content: '', replyToId: source.id, sourceMessageId: source.id});
        const summary = projectMessage({id: '3971e7d4-60dc-41e9-9d6e-2665d326e37c', position: '3', kind: 'summary', status: 'queued', content: '', replyToId: source.id, sourceMessageId: source.id});
        const chat = await ready();
        vi.mocked(projectChatApi.send).mockResolvedValueOnce({message: source, messages: [source, response, summary], roomRevision: 2});
        const later = Array.from({length: 100}, (_, index) => projectMessage({id: 'later-' + index, position: String(index + 4)}));
        vi.mocked(projectChatApi.read).mockImplementation(async (_project, _signal, watch = []) => projectRoom({room: {...projectRoom().room, revision: 104},
            messages: [...[source, response, summary].filter(message => watch.includes(message.id)).map(message => ({...message, status: 'done' as const, content: message.kind === 'agent' ? 'Ответ по профилю' : message.kind === 'summary' ? 'Итог по стеку' : message.content})), ...later.slice(-50)], history: {hasMore: true, nextCursor: later[50].id}}));
        await chat.send({requestKey: 'question', prompt: 'Вопрос агенту', targetAgentIds: ['developer']}); await flush();
        expect(vi.mocked(projectChatApi.read).mock.calls[1][2]).toEqual([source.id, response.id, summary.id]);
        const value = render(); expect(value.detail?.messages.find(message => message.id === response.id)).toMatchObject({status: 'done', content: 'Ответ по профилю'});
        expect(value.detail?.messages.find(message => message.id === summary.id)).toMatchObject({status: 'done', content: 'Итог по стеку'});
        expect(value.detail?.messages.filter(message => message.id === source.id)).toHaveLength(1); expect(value.detail?.history.hasMore).toBe(true);
        await value.refresh(); expect(vi.mocked(projectChatApi.read).mock.calls[2][2]).toBeUndefined();
    });
    it('Короткий tail по байтовому бюджету не принимает старые watched-строки за overlap', async () => {
        const old = projectMessage({id: 'a5f9126c-767a-4db7-b9d7-82d3b908fc03', position: '1', status: 'running'});
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({messages: [old]})); const chat = await ready();
        const tail = Array.from({length: 3}, (_, index) => projectMessage({id: 'short-tail-' + index, position: String(index + 100)}));
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({room: {...projectRoom().room, revision: 103}, messages: [{...old, status: 'done'}, ...tail], history: {hasMore: true, nextCursor: tail[0].id}}));
        await chat.refresh(); expect(render().detail?.history).toEqual({hasMore: true, nextCursor: tail[0].id});
        expect(render().detail?.messages.find(message => message.id === old.id)?.status).toBe('done');
    });
    it('Поздний ACK открывает неизвестные слоты после свежего tail, не понижая уже завершённые ответы', async () => {
        const source = projectMessage({id: '00000000-0000-4000-8000-000000000001', position: '1', status: 'queued'});
        const slots = Array.from({length: 8}, (_, index) => projectMessage({id: '00000000-0000-4000-8000-' + String(index + 2).padStart(12, '0'), position: String(index + 2), kind: 'agent', content: '', status: 'queued', sourceMessageId: source.id, replyToId: source.id}));
        const summary = projectMessage({id: '00000000-0000-4000-8000-000000000010', position: '10', kind: 'summary', content: '', status: 'queued', sourceMessageId: source.id, replyToId: source.id});
        const receipt = deferred<ProjectChatReceipt>(), chat = await ready(); vi.mocked(projectChatApi.send).mockReturnValueOnce(receipt.promise);
        const sending = chat.send({requestKey: 'held-send', prompt: 'Отдельный вопрос', targetAgentIds: ['developer']});
        const terminal = [...slots.slice(4), summary].map(message => ({...message, status: 'done' as const, content: 'Свежий опубликованный результат'}));
        const later = Array.from({length: 45}, (_, index) => projectMessage({id: 'later-' + index, position: String(index + 11)})), tail = [...terminal, ...later];
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(projectRoom({room: {...projectRoom().room, revision: 100}, messages: tail, history: {hasMore: true, nextCursor: terminal[0].id}}));
        await chat.refresh(); expect(render().detail?.room.revision).toBe(100);
        const watched = deferred<ProjectChatDetail>(); vi.mocked(projectChatApi.read).mockReturnValueOnce(watched.promise);
        receipt.resolve({message: source, messages: [source, ...slots, summary], roomRevision: 5}); await sending;
        let current = render(); expect(current.detail?.room.revision).toBe(100);
        expect(current.detail?.messages.find(message => message.id === slots[0].id)?.status).toBe('queued');
        expect(current.detail?.messages.find(message => message.id === terminal[0].id)).toMatchObject({status: 'done', content: 'Свежий опубликованный результат'});
        const watch = vi.mocked(projectChatApi.read).mock.calls[2][2]; expect(watch).toEqual([source, ...slots.slice(0, 4)].map(message => message.id));
        watched.resolve(projectRoom({room: {...projectRoom().room, revision: 101}, messages: [...[source, ...slots.slice(0, 4)].map(message => ({...message, status: 'done', content: 'Результат наблюдаемого ответа'})), ...tail], history: {hasMore: true, nextCursor: terminal[0].id}}));
        await flush(); current = render(); expect(current.detail?.messages).toHaveLength(55);
        expect(current.detail?.messages.find(message => message.id === slots[0].id)).toMatchObject({status: 'done', content: 'Результат наблюдаемого ответа'});
        expect(current.detail?.room.revision).toBe(101);
    });
});
