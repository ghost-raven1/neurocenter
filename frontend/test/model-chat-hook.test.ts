import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useModelChat} from '../src/features/ModelChat/useModelChat';
import {modelChatApi} from '../src/features/ModelChat/api';
import {chatFileBase64} from '../src/features/ModelChat/files';
import type {IModelChatDetail} from '../src/features/ModelChat/types';
import {detail, model, participant, response, turn} from './model-chat-fixtures';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    return {
        begin: () => {cursor = 0;}, commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => {slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0;},
        state<T>(initial: T) {const slot = slots[cursor++] ??= {value: initial}; return [slot.value, (value: T) => {slot.value = value;}];},
        ref<T>(initial: T) {return (slots[cursor++] ??= {value: {current: initial}}).value;},
        effect(effect: () => void | (() => void), deps: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
            const slot: (typeof slots)[number] = slots[index] = {deps}; effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});
        },
    };
});
const owner = vi.hoisted(() => ({current: 'alice'}));
vi.mock('react', () => ({useState: hooks.state, useRef: hooks.ref, useEffect: hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {const selected = owner.current; return {scope: selected, captureOwner: () => () => selected === owner.current};}}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {list: vi.fn(), create: vi.fn(), read: vi.fn(), history: vi.fn(), rename: vi.fn(), remove: vi.fn(), send: vi.fn(), retry: vi.fn(), cancel: vi.fn(), deleteFailed: vi.fn(), upload: vi.fn(), removeAttachment: vi.fn(), participants: vi.fn(), complete: vi.fn()}}));
vi.mock('../src/features/ModelChat/files', async original => ({...await original<typeof import('../src/features/ModelChat/files')>(), chatFileBase64: vi.fn()}));
let selected = model, blocked = '', selection: Parameters<typeof useModelChat>[3];
const render = (commit = true) => {hooks.begin(); const result = useModelChat(selected, 'prj-one', blocked, selection); if (commit) hooks.commit(); return result;};
const flush = async () => {for (let index = 0; index < 30; index++) await Promise.resolve();};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;}); return {promise, resolve, reject};}
const ready = async () => {render(); await flush(); return render();};
beforeEach(() => {
    hooks.dispose(); vi.clearAllMocks(); selected = model; blocked = ''; selection = undefined; owner.current = 'alice';
    vi.mocked(modelChatApi.list).mockResolvedValue([]); vi.mocked(modelChatApi.create).mockResolvedValue(detail()); vi.mocked(modelChatApi.read).mockResolvedValue(detail());
    vi.mocked(modelChatApi.history).mockResolvedValue({turns: [], attachments: [], history: {hasMore: false, nextCursor: null}});
    vi.mocked(modelChatApi.send).mockImplementation(async (_saved, _model, requestId, prompt, attachmentIds) => detail({turns: [turn({requestId, prompt, attachmentIds})]}));
    vi.mocked(modelChatApi.retry).mockResolvedValue(detail({turns: [turn()]})); vi.mocked(modelChatApi.cancel).mockResolvedValue(detail({turns: [turn({status: 'cancelled', answer: undefined})]}));
    vi.mocked(modelChatApi.deleteFailed).mockResolvedValue(detail()); vi.mocked(modelChatApi.rename).mockResolvedValue(detail()); vi.mocked(modelChatApi.remove).mockResolvedValue({} as never);
    vi.mocked(chatFileBase64).mockResolvedValue('dGVzdA==');
    vi.mocked(modelChatApi.upload).mockResolvedValue(detail({attachments: [{id: 'file-1', name: 'doc.txt', bytes: 4, textBytes: 4, mediaType: 'text/plain', createdAt: ''}]}));
    vi.mocked(modelChatApi.removeAttachment).mockResolvedValue(detail());
});
afterEach(() => {hooks.dispose(); vi.useRealTimers();});

describe('Сохранённая история и безопасная отправка', () => {
    it('Открывает последний личный диалог и сохраняет его историю', async () => {
        vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn()]}));
        const chat = await ready(); expect(chat.turns).toHaveLength(1); expect(chat.detail?.conversation.id).toBe('chat-1'); expect(modelChatApi.list).toHaveBeenCalledWith(model.id, 'prj-one', expect.any(AbortSignal));
    });
    it('Сохраняет consent в optimistic, безопасном повторе и не переопределяет saved retry', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        let chat = await ready(); const research = {project: false, external: {assetId: 'exa', version: 2, manifest: 'a'.repeat(64)}};
        expect(chat.send('Исследуй', research)).toBe(true); await flush(); expect(render().turns[0].research).toEqual(research);
        expect(vi.mocked(modelChatApi.send).mock.calls[0][7]).toEqual(research);
        pending.reject(Error('network failed')); vi.mocked(modelChatApi.read).mockRejectedValueOnce(Error('offline')); await flush(); chat = render(); expect(chat.turns[0].research).toEqual(research);
        chat.retry(); await flush(); expect(vi.mocked(modelChatApi.send).mock.calls[1][7]).toEqual(research);
    });
    it('Создаёт диалог при первом сообщении и не запускает двойную синхронную отправку', async () => {
        const response = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(response.promise);
        let chat = await ready(); expect(chat.send('Вопрос')).toBe(true); expect(chat.send('Дубликат')).toBe(false); await flush();
        expect(modelChatApi.create).toHaveBeenCalledOnce(); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(render().busy).toBe(true);
        const request = vi.mocked(modelChatApi.send).mock.calls[0]; expect(request[3]).toBe('Вопрос'); expect(request[4]).toEqual([]);
        response.resolve(detail({turns: [turn({requestId: request[2]})]})); await flush(); chat = render(); expect(chat.turns).toHaveLength(1); expect(chat.turns[0].status).toBe('done');
    });
    it('Ошибка создания не теряет prompt и не выдаёт запрос за сохранённый', async () => {
        vi.mocked(modelChatApi.create).mockRejectedValueOnce(new Error('Нет доступа'));
        const chat = await ready(); chat.send('Не потерять'); await flush();
        expect(render().turns[0]).toMatchObject({prompt: 'Не потерять', status: 'failed', error: 'Нет доступа'}); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it('При неизвестном исходе повтор сохраняет requestId и не создаёт дубликат', async () => {
        vi.mocked(modelChatApi.send).mockRejectedValueOnce(new Error('Сеть')); const chat = await ready(); chat.send('Вопрос'); await flush();
        const first = vi.mocked(modelChatApi.send).mock.calls[0][2]; expect(render().turns[0].status).toBe('failed'); render().retry(); await flush();
        expect(vi.mocked(modelChatApi.send).mock.calls[1][2]).toBe(first); expect(render().turns).toHaveLength(1); expect(render().turns[0].status).toBe('done');
    });
    it('Если сервер успел сохранить результат при обрыве, подтягивает его без нового inference', async () => {
        vi.mocked(modelChatApi.send).mockImplementationOnce(async (_value, _model, requestId) => {vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({requestId})]})); throw new Error('Сеть');});
        (await ready()).send('Вопрос'); await flush(); expect(render().turns[0].status).toBe('done'); expect(modelChatApi.send).toHaveBeenCalledOnce();
    });
    it('Повтор сохранённой ошибки создаёт отдельную попытку, редактирование удаляет failed хвост', async () => {
        vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]); const failed = turn({status: 'failed', answer: undefined}); vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [failed]}));
        let chat = await ready(); expect(chat.send('Новый')).toBe(false); chat.retry(); await flush(); expect(modelChatApi.retry).toHaveBeenCalledOnce();
        vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [failed]})); await render().refresh(); chat = render();
        expect(await chat.editFailed()).toBe(failed.prompt); expect(modelChatApi.deleteFailed).toHaveBeenCalledOnce(); expect(render().turns).toEqual([]);
    });
    it('Пустое сообщение и changed pin блокируют inference, новый диалог принимает текущий pin', async () => {
        const chat = await ready(); expect(chat.send(' \n ')).toBe(false); expect(modelChatApi.send).not.toHaveBeenCalled();
        await chat.newChat(); selected = {...model, modelPin: 'd'.repeat(64)}; expect(render().blocked).toContain('начните новый'); expect(render().send('Новый')).toBe(false);
        vi.mocked(modelChatApi.create).mockResolvedValue(detail({conversation: {...detail().conversation, modelPin: selected.modelPin!}})); await render().newChat(); expect(render().blocked).toBe('');
    });
});

