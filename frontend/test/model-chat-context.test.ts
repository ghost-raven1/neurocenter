import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useChatContext} from '../src/features/ModelChat/useChatContext';
import {modelChatApi} from '../src/features/ModelChat/api';
import type {IModelChatContext} from '../src/features/ModelChat/types';
import {detail} from './model-chat-fixtures';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    return {
        begin: () => {cursor = 0;}, commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => {slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0;},
        state<T>(initial: T) {const slot = slots[cursor++] ??= {value: initial}; return [slot.value, (value: T) => {slot.value = value;}];},
        effect(effect: () => void | (() => void), deps: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
            const slot = slots[index] = {deps}; effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});
        },
    };
});
const owner = vi.hoisted(() => ({current: 'alice'}));
vi.mock('react', () => ({useState: hooks.state, useEffect: hooks.effect}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {context: vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => {
    const captureOwner = () => {const value = owner.current; return () => value === owner.current;};
    return {useAuthRequestOwner: () => ({captureOwner})};
});
let prompt = 'Вопрос', ids: string[] = [];
const render = () => {hooks.begin(); const value = useChatContext(detail(), prompt, ids); hooks.commit(); return value;};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
beforeEach(() => {hooks.dispose(); vi.useFakeTimers(); vi.clearAllMocks(); owner.current = 'alice'; prompt = 'Вопрос'; ids = []; vi.mocked(modelChatApi.context).mockResolvedValue(detail().context);});
afterEach(() => {hooks.dispose(); vi.useRealTimers();});

describe('Предварительный контекст', () => {
    it('Debounce не создаёт запрос на каждое нажатие; в запрос попадают ID документов', async () => {
        render(); await vi.advanceTimersByTimeAsync(200); prompt = 'Новый вопрос'; ids = ['file-1']; render(); await vi.advanceTimersByTimeAsync(349); expect(modelChatApi.context).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1); expect(modelChatApi.context).toHaveBeenCalledExactlyOnceWith('chat-1', prompt, ids, expect.any(AbortSignal)); expect(render().context?.method).toBe('estimate');
    });
    it('Новый черновик сразу убирает прежнюю оценку и игнорирует её поздний ответ', async () => {
        const pending = deferred<IModelChatContext>(); vi.mocked(modelChatApi.context).mockReturnValueOnce(pending.promise);
        render(); await vi.advanceTimersByTimeAsync(350); const signal = vi.mocked(modelChatApi.context).mock.calls[0][3]; prompt = 'Другой'; expect(render().context).toBeUndefined(); expect(signal.aborted).toBe(true);
        pending.resolve({...detail().context, exceeded: true}); await Promise.resolve(); expect(render().context).toBeUndefined();
    });
    it('Конкретный отказ валидации блокирует отправку, сетевая ошибка оставляет серверную проверку', async () => {
        vi.mocked(modelChatApi.context).mockRejectedValueOnce({isAxiosError: true, response: {status: 400, data: {message: 'Файлы превышают 128 КиБ'}}});
        render(); await vi.advanceTimersByTimeAsync(350); expect(render()).toMatchObject({rejected: true, error: 'Файлы превышают 128 КиБ'});
        prompt = 'Другой'; vi.mocked(modelChatApi.context).mockRejectedValueOnce(new Error('Offline')); render(); await vi.advanceTimersByTimeAsync(350); expect(render().rejected).toBe(false); expect(render().error).toContain('Сервер проверит');
    });
    it('Смена владельца не принимает оценку прежнего личного диалога', async () => {
        const pending = deferred<IModelChatContext>(); vi.mocked(modelChatApi.context).mockReturnValueOnce(pending.promise); render(); await vi.advanceTimersByTimeAsync(350); owner.current = 'bob'; pending.resolve(detail().context); await Promise.resolve(); expect(render().context).toBeUndefined();
    });
});
