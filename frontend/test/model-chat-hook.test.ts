import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useModelChat} from '../src/features/ModelChat/useModelChat';
import {modelChatApi} from '../src/features/ModelChat/api';
import {chatFileBase64} from '../src/features/ModelChat/files';
import type {IModelChatDetail} from '../src/features/ModelChat/types';
import {detail, model, turn} from './model-chat-fixtures';

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
            const slot = slots[index] = {deps}; effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});
        },
    };
});
const owner = vi.hoisted(() => ({current: 'alice'}));
vi.mock('react', () => ({useState: hooks.state, useRef: hooks.ref, useEffect: hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {const selected = owner.current; return {scope: selected, captureOwner: () => () => selected === owner.current};}}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {list: vi.fn(), create: vi.fn(), read: vi.fn(), rename: vi.fn(), remove: vi.fn(), send: vi.fn(), retry: vi.fn(), cancel: vi.fn(), deleteFailed: vi.fn(), upload: vi.fn(), removeAttachment: vi.fn()}}));
vi.mock('../src/features/ModelChat/files', async original => ({...await original<typeof import('../src/features/ModelChat/files')>(), chatFileBase64: vi.fn()}));
let selected = model, blocked = '';
const render = (commit = true) => {hooks.begin(); const result = useModelChat(selected, 'prj-one', blocked); if (commit) hooks.commit(); return result;};
const flush = async () => {for (let index = 0; index < 30; index++) await Promise.resolve();};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;}); return {promise, resolve, reject};}
const ready = async () => {render(); await flush(); return render();};
beforeEach(() => {
    hooks.dispose(); vi.clearAllMocks(); selected = model; blocked = ''; owner.current = 'alice';
    vi.mocked(modelChatApi.list).mockResolvedValue([]); vi.mocked(modelChatApi.create).mockResolvedValue(detail()); vi.mocked(modelChatApi.read).mockResolvedValue(detail());
    vi.mocked(modelChatApi.send).mockImplementation(async (_saved, _model, requestId, prompt, attachmentIds) => detail({turns: [turn({requestId, prompt, attachmentIds})]}));
    vi.mocked(modelChatApi.retry).mockResolvedValue(detail({turns: [turn()]})); vi.mocked(modelChatApi.cancel).mockResolvedValue(detail({turns: [turn({status: 'cancelled', answer: undefined})]}));
    vi.mocked(modelChatApi.deleteFailed).mockResolvedValue(detail()); vi.mocked(modelChatApi.rename).mockResolvedValue(detail()); vi.mocked(modelChatApi.remove).mockResolvedValue({} as never);
    vi.mocked(chatFileBase64).mockResolvedValue('dGVzdA==');
    vi.mocked(modelChatApi.upload).mockResolvedValue(detail({attachments: [{id: 'file-1', name: 'doc.txt', bytes: 4, textBytes: 4, mediaType: 'text/plain', createdAt: ''}]}));
    vi.mocked(modelChatApi.removeAttachment).mockResolvedValue(detail());
});
afterEach(() => hooks.dispose());

describe('Сохранённая история и безопасная отправка', () => {
    it('Открывает последний личный диалог и сохраняет его историю', async () => {
        vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn()]}));
        const chat = await ready(); expect(chat.turns).toHaveLength(1); expect(chat.detail?.conversation.id).toBe('chat-1'); expect(modelChatApi.list).toHaveBeenCalledWith(model.id, 'prj-one', expect.any(AbortSignal));
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

describe('Отмена, переключение и владелец', () => {
    it('Отмена останавливает HTTP и игнорирует поздний результат', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Вопрос'); await flush(); const call = vi.mocked(modelChatApi.send).mock.calls[0];
        vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({id: 'saved-turn', requestId: call[2], status: 'pending', answer: undefined})]}));
        await render().stop(); expect(call[5].aborted).toBe(true); expect(modelChatApi.cancel).toHaveBeenCalledOnce();
        pending.resolve(detail({turns: [turn({requestId: call[2]})]})); await flush(); expect(render().turns[0].status).toBe('cancelled');
    });
    it('Остановка своего запроса не ждёт дополнительного HTTP, чужой pending не трогает', async () => {
        vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns: [turn({status: 'pending', answer: undefined})]}));
        let chat = await ready(); expect(chat.stopOwn()).toBe(false); expect(modelChatApi.cancel).not.toHaveBeenCalled();
        await chat.newChat(); const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); chat = render(); chat.send('Вопрос'); await flush();
        const signal = vi.mocked(modelChatApi.send).mock.calls[0][5]; expect(render().stopOwn()).toBe(true); expect(signal.aborted).toBe(true); expect(modelChatApi.cancel).not.toHaveBeenCalled(); pending.resolve(detail()); await flush();
    });
    it('Если запрос завершился между чтением и Stop, принимает итог сервера вместо ложной отмены', async () => {
        vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [turn({status: 'pending', answer: undefined})]}));
        const chat = await ready(); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({turns: [turn({status: 'pending', answer: undefined})]})).mockResolvedValueOnce(detail({turns: [turn()]}));
        vi.mocked(modelChatApi.cancel).mockRejectedValueOnce(new Error('Запрос уже завершён')); await chat.stop(); expect(render().turns[0].status).toBe('done'); expect(render().error).toBe('');
    });
    it('Смена диалога отменяет прежний запрос и не подмешивает его ответ', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Вопрос'); await flush(); const other = detail({conversation: {...detail().conversation, id: 'chat-2'}}); vi.mocked(modelChatApi.read).mockResolvedValue(other);
        await render().select('chat-2'); pending.resolve(detail({turns: [turn()]})); await flush(); expect(render().detail?.conversation.id).toBe('chat-2'); expect(render().turns).toEqual([]);
    });
    it('Смена owner до render не принимает поздний ответ', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Личный вопрос'); await flush(); owner.current = 'bob'; pending.resolve(detail({turns: [turn()]})); await flush(); expect(render(false).turns.some(value => value.answer)).toBe(false);
    });
    it('Unmount отменяет незавершённый HTTP и не принимает поздний ответ', async () => {
        const pending = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise);
        (await ready()).send('Вопрос'); await flush(); const signal = vi.mocked(modelChatApi.send).mock.calls[0][5]; hooks.dispose(); expect(signal.aborted).toBe(true); pending.resolve(detail({turns: [turn()]})); await flush();
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
});