describe('Ранняя история и фазы автосжатия', () => {
    it('Потеря GET убирает устаревшее running, сохраняя историю и завершённые ответы', async () => {
        vi.useFakeTimers(); const saved = detail({turns: [turn({status: 'pending', answer: undefined, executionState: 'running', responses: [response({status: 'pending', executionState: 'running', answer: undefined}), response({id: 'complete', executionState: null})]})]});
        vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved); await ready();
        vi.mocked(modelChatApi.read).mockRejectedValueOnce(Error('Связь потеряна')); await vi.advanceTimersByTimeAsync(1000);
        const value = render(); expect(value.turns).toHaveLength(1); expect(value.turns[0].executionState).toBeUndefined(); expect(value.turns[0].responses?.[0].executionState).toBeUndefined(); expect(value.turns[0].responses?.[1].answer?.content).toBe('Ответ'); expect(value.error).toBe('');
    });
    it('Подгружает страницу один раз и сохраняет её после обновления хвоста', async () => {
        const tail = detail({turns: [turn({id: 'tail'})], history: {hasMore: true, nextCursor: 'tail'}});
        vi.mocked(modelChatApi.list).mockResolvedValue([tail.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(tail);
        vi.mocked(modelChatApi.history).mockResolvedValue({turns: [turn({id: 'old'})], attachments: [], history: {hasMore: false, nextCursor: null}});
        const chat = await ready(); const request = chat.loadEarlier(); void chat.loadEarlier(); await request;
        expect(modelChatApi.history).toHaveBeenCalledOnce(); expect(render().turns.map(value => value.id)).toEqual(['old', 'tail']);
        await render().refresh(); expect(render().turns.map(value => value.id)).toEqual(['old', 'tail']); expect(render().detail?.history.hasMore).toBe(false);
    });
    it('Сбой страницы оставляет историю и курсор; переход отменяет старую загрузку', async () => {
        const tail = detail({turns: [turn({id: 'tail'})], history: {hasMore: true, nextCursor: 'tail'}});
        vi.mocked(modelChatApi.list).mockResolvedValue([tail.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(tail);
        vi.mocked(modelChatApi.history).mockRejectedValueOnce(new Error('Сеть')); await (await ready()).loadEarlier();
        expect(render().historyError).toBe('Сеть'); expect(render().turns).toHaveLength(1); expect(render().detail?.history.nextCursor).toBe('tail');
        const pending = deferred<Awaited<ReturnType<typeof modelChatApi.history>>>(); vi.mocked(modelChatApi.history).mockReturnValueOnce(pending.promise); void render().loadEarlier();
        const signal = vi.mocked(modelChatApi.history).mock.calls[1][2]; vi.mocked(modelChatApi.read).mockResolvedValue(detail({conversation: {...detail().conversation, id: 'other'}})); await render().select('other');
        expect(signal.aborted).toBe(true); pending.resolve({turns: [turn({id: 'old'})], attachments: [], history: {hasMore: false, nextCursor: null}}); await flush(); expect(render().detail?.conversation.id).toBe('other'); expect(render().turns).toEqual([]);
    });
    it('Чтение старой страницы доступно во время генерации и не отменяет её HTTP', async () => {
        const tail = detail({turns: [turn({id: 'tail'})], history: {hasMore: true, nextCursor: 'tail'}});
        vi.mocked(modelChatApi.list).mockResolvedValue([tail.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(tail);
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        const chat = await ready(); chat.send('Новый вопрос'); await flush(); const signal = vi.mocked(modelChatApi.send).mock.calls[0][5];
        vi.mocked(modelChatApi.history).mockResolvedValue({turns: [turn({id: 'old'})], attachments: [], history: {hasMore: false, nextCursor: null}}); await render().loadEarlier();
        expect(signal.aborted).toBe(false); expect(render().turns.map(value => value.id).slice(0, 2)).toEqual(['old', 'tail']); expect(render().busy).toBe(true);
        pending.resolve(detail({turns: [turn({id: 'tail'}), turn({id: 'done'})]})); await flush(); expect(render().turns.map(value => value.id)).toEqual(['old', 'tail', 'done']);
    });
    it('Показывает фактическую фазу сжатия из GET, не создавая второго inference', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        const chat = await ready(); vi.useFakeTimers(); chat.send('Продолжай'); await flush(); render();
        const requestId = vi.mocked(modelChatApi.send).mock.calls[0][2];
        vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({requestId, status: 'pending', answer: undefined, processingStage: 'compacting'})], compaction: {state: 'compacting', coveredTurns: 0}}));
        await vi.advanceTimersByTimeAsync(1000); expect(render().turns[0].processingStage).toBe('compacting');
        vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({requestId, status: 'pending', answer: undefined, processingStage: 'responding'})], compaction: {state: 'ready', coveredTurns: 20}}));
        await vi.advanceTimersByTimeAsync(2000); expect(render().turns[0].processingStage).toBe('responding'); expect(modelChatApi.send).toHaveBeenCalledOnce();
        pending.resolve(detail({turns: [turn({requestId})]})); await flush(); expect(render().turns[0].status).toBe('done');
    });
});

