import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICatalogModel } from '../src/features/ModelCatalog/types';
import { useModelChat } from '../src/features/ModelChat/useModelChat';
import { sendModelChat } from '../src/features/ModelChat/api';
import type { IModelChatAnswer } from '../src/features/ModelChat/types';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }> = [], effects: Array<() => void> = [];
    return {
        begin: () => { cursor = 0; }, commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        state<T>(initial: T) { const slot = slots[cursor++] ??= { value: initial }; return [slot.value, (value: T) => { slot.value = value; }]; },
        ref<T>(initial: T) { return (slots[cursor++] ??= { value: { current: initial } }).value; },
        effect(effect: () => void | (() => void), deps: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
            const slot = slots[index] = { deps }; effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
});
const owner = vi.hoisted(() => ({ current: 'alice' }));
vi.mock('react', () => ({ useState: hooks.state, useRef: hooks.ref, useEffect: hooks.effect }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => { const selected = owner.current; return { captureOwner: () => () => selected === owner.current }; } }));
vi.mock('../src/features/ModelChat/api', () => ({ sendModelChat: vi.fn() }));
const model: ICatalogModel = { id: 'model-chat', name: 'Chat', description: '', runtime: 'remote-openai', model: 'upstream-model', modelVersion: '1', capability: 'chat', dimension: null, manifestSha256: null, verificationSha256: 'a'.repeat(64), modelPin: 'c'.repeat(64), source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
const answer: IModelChatAnswer = { content: 'Ответ модели', finishReason: 'stop' };
let selected = model, projectId: string | undefined, blocked = '';
const render = (commit = true) => { hooks.begin(); const state = useModelChat(selected, projectId, blocked); if (commit) hooks.commit(); return state; };
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => { hooks.dispose(); vi.clearAllMocks(); selected = model; projectId = 'prj-one'; blocked = ''; owner.current = 'alice'; vi.mocked(sendModelChat).mockResolvedValue(answer); });
afterEach(() => hooks.dispose());

describe('Отправка диалога', () => {
    it('Синхронная двойная отправка не дублирует запрос и сохраняет полный успешный контекст', async () => {
        const first = deferred<IModelChatAnswer>(); vi.mocked(sendModelChat).mockReturnValueOnce(first.promise);
        let chat = render(); expect(chat.send('  Первый вопрос')).toBe(true); expect(chat.send('Дубликат')).toBe(false);
        expect(sendModelChat).toHaveBeenCalledOnce(); expect(render().busy).toBe(true);
        expect(vi.mocked(sendModelChat).mock.calls[0].slice(0, 3)).toEqual([model, [{ role: 'user', content: '  Первый вопрос' }], 'prj-one']);
        first.resolve(answer); await flush(); chat = render(); expect(chat.turns[0]).toMatchObject({ status: 'done', prompt: '  Первый вопрос', answer });
        expect(chat.send('Второй вопрос')).toBe(true); await flush();
        expect(vi.mocked(sendModelChat).mock.calls[1][1]).toEqual([{ role: 'user', content: '  Первый вопрос' }, { role: 'assistant', content: answer.content }, { role: 'user', content: 'Второй вопрос' }]);
    });
    it('Пустое сообщение, блокировка и отсутствующий владелец не запускают inference', () => {
        let chat = render(); expect(chat.send('  \n ')).toBe(false); expect(render().error).toContain('Введите');
        blocked = 'Обновите каталог'; chat = render(); expect(chat.send('Вопрос')).toBe(false);
        blocked = ''; chat = render(); owner.current = 'bob'; expect(chat.send('Вопрос')).toBe(false); expect(sendModelChat).not.toHaveBeenCalled();
    });
    it('Failed retry повторяет ровно тот же вопрос, явное редактирование заменяет неуспешный хвост', async () => {
        vi.mocked(sendModelChat).mockRejectedValueOnce(new Error('Провайдер недоступен'));
        let chat = render(); chat.send('Вопрос'); await flush(); chat = render();
        expect(chat.turns).toHaveLength(1); expect(chat.turns[0]).toMatchObject({ status: 'failed', error: 'Провайдер недоступен' });
        expect(chat.send('Новый незаконченный')).toBe(false); chat.retry(); await flush(); chat = render();
        expect(chat.turns).toHaveLength(1); expect(chat.turns[0].status).toBe('done');
        expect(vi.mocked(sendModelChat).mock.calls[0][1]).toEqual(vi.mocked(sendModelChat).mock.calls[1][1]);
        vi.mocked(sendModelChat).mockRejectedValueOnce(new Error('Отказ')); chat.send('Третий'); await flush(); chat = render();
        expect(chat.editFailed()).toBe('Третий'); expect(render().turns).toHaveLength(1);
        expect(render().send('Исправленный третий')).toBe(true); await flush(); expect(render().turns).toHaveLength(2);
    });
    it('Новый диалог явно сбрасывает контекст и принимает обновлённый pin модели', async () => {
        let chat = render(); chat.send('Вопрос'); await flush();
        selected = { ...model, verificationSha256: 'b'.repeat(64) }; chat = render();
        expect(chat.blocked).toContain('Начните новый'); expect(chat.send('Следующий')).toBe(false);
        chat.reset(); chat = render(); expect(chat.turns).toEqual([]); expect(chat.blocked).toBe(''); expect(chat.send('Новый вопрос')).toBe(true);
        expect(vi.mocked(sendModelChat).mock.calls.at(-1)![1]).toEqual([{ role: 'user', content: 'Новый вопрос' }]);
    });
});

