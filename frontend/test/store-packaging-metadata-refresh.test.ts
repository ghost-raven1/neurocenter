import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePackagingMetadata } from '../src/modules/Store/packaging/usePackagingMetadata';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{ value?: unknown; dependencies?: unknown[]; cleanup?: () => void }> = [];
    const effects: Array<() => void> = [];
    return {
        begin: () => { cursor = 0; },
        commit: () => { effects.splice(0).forEach(effect => effect()); },
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial: T) {
            const slot = slots[cursor++] ??= { value: initial };
            return [slot.value, (next: T) => { slot.value = next; }];
        },
        useRef<T>(initial: T) { return (slots[cursor++] ??= { value: { current: initial } }).value; },
        useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
            const index = cursor++;
            const previous = slots[index];
            if (previous && dependencies.length === previous.dependencies?.length
                && dependencies.every((value, position) => Object.is(value, previous.dependencies![position]))) return;
            const slot = slots[index] = { dependencies };
            effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
});
vi.mock('react', () => ({ useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
interface Metadata { revision: string; }
function render(key: string, read: () => Promise<Metadata>) {
    hooks.begin();
    const view = usePackagingMetadata(key, read, 'Не удалось проверить источник');
    hooks.commit();
    return view;
}
afterEach(() => hooks.dispose());

describe('Явная проверка источника обновляет закреплённую версию упаковки', () => {
    it.each(['npm:latest', 'repository:main'])('Обновляет %s по запросу, а отправка сохраняет просмотренный pin', async key => {
        const read = vi.fn().mockResolvedValueOnce({ revision: 'old' }).mockResolvedValueOnce({ revision: 'new' });
        expect(await render(key, read).resolve()).toEqual({ revision: 'old' });
        expect(await render(key, read).resolve()).toEqual({ revision: 'old' });
        expect(read).toHaveBeenCalledOnce();
        expect(await render(key, read).resolve(true)).toEqual({ revision: 'new' });
        expect(render(key, read).metadata).toEqual({ revision: 'new' });
        expect(await render(key, read).resolve()).toEqual({ revision: 'new' });
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('Проверка при потере фокуса и сразу нажатая кнопка используют один актуальный запрос', async () => {
        const fresh = deferred<Metadata>();
        const read = vi.fn(() => fresh.promise);
        const first = render('repository:main', read).resolve();
        const second = render('repository:main', read).resolve(true);
        expect(render('repository:main', read)).toMatchObject({ loading: true, metadata: undefined });
        fresh.resolve({ revision: 'new' });
        expect(await first).toEqual({ revision: 'new' });
        expect(await second).toEqual({ revision: 'new' });
        expect(render('repository:main', read)).toMatchObject({ loading: false, metadata: { revision: 'new' } });
        expect(read).toHaveBeenCalledOnce();
    });

    it('Переход A → B → A не восстанавливает первый ответ A поверх новой проверки', async () => {
        const old = deferred<Metadata>(), fresh = deferred<Metadata>();
        const readA = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        const readB = vi.fn().mockResolvedValue({ revision: 'B' });
        const first = render('A', readA).resolve();
        await render('B', readB).resolve();
        const second = render('A', readA).resolve(true);
        fresh.resolve({ revision: 'new A' }); await second;
        old.resolve({ revision: 'old A' }); await first;
        expect(render('A', readA).metadata).toEqual({ revision: 'new A' });
        expect(await render('A', readA).resolve()).toEqual({ revision: 'new A' });
    });

    it('Поздний успешный ответ не скрывает ошибку последней явной проверки', async () => {
        const old = deferred<Metadata>(), fresh = deferred<Metadata>();
        const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
            .mockResolvedValueOnce({ revision: 'retry' });
        const first = render('npm:latest', read).resolve();
        render('other-source', read);
        const second = render('npm:latest', read).resolve(true);
        fresh.reject(new Error('Источник недоступен'));
        await expect(second).rejects.toThrow('Источник недоступен');
        old.resolve({ revision: 'old' }); await first;
        expect(render('npm:latest', read)).toMatchObject({ loading: false, error: 'Источник недоступен', metadata: undefined });
        expect(await render('npm:latest', read).resolve()).toEqual({ revision: 'retry' });
    });

    it('Обычные проверки во время одного запроса не создают дубликат чтения', async () => {
        const response = deferred<Metadata>();
        const read = vi.fn(() => response.promise);
        const first = render('npm:latest', read).resolve();
        const second = render('npm:latest', read).resolve();
        response.resolve({ revision: 'viewed' });
        expect(await first).toEqual({ revision: 'viewed' });
        expect(await second).toEqual({ revision: 'viewed' });
        expect(read).toHaveBeenCalledOnce();
    });

    it('Старый обработчик проверки не читает прежний источник после переключения', async () => {
        const readA = vi.fn().mockResolvedValue({ revision: 'A' });
        const readB = vi.fn().mockResolvedValue({ revision: 'B' });
        const oldCheck = render('A', readA).resolve;
        await render('B', readB).resolve();
        await expect(oldCheck(true)).rejects.toThrow('Источник изменился');
        expect(readA).not.toHaveBeenCalled();
        expect(render('B', readB).metadata).toEqual({ revision: 'B' });
    });
});