describe('Группа: адресаты, частичные результаты и изменения состава', () => {
    const group = () => detail({conversation: {...detail().conversation, mode: 'group'}, participants: [participant(), participant({agentId: 'review', slug: 'nc-reviewer', name: 'Ревьюер'})]});
    const openGroup = async () => {const saved = group(); vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved); return ready();};
    it('Добавление участников превращает существующий чат в группу без копирования истории', async () => {
        const saved = detail({turns: [turn()]}); vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved); await ready();
        vi.mocked(modelChatApi.participants).mockResolvedValue({...group(), turns: saved.turns}); expect(await render().configureParticipants(['agent-dev'])).toBe(true);
        expect(render().detail?.conversation).toMatchObject({id: 'chat-1', mode: 'group'}); expect(render().turns).toEqual(saved.turns); expect(modelChatApi.create).not.toHaveBeenCalled();
    });
    it('Создаёт группу с явным составом, адресует @одному и без @ всем', async () => {
        await ready(); vi.mocked(modelChatApi.create).mockResolvedValue(group()); await render().newChat(['agent-dev', 'review']);
        expect(modelChatApi.create).toHaveBeenLastCalledWith(model, 'prj-one', expect.any(AbortSignal), ['agent-dev', 'review']);
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        expect(render().send('@nc-reviewer проверь')).toBe(true); await flush(); expect(vi.mocked(modelChatApi.send).mock.calls[0][6]).toEqual(['review']);
        expect(render().turns.at(-1)?.targetAgentIds).toEqual(['review']); pending.resolve(group()); await flush();
        render().send('Вопрос всем'); await flush(); expect(vi.mocked(modelChatApi.send).mock.calls[1][6]).toEqual([]);
    });
    it('Опечатка @ и недоступный default адресат не начинают HTTP; @активному допустим', async () => {
        await openGroup(); expect(render().send('@missing вопрос')).toBe(false); expect(render().error).toContain('не найден');
        const saved = group(); saved.participants![1].status = 'disabled'; vi.mocked(modelChatApi.read).mockResolvedValue(saved); await render().refresh();
        expect(render().send('Всем')).toBe(false); expect(modelChatApi.send).not.toHaveBeenCalled(); expect(render().send('@nc-developer')).toBe(true); await flush(); expect(vi.mocked(modelChatApi.send).mock.calls[0][6]).toEqual(['agent-dev']);
    });
    it('Поллинг показывает сохранённый ответ одного участника, пока другой ещё работает', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); await openGroup(); vi.useFakeTimers(); render().send('Всем'); await flush(); render();
        const requestId = vi.mocked(modelChatApi.send).mock.calls[0][2], responses = [response(), response({id: 'wait', agentId: 'review', name: 'Ревьюер', status: 'pending', answer: undefined})];
        const discussion = {mode: 'automatic' as const, callsStarted: 2, maxCalls: 5}; vi.mocked(modelChatApi.read).mockResolvedValue({...group(), turns: [turn({requestId, status: 'pending', answer: undefined, responses, discussion})]}); await vi.advanceTimersByTimeAsync(1000);
        expect(render().turns.at(-1)?.responses).toEqual(responses); expect(render().turns.at(-1)?.discussion).toEqual(discussion); expect(render().busy).toBe(true); expect(modelChatApi.send).toHaveBeenCalledOnce();
        pending.resolve({...group(), turns: [turn({requestId, responses: [responses[0], {...responses[1], status: 'done', answer: response().answer}]})]}); await flush(); expect(render().busy).toBe(false);
    });
    it('Ошибка CAS состава не очищает историю, успешное завершение partial round сохраняет её', async () => {
        await openGroup(); vi.mocked(modelChatApi.participants).mockRejectedValueOnce(new Error('Состав уже изменён'));
        expect(await render().configureParticipants(['agent-dev'])).toBe(false); expect(render().detail?.participants).toHaveLength(2); expect(render().error).toContain('Состав уже изменён');
        const partial = {...group(), turns: [turn({status: 'failed', answer: undefined, responses: [response()]})]}; vi.mocked(modelChatApi.read).mockResolvedValue(partial); await render().refresh();
        vi.mocked(modelChatApi.complete).mockResolvedValue({...partial, turns: [{...partial.turns[0], status: 'done'}]}); await render().complete();
        expect(modelChatApi.complete).toHaveBeenCalledWith(expect.objectContaining({conversation: partial.conversation}), 'turn-1', expect.any(AbortSignal)); expect(render().turns[0].responses?.[0].answer?.content).toBe('Ответ'); expect(render().turns[0].status).toBe('done');
    });
    it.each(['failed', 'cancelled'] as const)('Автообсуждение %s остаётся неизменной историей и разрешает следующую задачу', async status => {
        const previous = turn({status, answer: undefined, responses: [response()], discussion: {mode: 'automatic', callsStarted: 3, maxCalls: 5}}), saved = {...group(), turns: [previous]};
        vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved); let chat = await ready();
        chat.retry(); await chat.complete(); expect(await chat.editFailed()).toBeUndefined(); expect(modelChatApi.retry).not.toHaveBeenCalled(); expect(modelChatApi.complete).not.toHaveBeenCalled(); expect(modelChatApi.deleteFailed).not.toHaveBeenCalled();
        vi.mocked(modelChatApi.send).mockImplementationOnce(async (_detail, _model, requestId, prompt) => ({...saved, turns: [previous, turn({id: 'next', requestId, prompt})]}));
        expect(chat.send('Следующая задача')).toBe(true); await flush(); chat = render(); expect(chat.turns[0]).toEqual(previous); expect(chat.turns[1].prompt).toBe('Следующая задача'); expect(modelChatApi.send).toHaveBeenCalledOnce();
    });
    it('Незавершённое автообсуждение и ошибка прежней группы требуют завершения перед новой задачей', async () => {
        const saved = {...group(), turns: [turn({status: 'pending', answer: undefined, discussion: {mode: 'automatic' as const, callsStarted: 1, maxCalls: 5}})]};
        vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved); await ready(); expect(render().send('Слишком рано')).toBe(false);
        vi.mocked(modelChatApi.read).mockResolvedValue({...group(), turns: [turn({status: 'failed', answer: undefined})]}); await render().refresh(); expect(render().send('Прежняя ошибка')).toBe(false); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it('Позднее сохранение состава прежнего владельца не применяется', async () => {
        await openGroup(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.participants).mockReturnValueOnce(pending.promise); const operation = render().configureParticipants(['agent-dev']);
        owner.current = 'bob'; pending.resolve({...group(), participants: [participant()]}); expect(await operation).toBe(false); expect(render(false).detail?.participants).toHaveLength(2);
    });
    it('Неудачное создание группы сохраняет текущую историю и неотправленные файлы', async () => {
        await openGroup(); render().addFiles([new File(['not supported'], 'scan.png')]); expect(render().uploads).toHaveLength(1);
        vi.mocked(modelChatApi.create).mockRejectedValueOnce(new Error('Группа уже изменилась')); expect(await render().newChat(['agent-dev'])).toBe(false);
        expect(render().detail?.conversation.id).toBe('chat-1'); expect(render().uploads[0].name).toBe('scan.png');
    });
});

