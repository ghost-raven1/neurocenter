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
let selected = model, projectId = 'prj-one', blocked = '', selection: Parameters<typeof useModelChat>[3];
const render = (commit = true) => {hooks.begin(); const result = useModelChat(selected, projectId, blocked, selection); if (commit) hooks.commit(); return result;};
const flush = async () => {for (let index = 0; index < 30; index++) await Promise.resolve();};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;}); return {promise, resolve, reject};}
const ready = async () => {render(); await flush(); return render();};
beforeEach(() => {
    hooks.dispose(); vi.clearAllMocks(); selected = model; projectId = 'prj-one'; blocked = ''; selection = undefined; owner.current = 'alice';
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => {storage.set(key, value);}, removeItem: (key: string) => {storage.delete(key);}});
    vi.mocked(modelChatApi.list).mockResolvedValue([]); vi.mocked(modelChatApi.create).mockResolvedValue(detail()); vi.mocked(modelChatApi.read).mockResolvedValue(detail());
    vi.mocked(modelChatApi.history).mockResolvedValue({turns: [], attachments: [], history: {hasMore: false, nextCursor: null}});
    vi.mocked(modelChatApi.send).mockImplementation(async (_saved, _model, requestId, prompt, attachmentIds) => detail({turns: [turn({requestId, prompt, attachmentIds})]}));
    vi.mocked(modelChatApi.retry).mockResolvedValue(detail({turns: [turn()]})); vi.mocked(modelChatApi.cancel).mockResolvedValue(detail({turns: [turn({status: 'cancelled', answer: undefined})]}));
    vi.mocked(modelChatApi.deleteFailed).mockResolvedValue(detail()); vi.mocked(modelChatApi.rename).mockResolvedValue(detail()); vi.mocked(modelChatApi.remove).mockResolvedValue({} as never);
    vi.mocked(chatFileBase64).mockResolvedValue('dGVzdA==');
    vi.mocked(modelChatApi.upload).mockResolvedValue(detail({attachments: [{id: 'file-1', name: 'doc.txt', bytes: 4, textBytes: 4, mediaType: 'text/plain', createdAt: ''}]}));
    vi.mocked(modelChatApi.removeAttachment).mockResolvedValue(detail());
});
afterEach(() => {hooks.dispose(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('Восстановление неподтверждённой отправки', () => {
    const saved = () => detail({attachments: [{id: 'pdf-1', name: 'report.pdf', mediaType: 'application/pdf', bytes: 614, textBytes: 20, createdAt: ''}]});
    it.each([false, true])('После503 и remount с initialDetail=%s сохраняет текст/PDF ID и прежний requestId', async initialDetail => {
        const grant = {protocol: 'json-actions-v1' as const, rag: true, systemRoles: true};
        vi.mocked(modelChatApi.list).mockResolvedValue([saved().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        vi.mocked(modelChatApi.send).mockRejectedValueOnce({response: {status: 503}, message: 'Проверка входа временно недоступна'});
        (await ready()).send('Не потерять текст PDF', undefined, grant); await flush();
        const requestId = vi.mocked(modelChatApi.send).mock.calls[0][2]; expect(render().turns[0].status).toBe('failed');
        hooks.dispose(); if (initialDetail) selection = {initialDetail: saved(), autoSelect: false}; const restored = await ready();
        expect(restored.turns).toEqual([expect.objectContaining({prompt: 'Не потерять текст PDF', attachmentIds: ['pdf-1'], requestId, status: 'failed'})]);
        expect(modelChatApi.send).toHaveBeenCalledOnce(); restored.retry(); await flush();
        expect(vi.mocked(modelChatApi.send).mock.calls[1].slice(2, 5)).toEqual([requestId, 'Не потерять текст PDF', ['pdf-1']]);
        expect(vi.mocked(modelChatApi.send).mock.calls[1][8]).toEqual(grant);
    });
    it('Смена диалога во время POST не теряет исходный запрос и не переносит его в другой диалог', async () => {
        const submission = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(submission.promise);
        vi.mocked(modelChatApi.list).mockResolvedValue([saved().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        (await ready()).send('Вопрос первого диалога'); await flush(); const requestId = vi.mocked(modelChatApi.send).mock.calls[0][2];
        const other = detail({conversation: {...saved().conversation, id: 'other'}}); vi.mocked(modelChatApi.read).mockResolvedValue(other);
        await render().select('other'); expect(render().turns).toEqual([]); submission.reject(Error('offline')); await flush();
        vi.mocked(modelChatApi.read).mockResolvedValue(saved()); await render().select(saved().conversation.id);
        expect(render().turns).toEqual([expect.objectContaining({prompt: 'Вопрос первого диалога', attachmentIds: ['pdf-1'], requestId, status: 'failed'})]);
        expect(modelChatApi.send).toHaveBeenCalledOnce();
    });
    it('Сохранённое сервером подтверждение очищает journal и не воскрешает локальную ошибку', async () => {
        vi.mocked(modelChatApi.list).mockResolvedValue([saved().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        vi.mocked(modelChatApi.send).mockImplementationOnce(async (_detail, _model, requestId) => {
            vi.mocked(modelChatApi.read).mockResolvedValue({...saved(), turns: [turn({requestId, attachmentIds: ['pdf-1']})]}); throw Error('ACK lost');
        });
        (await ready()).send('Принятый запрос'); await flush(); expect(render().turns[0].status).toBe('done');
        hooks.dispose(); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        expect((await ready()).turns).toEqual([]); expect(modelChatApi.send).toHaveBeenCalledOnce();
    });
    it.each(['owner', 'model', 'project'])('Journal изолирован по %s и не исчезает при возврате', async dimension => {
        vi.mocked(modelChatApi.list).mockResolvedValue([saved().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        vi.mocked(modelChatApi.send).mockRejectedValueOnce(Error('offline')); (await ready()).send('Личный текст'); await flush(); hooks.dispose();
        if (dimension === 'owner') owner.current = 'bob'; else if (dimension === 'model') selected = {...model, id: 'another-model'}; else projectId = 'prj-two';
        expect((await ready()).turns).toEqual([]); hooks.dispose(); owner.current = 'alice'; selected = model; projectId = 'prj-one';
        expect((await ready()).turns[0].prompt).toBe('Личный текст'); expect(modelChatApi.send).toHaveBeenCalledOnce();
    });
    it('Закрытие во время POST сохраняет исходный input, поздний callback не подменяет восстановление', async () => {
        const submission = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(submission.promise);
        vi.mocked(modelChatApi.list).mockResolvedValue([saved().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        (await ready()).send('Запрос без ACK'); await flush(); const requestId = vi.mocked(modelChatApi.send).mock.calls[0][2]; hooks.dispose();
        expect((await ready()).turns[0]).toMatchObject({requestId, prompt: 'Запрос без ACK', attachmentIds: ['pdf-1'], status: 'failed'});
        submission.resolve({...saved(), turns: [turn({requestId})]}); await flush();
        expect(render().turns[0].status).toBe('failed'); expect(modelChatApi.send).toHaveBeenCalledOnce();
    });
    it('Первое сообщение восстанавливается и при отказе создания диалога, без автоматического нового create', async () => {
        vi.mocked(modelChatApi.create).mockRejectedValueOnce(Error('503'));
        (await ready()).send('Первый текст'); await flush(); hooks.dispose();
        const restored = await ready(); expect(restored.detail).toBeNull(); expect(restored.turns[0]).toMatchObject({prompt: 'Первый текст', attachmentIds: [], status: 'failed'});
        expect(modelChatApi.create).toHaveBeenCalledOnce(); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it('Create переносит journal в точный диалог, а подтверждённый retry очищает оба ключа', async () => {
        const submission = deferred<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(submission.promise);
        (await ready()).send('Первое сообщение'); await flush(); const requestId = vi.mocked(modelChatApi.send).mock.calls[0][2]; hooks.dispose();
        vi.mocked(modelChatApi.list).mockResolvedValue([saved().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        const restored = await ready(); expect(restored.detail?.conversation.id).toBe(saved().conversation.id); expect(restored.turns[0]).toMatchObject({requestId, prompt: 'Первое сообщение'});
        vi.mocked(modelChatApi.send).mockResolvedValueOnce({...saved(), turns: [turn({requestId})]}); restored.retry(); await flush();
        submission.resolve({...saved(), turns: [turn({requestId})]}); await flush(); hooks.dispose();
        expect((await ready()).turns).toEqual([]); expect(modelChatApi.create).toHaveBeenCalledOnce(); expect(modelChatApi.send).toHaveBeenCalledTimes(2);
    });
    it('Текст того же пользователя сохраняется при изменении реального JSON auth scope', async () => {
        owner.current = JSON.stringify({id: 'alice-id', email: 'alice@example.test', activeRole: 'Developer', projectRoles: ['prj-one']});
        vi.mocked(modelChatApi.list).mockResolvedValue([saved().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        vi.mocked(modelChatApi.send).mockRejectedValueOnce(Error('503')); (await ready()).send('Мой исходный текст'); await flush(); hooks.dispose();
        owner.current = JSON.stringify({id: 'alice-id', email: 'alice@example.test', activeRole: 'Observer', projectRoles: []});
        expect((await ready()).turns[0].prompt).toBe('Мой исходный текст'); expect(modelChatApi.send).toHaveBeenCalledOnce();
    });
    it('Если браузер не сохраняет запрос, POST не начинается и вложение остаётся доступно', async () => {
        vi.stubGlobal('sessionStorage', {getItem: () => null, setItem: () => {throw Error('quota');}, removeItem: () => undefined});
        vi.mocked(modelChatApi.list).mockResolvedValue([saved().conversation]); vi.mocked(modelChatApi.read).mockResolvedValue(saved());
        expect((await ready()).send('Остаться в редакторе')).toBe(false); expect(render().error).toContain('Запрос не отправлен');
        expect(render().attachments.map(file => file.id)).toEqual(['pdf-1']); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
});