describe('Отмена, scope и поздние ответы', () => {
    it('Отмена отменяет HTTP, сохраняет вопрос и игнорирует ответ даже если transport проигнорировал abort', async () => {
        const pending = deferred<IModelChatAnswer>(); vi.mocked(sendModelChat).mockReturnValueOnce(pending.promise);
        let chat = render(); chat.send('Вопрос'); const signal = vi.mocked(sendModelChat).mock.calls[0][3];
        chat = render(); chat.stop(); expect(signal.aborted).toBe(true); expect(render().turns[0].status).toBe('cancelled');
        pending.resolve(answer); await flush(); chat = render(); expect(chat.turns[0].answer).toBeUndefined();
        chat.retry(); await flush(); expect(render().turns).toHaveLength(1); expect(render().turns[0].status).toBe('done');
    });
    it('Размонтирование отменяет запрос и не возвращает историю нового владельца', async () => {
        const pending = deferred<IModelChatAnswer>(); vi.mocked(sendModelChat).mockReturnValueOnce(pending.promise);
        render().send('Личное сообщение'); const signal = vi.mocked(sendModelChat).mock.calls[0][3]; hooks.dispose();
        expect(signal.aborted).toBe(true); pending.resolve(answer); await flush(); owner.current = 'bob'; expect(render().turns).toEqual([]);
    });
    it('Смена владельца до render не принимает поздний ответ', async () => {
        const pending = deferred<IModelChatAnswer>(); vi.mocked(sendModelChat).mockReturnValueOnce(pending.promise);
        render().send('Вопрос'); owner.current = 'bob'; pending.resolve(answer); await flush(); expect(render().turns[0].answer).toBeUndefined();
    });
    it('Семантика модели проверяется синхронно до effect отмены', async () => {
        const pending = deferred<IModelChatAnswer>(); vi.mocked(sendModelChat).mockReturnValueOnce(pending.promise);
        render().send('Вопрос'); selected = { ...model, modelVersion: '2' }; render(false);
        pending.resolve(answer); await flush(); render(); expect(render().turns[0].answer).toBeUndefined(); expect(render().turns[0].status).toBe('cancelled');
    });
    it('Обычное обновление metadata и временная загрузка каталога не уничтожают активный ответ', async () => {
        const pending = deferred<IModelChatAnswer>(); vi.mocked(sendModelChat).mockReturnValueOnce(pending.promise);
        render().send('Вопрос'); selected = { ...model, name: 'Переименована', description: 'Описание', revision: 2 }; blocked = 'Каталог обновляется'; render();
        pending.resolve(answer); await flush(); const chat = render(); expect(chat.turns[0]).toMatchObject({ status: 'done', answer }); expect(chat.send('Следующий')).toBe(false);
    });
    it('Старый владелец не возвращает приватный prompt из отложенной кнопки редактирования и не сбрасывает состояние', async () => {
        vi.mocked(sendModelChat).mockRejectedValueOnce(new Error('Отказ'));
        render().send('Личное сообщение'); await flush(); const chat = render(); owner.current = 'bob';
        expect(chat.editFailed()).toBeUndefined(); chat.reset(); expect(render().turns).toHaveLength(1);
    });
});