describe('Отмена, переключение и владелец', () => {
    it('Отмена останавливает HTTP и игнорирует поздний результат', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Вопрос'); await flush(); const call = vi.mocked(modelChatApi.send).mock.calls[0];
        vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({id: 'saved-turn', requestId: call[2], status: 'pending', answer: undefined})]}));
        await render().stop(); expect(call[5].aborted).toBe(true); expect(modelChatApi.cancel).toHaveBeenCalledOnce();
        pending.resolve(detail({turns: [turn({requestId: call[2]})]})); await flush(); expect(render().turns[0].status).toBe('cancelled');
    });
    it('Новый диалог освобождает прежний HTTP без серверной отмены и не принимает его поздний ответ', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); (await ready()).send('Вопрос'); await flush(); const sent = vi.mocked(modelChatApi.send).mock.calls[0];
        vi.mocked(modelChatApi.create).mockResolvedValueOnce(detail({conversation: {...detail().conversation, id: 'new-chat'}})); expect(await render().newChat()).toBe(true); expect(sent[5].aborted).toBe(true); expect(modelChatApi.cancel).not.toHaveBeenCalled();
        pending.resolve(detail({turns: [turn({requestId: sent[2]})]})); await flush(); expect(render().detail?.conversation.id).toBe('new-chat'); expect(render().turns).toEqual([]);
    });
    it('Если запрос завершился между чтением и Stop, принимает итог сервера вместо ложной отмены', async () => {
        vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [turn({status: 'pending', answer: undefined})]}));
        const chat = await ready(); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [turn({status: 'pending', answer: undefined})]})).mockResolvedValueOnce(detail({turns: [turn()]}));
        vi.mocked(modelChatApi.cancel).mockRejectedValueOnce(new Error('Запрос уже завершён')); await chat.stop(); expect(render().turns[0].status).toBe('done'); expect(render().error).toBe('');
    });
    it('Stop своей отправки A не отменяет новый B из другого окна после ожидания GET', async () => {
        const send = deferred<IModelChatDetail>(), read = deferred<IModelChatDetail>();
        vi.mocked(modelChatApi.send).mockReturnValueOnce(send.promise);
        (await ready()).send('Свой запрос A'); await flush();
        const call = vi.mocked(modelChatApi.send).mock.calls[0], requestId = call[2];
        vi.mocked(modelChatApi.read).mockReturnValueOnce(read.promise);
        const stopping = render().stop();
        expect(call[5].aborted).toBe(true); expect(modelChatApi.cancel).not.toHaveBeenCalled();
        const completed = turn({id: 'saved-a', requestId, prompt: 'Свой запрос A'});
        const next = turn({id: 'saved-b', requestId: 'other-window-b', prompt: 'Запрос другого окна', status: 'pending', answer: undefined});
        const saved = detail({turns: [completed, next]}); read.resolve(saved); await stopping;
        expect(modelChatApi.cancel).not.toHaveBeenCalled();
        expect(render().turns).toEqual(saved.turns); expect(render().busy).toBe(true); expect(render().error).toBe('');
        send.resolve(detail({turns: [completed]})); await flush();
        expect(render().turns).toEqual(saved.turns); expect(modelChatApi.send).toHaveBeenCalledOnce();
    });
    it('Stop сохранённого pending A не отменяет B, появившийся после завершения A', async () => {
        const pending = turn({id: 'saved-a', requestId: 'persisted-a', status: 'pending', answer: undefined});
        vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]);
        vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [pending]}));
        const chat = await ready(), read = deferred<IModelChatDetail>();
        vi.mocked(modelChatApi.read).mockReturnValueOnce(read.promise); const stopping = chat.stop();
        const saved = detail({turns: [{...pending, status: 'done', answer: turn().answer}, turn({id: 'saved-b', requestId: 'other-window-b', status: 'pending', answer: undefined})]});
        read.resolve(saved); await stopping;
        expect(modelChatApi.cancel).not.toHaveBeenCalled(); expect(render().turns).toEqual(saved.turns); expect(render().busy).toBe(true);
        expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it('Потерянный ACK своей отмены перечитывает A и сохраняет новый pending B без повторной отмены', async () => {
        const pending = turn({id: 'saved-a', requestId: 'persisted-a', status: 'pending', answer: undefined});
        const initial = detail({turns: [pending]});
        vi.mocked(modelChatApi.list).mockResolvedValue([initial.conversation]); vi.mocked(modelChatApi.read).mockResolvedValueOnce(initial);
        const chat = await ready();
        const saved = detail({turns: [{...pending, status: 'cancelled'}, turn({id: 'saved-b', requestId: 'other-window-b', status: 'pending', answer: undefined})]});
        vi.mocked(modelChatApi.read).mockResolvedValueOnce(initial).mockResolvedValueOnce(saved);
        vi.mocked(modelChatApi.cancel).mockRejectedValueOnce(new Error('Cancellation ACK lost'));
        await chat.stop();
        expect(modelChatApi.cancel).toHaveBeenCalledExactlyOnceWith(initial, 'saved-a', expect.any(AbortSignal));
        expect(modelChatApi.read).toHaveBeenCalledTimes(3); expect(render().turns).toEqual(saved.turns); expect(render().busy).toBe(true); expect(render().error).toBe('');
    });
    it('Смена диалога отсоединяет прежний HTTP без отмены и не подмешивает его ответ', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Вопрос'); await flush(); const other = detail({conversation: {...detail().conversation, id: 'chat-2'}}); vi.mocked(modelChatApi.read).mockResolvedValue(other);
        await render().select('chat-2'); expect(modelChatApi.cancel).not.toHaveBeenCalled(); pending.resolve(detail({turns: [turn()]})); await flush(); expect(render().detail?.conversation.id).toBe('chat-2'); expect(render().turns).toEqual([]);
    });
    it('Смена owner до render не принимает поздний ответ', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Личный вопрос'); await flush(); owner.current = 'bob'; pending.resolve(detail({turns: [turn()]})); await flush(); expect(render(false).turns.some(value => value.answer)).toBe(false);
    });
    it('Unmount освобождает HTTP без серверной отмены и не принимает поздний ответ', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Вопрос'); await flush(); const signal = vi.mocked(modelChatApi.send).mock.calls[0][5]; hooks.dispose(); expect(signal.aborted).toBe(true); expect(modelChatApi.cancel).not.toHaveBeenCalled(); pending.resolve(detail({turns: [turn()]})); await flush();
    });
    it('Поздняя операция прежнего владельца не меняет диалог и не запускает запрос', async () => {
        const chat = await ready(); owner.current = 'bob'; expect(chat.send('Вопрос')).toBe(false); await chat.newChat(); await chat.select('other'); await chat.stop();
        expect(modelChatApi.create).not.toHaveBeenCalled(); expect(modelChatApi.read).not.toHaveBeenCalled();
    });
    it('Смена технического pin до effect не принимает результат в старый контекст', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Вопрос'); await flush(); selected = {...model, modelPin: 'd'.repeat(64)}; render(false);
        pending.resolve(detail({turns: [turn()]})); await flush(); expect(render().turns.some(value => value.answer?.content === 'Ответ')).toBe(false);
    });
});

describe('Документы и сохранённые вложения', () => {
    it('Загружает файл один раз и отправляет только его серверный ID без обязательного prompt', async () => {
        const chat = await ready(); chat.addFiles([new File(['test'], 'doc.txt')]); await flush(); expect(modelChatApi.upload).toHaveBeenCalledOnce();
        expect(render().attachments.map(file => file.id)).toEqual(['file-1']); expect(render().send('')).toBe(true); await flush();
        expect(vi.mocked(modelChatApi.send).mock.calls[0][4]).toEqual(['file-1']); expect(render().attachments).toEqual([]);
    });
    it('Показывает ошибку изображения и не начинает upload; ограничивает пачку пятью файлами', async () => {
        let chat = await ready(); chat.addFiles([new File(['test'], 'scan.png')]); await flush(); expect(render().uploads[0].error).toContain('OCR'); expect(modelChatApi.upload).not.toHaveBeenCalled();
        render().removeUpload(render().uploads[0].id); chat = render(); chat.addFiles(Array.from({length: 6}, (_, index) => new File(['x'], `${index}.txt`))); expect(render().error).toContain('пяти');
    });
    it('Частичная ошибка сохраняет готовый файл, retry не меняет ключ загрузки', async () => {
        vi.mocked(modelChatApi.upload).mockRejectedValueOnce(new Error('Ошибка чтения'));
        (await ready()).addFiles([new File(['test'], 'one.txt'), new File(['test'], 'two.txt')]); await flush();
        expect(render().attachments).toHaveLength(1); expect(render().uploads).toHaveLength(1); const requestId = render().uploads[0].id;
        render().retryUpload(requestId); await flush(); expect(vi.mocked(modelChatApi.upload).mock.calls[2][3]).toBe(requestId); expect(render().uploads).toEqual([]);
    });
    it('Отмена обработки сохраняет возможность повторить и не принимает поздний upload', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.upload).mockReturnValueOnce(pending.promise);
        (await ready()).addFiles([new File(['test'], 'doc.txt')]); await flush(); const signal = vi.mocked(modelChatApi.upload).mock.calls[0][4]; render().cancelUploads();
        expect(signal.aborted).toBe(true); expect(render().uploads[0].state).toBe('failed'); pending.resolve(detail({attachments: [{id: 'file-1', name: 'doc.txt', bytes: 4, textBytes: 4, mediaType: 'text/plain', createdAt: ''}]})); await flush(); expect(render().attachments).toEqual([]);
    });
    it.each(['select', 'newChat'] as const)('Ошибка %s при чтении файла сохраняет его для повтора и игнорирует позднее чтение', async action => {
        const reading = deferred<string>(); vi.mocked(chatFileBase64).mockReturnValueOnce(reading.promise); (await ready()).addFiles([new File(['test'], 'doc.txt')]); await flush(); const row = render().uploads[0], signal = vi.mocked(chatFileBase64).mock.calls[0][1];
        if (action === 'select') vi.mocked(modelChatApi.read).mockRejectedValueOnce(Error('Диалог недоступен')); else vi.mocked(modelChatApi.create).mockRejectedValueOnce(Error('Диалог недоступен'));
        expect(await (action === 'select' ? render().select('other') : render().newChat())).toBe(false); expect(signal.aborted).toBe(true); expect(render().uploads[0]).toMatchObject({id: row.id, name: 'doc.txt', state: 'failed'});
        reading.resolve('dGVzdA=='); await flush(); expect(modelChatApi.upload).not.toHaveBeenCalled(); expect(render().uploads[0].state).toBe('failed'); render().retryUpload(row.id); await flush();
        expect(modelChatApi.upload).toHaveBeenCalledOnce(); expect(vi.mocked(modelChatApi.upload).mock.calls[0][3]).toBe(row.id); expect(render().uploads).toEqual([]);
    });
});


describe('Дополнительные action races: сохранение, восстановление и приватность', () => {
    const open = async (saved = detail({turns: [turn()]})) => {
        vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved); return ready();
    };
    it('Начальная detail из общего overlay не требует повторного открытия последней модели', async () => {
        const saved = detail({turns: [turn()]}); selection = {initialDetail: saved, autoSelect: false}; vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]);
        expect(render(false).detail).toEqual(saved); await ready(); expect(render().turns).toEqual(saved.turns); expect(modelChatApi.read).not.toHaveBeenCalled();
    });
    it('Ошибка initial list явная; отменённый initial list не затирает уже выбранный диалог', async () => {
        vi.mocked(modelChatApi.list).mockRejectedValueOnce(new Error('Список недоступен')); await ready(); expect(render().error).toBe('Список недоступен');
        hooks.dispose(); const pending = deferred<ReturnType<typeof detail>['conversation'][]>(); vi.mocked(modelChatApi.list).mockReturnValueOnce(pending.promise); render();
        const signal = vi.mocked(modelChatApi.list).mock.calls.at(-1)![2], other = detail({conversation: {...detail().conversation, id: 'selected'}}); vi.mocked(modelChatApi.read).mockResolvedValueOnce(other);
        await render().select('selected'); pending.resolve([detail().conversation]); await flush(); expect(signal.aborted).toBe(true); expect(render().detail?.conversation.id).toBe('selected');
    });
    it('Переименование использует актуальную revision и сохраняет историю, ошибка не выдаёт успех', async () => {
        const chat = await open(), renamed = detail({conversation: {...detail().conversation, revision: 9, title: 'Исследование'}, turns: [turn()]});
        vi.mocked(modelChatApi.rename).mockResolvedValueOnce(renamed); expect(await chat.rename('Исследование')).toBe(true); expect(modelChatApi.rename).toHaveBeenCalledWith('chat-1', 1, 'Исследование', expect.any(AbortSignal)); expect(render().detail?.conversation.title).toBe('Исследование'); expect(render().turns).toEqual(renamed.turns);
        vi.mocked(modelChatApi.rename).mockRejectedValueOnce(new Error('Название уже изменено')); expect(await render().rename('Другое')).toBe(false); expect(render().detail?.conversation.title).toBe('Исследование'); expect(render().error).toBe('Название уже изменено');
    });
    it('Позднее rename/remove/attachment прежнего владельца не применяется', async () => {
        await open(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.rename).mockReturnValueOnce(pending.promise); const saved = render().detail, request = render().rename('Чужое'); owner.current = 'bob'; pending.resolve(detail({conversation: {...detail().conversation, title: 'PRIVATE CHANGE'}})); expect(await request).toBe(false); expect(render(false).detail).toEqual(saved);
    });
    it('Удаление очищает только текущий диалог и draft documents, прежние items остаются', async () => {
        const other = {...detail().conversation, id: 'another'}; vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation, other]); await ready();
        render().addFiles([new File(['bad'], 'bad.png')]); expect(render().uploads).toHaveLength(1); expect(await render().remove()).toBe(true); expect(render().detail).toBeNull(); expect(render().turns).toEqual([]); expect(render().uploads).toEqual([]); expect(render().items.map(item => item.id)).toEqual(['another']); expect(modelChatApi.remove).toHaveBeenCalledWith('chat-1', 1, expect.any(AbortSignal));
    });
    it('Неудачное и позднее удаление сохраняют личные сообщения', async () => {
        const chat = await open(); vi.mocked(modelChatApi.remove).mockRejectedValueOnce(new Error('Revision changed')); expect(await chat.remove()).toBe(false); expect(render().turns).toHaveLength(1);
        const pending = deferred<Awaited<ReturnType<typeof modelChatApi.remove>>>(); vi.mocked(modelChatApi.remove).mockReturnValueOnce(pending.promise); const operation = render().remove(); owner.current = 'bob'; pending.resolve({} as never); expect(await operation).toBe(false); expect(render(false).detail?.conversation.id).toBe('chat-1');
    });
    it('Нет выбранного диалога: rename, remove, complete, attachment cleanup не создают его скрыто', async () => {
        const chat = await ready(); expect(await chat.remove()).toBe(false); await chat.rename('No chat'); await chat.configureParticipants(['agent']); await chat.removeAttachment('file'); await chat.complete(); expect(await chat.editFailed()).toBeUndefined(); chat.retry(); chat.cancelUploads();
        expect(modelChatApi.create).not.toHaveBeenCalled(); expect(modelChatApi.rename).not.toHaveBeenCalled(); expect(modelChatApi.participants).not.toHaveBeenCalled(); expect(modelChatApi.removeAttachment).not.toHaveBeenCalled(); expect(modelChatApi.complete).not.toHaveBeenCalled();
    });
    it('Удаление неиспользованного документа принимает серверную истину, ошибка сохраняет preview', async () => {
        const file = {id: 'unused', name: 'unused.txt', bytes: 4, textBytes: 4, mediaType: 'text/plain', createdAt: ''}; await open(detail({attachments: [file]}));
        vi.mocked(modelChatApi.removeAttachment).mockRejectedValueOnce(new Error('Документ уже использован')); await render().removeAttachment(file.id); expect(render().attachments).toEqual([file]); expect(render().error).toBe('Документ уже использован');
        vi.mocked(modelChatApi.removeAttachment).mockResolvedValueOnce(detail()); await render().removeAttachment(file.id); expect(render().attachments).toEqual([]); expect(modelChatApi.removeAttachment).toHaveBeenLastCalledWith(expect.objectContaining({attachments: [file]}), file.id, expect.any(AbortSignal));
    });
    it('Поздний document cleanup не изменяет новый диалог после переключения', async () => {
        await open(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.removeAttachment).mockReturnValueOnce(pending.promise); const operation = render().removeAttachment('file'); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({conversation: {...detail().conversation, id: 'other'}})); await render().select('other'); pending.resolve(detail()); await operation; expect(render().detail?.conversation.id).toBe('other');
    });
    it('Refresh восстанавливает сохранённый результат неизвестной отправки, не повторяет inference', async () => {
        await ready(); vi.mocked(modelChatApi.send).mockRejectedValueOnce(new Error('Connection lost')); render().send('Не дублировать'); await flush(); const id = vi.mocked(modelChatApi.send).mock.calls[0][2]; expect(render().turns[0].status).toBe('failed');
        vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [turn({requestId: id})]})); await render().refresh(); expect(render().turns[0].status).toBe('done'); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(modelChatApi.retry).not.toHaveBeenCalled();
    });
    it('Поздний refresh list и его detail не переключают выбранный диалог', async () => {
        await open(); const pending = deferred<ReturnType<typeof detail>['conversation'][]>(); vi.mocked(modelChatApi.list).mockReturnValueOnce(pending.promise); const refresh = render().refresh(); const signal = vi.mocked(modelChatApi.list).mock.calls.at(-1)![2];
        vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({conversation: {...detail().conversation, id: 'other'}})); await render().select('other'); pending.resolve([detail().conversation]); await refresh; expect(signal.aborted).toBe(true); expect(render().detail?.conversation.id).toBe('other');
        const read = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(read.promise); const next = render().refresh(); await flush(); owner.current = 'bob'; read.resolve(detail()); await next; expect(render(false).detail?.conversation.id).toBe('other');
    });
    it('При отмене до создания диалога не отправляет сообщение после позднего create', async () => {
        await ready(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.create).mockReturnValueOnce(pending.promise); render().send('Сохранить текст'); await flush(); const signal = vi.mocked(modelChatApi.create).mock.calls[0][2]; await render().stop(); pending.resolve(detail()); await flush(); expect(signal.aborted).toBe(true); expect(modelChatApi.send).not.toHaveBeenCalled(); expect(modelChatApi.cancel).not.toHaveBeenCalled(); expect(render().turns[0]).toMatchObject({status: 'cancelled', prompt: 'Сохранить текст'});
    });
    it('Ошибка нового диалога перечитывает принятый запрос и продолжает GET без отмены или повтора', async () => {
        vi.useFakeTimers(); await ready(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); render().send('Не потерять'); await flush(); const sent = vi.mocked(modelChatApi.send).mock.calls[0];
        const accepted = turn({requestId: sent[2], prompt: sent[3], status: 'pending', answer: undefined}); vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [accepted]})); vi.mocked(modelChatApi.create).mockRejectedValueOnce(new Error('Create unavailable'));
        expect(await render().newChat()).toBe(false); expect(sent[5].aborted).toBe(true); expect(render().turns).toEqual([accepted]); pending.reject(new Error('Aborted old request')); await flush(); expect(render().error).toBe('Create unavailable');
        vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [{...accepted, status: 'done', answer: turn().answer}]})); await vi.advanceTimersByTimeAsync(1000); await flush();
        expect(render().turns[0].status).toBe('done'); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(modelChatApi.cancel).not.toHaveBeenCalled(); expect(modelChatApi.retry).not.toHaveBeenCalled();
    });
    it('Неподтверждённый исход после ошибки нового диалога сохраняет исходный requestId для явного безопасного повтора', async () => {
        await ready(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); render().send('Не дублировать'); await flush(); const sent = vi.mocked(modelChatApi.send).mock.calls[0]; vi.mocked(modelChatApi.create).mockRejectedValueOnce(new Error('Create unavailable'));
        expect(await render().newChat()).toBe(false); expect(render().turns[0]).toMatchObject({requestId: sent[2], status: 'failed', prompt: 'Не дублировать', error: 'Результат запроса не подтверждён. Можно безопасно повторить запрос.'}); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(modelChatApi.cancel).not.toHaveBeenCalled();
        pending.reject(new Error('Aborted old request')); await flush(); expect(render().error).toBe('Create unavailable'); render().retry(); await flush();
        expect(vi.mocked(modelChatApi.send).mock.calls[1][2]).toBe(sent[2]); expect(modelChatApi.send).toHaveBeenCalledTimes(2); expect(modelChatApi.retry).not.toHaveBeenCalled();
    });
    it('Изменение pin пока создаётся диалог не начинает inference с прежним ожиданием', async () => {
        await ready(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.create).mockReturnValueOnce(pending.promise); render().send('Вопрос'); await flush(); selected = {...model, modelPin: 'd'.repeat(64)}; render(false); pending.resolve(detail()); await flush(); expect(modelChatApi.send).not.toHaveBeenCalled(); expect(render().blocked).toContain('изменилось'); expect(render().turns[0].status).toBe('failed');
    });
    it('Stop с конфликтом и всё ещё pending не изображает успешную отмену', async () => {
        const saved = detail({turns: [turn({status: 'pending', answer: undefined})]}); await open(saved); vi.mocked(modelChatApi.cancel).mockRejectedValueOnce(new Error('Сервис отмены недоступен')); await render().stop(); expect(render().turns[0].status).toBe('pending'); expect(render().error).toBe('Сервис отмены недоступен');
    });
    it('Поздний Stop read/cancel прежнего владельца не применяет результат и не запускает fallback', async () => {
        await open(detail({turns: [turn({status: 'pending', answer: undefined})]})); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.cancel).mockReturnValueOnce(pending.promise); const operation = render().stop(); await flush(); const count = vi.mocked(modelChatApi.read).mock.calls.length; owner.current = 'bob'; pending.reject(new Error('PRIVATE stop error')); await operation; expect(modelChatApi.read).toHaveBeenCalledTimes(count); expect(render(false).error).toBe('');
    });
    it('Редактирование несохранённого failed prompt не удаляет чужие/server сообщения', async () => {
        await ready(); vi.mocked(modelChatApi.create).mockRejectedValueOnce(new Error('Offline')); render().send('Верни в редактор'); await flush(); expect(await render().editFailed()).toBe('Верни в редактор'); expect(modelChatApi.deleteFailed).not.toHaveBeenCalled(); expect(render().turns).toEqual([]);
    });
    it('Failed tail уже удалён в другой вкладке: edit восстанавливает текст без повторного DELETE', async () => {
        await open(detail({turns: [turn({status: 'failed', answer: undefined})]})); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail()); expect(await render().editFailed()).toBe('Вопрос'); expect(modelChatApi.deleteFailed).not.toHaveBeenCalled(); expect(render().turns).toEqual([]);
    });
    it('Групповой retry сохраняет полученные ответы, прежних адресатов и research consent', async () => {
        const research = {project: true}, saved = detail({conversation: {...detail().conversation, mode: 'group'}, participants: [participant()], turns: [turn({status: 'failed', answer: undefined, targetAgentIds: ['agent-dev'], research, responses: [response(), response({id: 'failed', status: 'failed', answer: undefined})]})]}); await open(saved);
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.retry).mockReturnValueOnce(pending.promise); render().retry(); await flush(); expect(render().turns[0].responses?.[0].answer).toEqual(saved.turns[0].responses?.[0].answer); expect(render().turns[0].targetAgentIds).toEqual(['agent-dev']); expect(render().turns[0].research).toEqual(research); expect(modelChatApi.send).not.toHaveBeenCalled(); expect(modelChatApi.retry).toHaveBeenCalledWith(expect.anything(), model, saved.turns[0].id, expect.any(String), expect.any(AbortSignal)); pending.resolve({...saved, turns: [{...saved.turns[0], status: 'done'}]}); await flush();
    });
    it('Загрузка после отменённого ensure не читает File и не выполняет upload', async () => {
        await ready(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.create).mockReturnValueOnce(pending.promise); render().addFiles([new File(['x'], 'a.txt')]); await flush(); render().cancelUploads(); pending.resolve(detail()); await flush(); expect(chatFileBase64).not.toHaveBeenCalled(); expect(modelChatApi.upload).not.toHaveBeenCalled(); expect(render().uploads[0].error).toContain('отменена');
    });
    it.each(['resolve', 'reject'] as const)('Позднее %s FileReader после отмены не возобновляет upload', async outcome => {
        await open(detail()); const pending = deferred<string>(); vi.mocked(chatFileBase64).mockReturnValueOnce(pending.promise); render().addFiles([new File(['x'], 'a.txt')]); await flush(); render().cancelUploads(); if (outcome === 'resolve') pending.resolve('eA=='); else pending.reject(new Error('Late decode failure')); await flush(); expect(modelChatApi.upload).not.toHaveBeenCalled(); expect(render().uploads[0].error).toContain('отменена');
    });
    it('Смена владельца в первой загрузке прекращает всю пачку, не запускает второй документ', async () => {
        await open(detail()); vi.mocked(modelChatApi.upload).mockImplementationOnce(async () => {owner.current = 'bob'; return detail();}); render().addFiles([new File(['x'], 'a.txt'), new File(['y'], 'b.txt')]); await flush(); expect(modelChatApi.upload).toHaveBeenCalledOnce(); expect(render(false).attachments).toEqual([]);
    });
    it('Сбой FileReader сохраняет failed row, следующая валидная запись может загрузиться', async () => {
        vi.mocked(chatFileBase64).mockRejectedValueOnce(new Error('Документ повреждён')); (await ready()).addFiles([new File(['x'], 'a.txt'), new File(['y'], 'b.txt')]); await flush(); expect(modelChatApi.upload).toHaveBeenCalledOnce(); expect(render().uploads).toHaveLength(1); expect(render().uploads[0].error).toBe('Документ повреждён');
    });
    it('Активную загрузку нельзя удалить или повторить вторым HTTP; смешанная отмена сохраняет исходную ошибку', async () => {
        await ready(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.upload).mockReturnValueOnce(pending.promise); render().addFiles([new File(['x'], 'scan.png'), new File(['y'], 'b.txt')]); await flush(); let chat = render(); const invalid = chat.uploads.find(item => item.name === 'scan.png')!, valid = chat.uploads.find(item => item.name === 'b.txt')!;
        chat.removeUpload(valid.id); chat.retryUpload(valid.id); expect(render().uploads).toHaveLength(2); expect(modelChatApi.upload).toHaveBeenCalledOnce(); chat.cancelUploads(); chat = render(); expect(chat.uploads.find(item => item.id === invalid.id)?.error).toContain('OCR'); expect(chat.uploads.find(item => item.id === valid.id)?.error).toContain('отменена'); pending.reject(new Error('Cancelled')); await flush();
    });
    it('Recovery действия без owner/после unmount не начинают новых запросов', async () => {
        const chat = await open(); hooks.dispose(); expect(await chat.rename('Late')).toBe(false); expect(await chat.configureParticipants(['agent'])).toBe(false); expect(await chat.remove()).toBe(false); await chat.removeAttachment('file'); await chat.stop();
        expect(modelChatApi.rename).not.toHaveBeenCalled(); expect(modelChatApi.remove).not.toHaveBeenCalled(); expect(modelChatApi.participants).not.toHaveBeenCalled(); expect(modelChatApi.removeAttachment).not.toHaveBeenCalled();
    });
});

describe('Фоновый pending другой вкладки и поллинг', () => {
    const openPending = async () => {const saved = detail({turns: [turn({status: 'pending', answer: undefined})]}); vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved); vi.useFakeTimers(); return ready();};
    it('Завершение чужого запроса обновляет историю и прекращает polling без повторного inference', async () => {
        await openPending(); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [turn()]})); await vi.advanceTimersByTimeAsync(1000); expect(render().turns[0].status).toBe('done'); const count = vi.mocked(modelChatApi.read).mock.calls.length; await vi.advanceTimersByTimeAsync(6000); expect(modelChatApi.read).toHaveBeenCalledTimes(count); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it.each([401, 403, 404])('Отказ доступа %i прекращает polling и сохраняет точную причину', async status => {
        await openPending(); vi.mocked(modelChatApi.read).mockRejectedValueOnce({isAxiosError: true, response: {status, data: {message: 'Диалог больше недоступен'}}}); await vi.advanceTimersByTimeAsync(1000); expect(render().error).toBe('Диалог больше недоступен'); const count = vi.mocked(modelChatApi.read).mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(modelChatApi.read).toHaveBeenCalledTimes(count);
    });
    it.each([new Error('Temporary transport failure'), null])('Временный сбой %j допускает следующий read, но никогда не повторяет отправку', async cause => {
        await openPending(); vi.mocked(modelChatApi.read).mockRejectedValueOnce(cause); await vi.advanceTimersByTimeAsync(1000); expect(render().error).toBe(''); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [turn()]})); await vi.advanceTimersByTimeAsync(2000); expect(render().turns[0].status).toBe('done'); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it('Поздний polling результат и ошибка после перехода не меняют другой диалог', async () => {
        await openPending(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(pending.promise); await vi.advanceTimersByTimeAsync(1000); const signal = vi.mocked(modelChatApi.read).mock.calls.at(-1)![1]; vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({conversation: {...detail().conversation, id: 'other'}})); await render().select('other'); render(); expect(signal.aborted).toBe(true); pending.reject(new Error('Old pending failed')); await flush(); expect(render().detail?.conversation.id).toBe('other'); expect(render().error).toBe('');
    });
    it('Polling дополняет optimistic реальным ID и research traces, не создаёт повторный send', async () => {
        const chat = await ready(); vi.useFakeTimers(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); chat.send('Исследовать', {project: true}); await flush(); render(); const requestId = vi.mocked(modelChatApi.send).mock.calls[0][2];
        const steps = [{id: 'step', conversationId: 'chat-1', turnId: 'real-turn', responseId: null, requestId, attempt: 1, sequence: 1, kind: 'project_read' as const, status: 'pending' as const, error: null, outputBytes: 0, createdAt: '', updatedAt: ''}];
        vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [turn({id: 'real-turn', requestId, status: 'pending', answer: undefined, processingStage: 'researching', research: {project: true}, researchSteps: steps})]})); await vi.advanceTimersByTimeAsync(1000); expect(render().turns[0]).toMatchObject({id: 'real-turn', processingStage: 'researching', researchSteps: steps}); expect(modelChatApi.send).toHaveBeenCalledOnce(); pending.resolve(detail({turns: [turn({id: 'real-turn', requestId})]})); await flush();
    });
});

describe('Короткие owner и pin окна между await и commit', () => {
    it('Поздний успешный poll после перехода не возвращает прежний диалог', async () => {
        vi.useFakeTimers(); vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({status: 'pending', answer: undefined})]})); await ready();
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(pending.promise); await vi.advanceTimersByTimeAsync(1000);
        vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({conversation: {...detail().conversation, id: 'other'}})); await render().select('other'); render(); pending.resolve(detail({turns: [turn()]})); await flush(); expect(render().detail?.conversation.id).toBe('other'); expect(render().turns).toEqual([]);
    });
    it('Recovery GET после ошибки send не раскрывает поздний ответ следующему owner', async () => {
        await ready(); const recovery = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockRejectedValueOnce(new Error('Network lost')); vi.mocked(modelChatApi.read).mockReturnValueOnce(recovery.promise); render().send('Вопрос'); await flush(); owner.current = 'bob'; recovery.resolve(detail({turns: [turn({answer: {...turn().answer!, content: 'PRIVATE LATE ANSWER'}})]})); await flush(); expect(render(false).turns.some(value => value.answer?.content.includes('PRIVATE'))).toBe(false);
    });
    it('Stop GET и edit GET предыдущего owner не выполняют cancel/delete по позднему результату', async () => {
        vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({status: 'pending', answer: undefined})]})); await ready(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(pending.promise); const stop = render().stop(); owner.current = 'bob'; pending.resolve(detail({turns: [turn({status: 'pending', answer: undefined})]})); await stop; expect(modelChatApi.cancel).not.toHaveBeenCalled();
        hooks.dispose(); owner.current = 'alice'; vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({status: 'failed', answer: undefined})]})); await ready(); const editRead = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(editRead.promise); const edit = render().editFailed(); owner.current = 'bob'; editRead.resolve(detail({turns: [turn({status: 'failed', answer: undefined})]})); expect(await edit).toBeUndefined(); expect(modelChatApi.deleteFailed).not.toHaveBeenCalled();
    });
    it('Изменение pin в committed render останавливает own request и сохраняет серверную отмену', async () => {
        await ready(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); render().send('Вопрос'); await flush(); const call = vi.mocked(modelChatApi.send).mock.calls[0];
        const cancelled = detail({turns: [turn({id: 'saved-turn', requestId: call[2], status: 'cancelled', answer: undefined})]}); vi.mocked(modelChatApi.read).mockResolvedValueOnce({...cancelled, turns: [{...cancelled.turns[0], status: 'pending'}]}); vi.mocked(modelChatApi.cancel).mockResolvedValueOnce(cancelled); selected = {...model, modelPin: 'd'.repeat(64)}; render(); await flush(); expect(call[5].aborted).toBe(true); expect(modelChatApi.cancel).toHaveBeenCalledOnce(); expect(render().turns.every(value => value.status !== 'pending')).toBe(true); pending.resolve(detail({turns: [turn()]})); await flush();
    });
    it('Пустой список файлов, blocker и старый owner не добавляют локальную очередь', async () => {
        const chat = await ready(); chat.addFiles([]); expect(render().uploads).toEqual([]); blocked = 'Доступ отозван'; render().addFiles([new File(['x'], 'a.txt')]); expect(render().uploads).toEqual([]); blocked = ''; const previous = render(); owner.current = 'bob'; previous.addFiles([new File(['x'], 'a.txt')]); expect(render(false).uploads).toEqual([]); expect(modelChatApi.upload).not.toHaveBeenCalled();
    });
});
