import { describe, expect, it, vi } from 'vitest';
import { createAuthRequestOwner } from '../src/features/UserBlock/authRequestOwner';
import { addToProjectCatalogs, createProjectCatalogBatchController } from '../src/modules/Store/projectCatalogBatch';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function owner() {
    let scope = 'Алексей:администратор';
    const lifecycle = createAuthRequestOwner(scope, () => scope);
    lifecycle.activate();
    return { lifecycle, isCurrent: lifecycle.captureOwner(), change: (next: string) => { scope = next; } };
}

describe('Массовое добавление инструментов принадлежит инициатору', () => {
    it.each(['', 'другой аккаунт', 'Алексей:наблюдатель'])('Не начинает следующий POST после смены владельца: %s', async scope => {
        const pending = deferred<unknown>();
        const current = owner();
        const add = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true });
        const request = addToProjectCatalogs(['первый', 'второй'], add, current.isCurrent);
        expect(add).toHaveBeenCalledExactlyOnceWith('первый');
        current.change(scope);
        pending.resolve({ ok: true });
        expect(await request).toBeNull();
        expect(add).toHaveBeenCalledTimes(1);
    });

    it('Поздний отказ прежнего владельца тоже останавливает оставшиеся назначения', async () => {
        const pending = deferred<unknown>();
        const current = owner();
        const add = vi.fn().mockReturnValue(pending.promise);
        const request = addToProjectCatalogs(['первый', 'второй'], add, current.isCurrent);
        current.change('другой аккаунт');
        pending.reject(new Error('Сервис недоступен'));
        expect(await request).toBeNull();
        expect(add).toHaveBeenCalledTimes(1);
    });

    it('Размонтирование не позволяет завершить старую пачку после повторной активации', async () => {
        const pending = deferred<unknown>();
        const current = owner();
        const add = vi.fn().mockReturnValue(pending.promise);
        const request = addToProjectCatalogs(['первый', 'второй'], add, current.isCurrent);
        current.lifecycle.dispose(); current.lifecycle.activate();
        pending.resolve({ ok: true });
        expect(await request).toBeNull();
        expect(add).toHaveBeenCalledTimes(1);
    });

    it('Не запускает запись из уже закрытой формы', async () => {
        const add = vi.fn();
        expect(await addToProjectCatalogs(['первый'], add, () => false)).toBeNull();
        expect(add).not.toHaveBeenCalled();
    });

    it('Считает подтверждённые назначения и отказы, продолжая допустимую пачку', async () => {
        const add = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('Отказ')).mockResolvedValueOnce({ ok: true });
        expect(await addToProjectCatalogs(['первый', 'второй', 'третий'], add, owner().isCurrent)).toEqual({ ok: 2, fail: 1 });
        expect(add.mock.calls.map(([project]) => project)).toEqual(['первый', 'второй', 'третий']);
    });
});

describe('Одно окно массового добавления', () => {
    it('Синхронно блокирует второй confirm и закрытие до ответа первого POST', async () => {
        const controller = createProjectCatalogBatchController();
        const pending = deferred<unknown>();
        const add = vi.fn().mockReturnValue(pending.promise);
        const onCompleted = vi.fn().mockResolvedValue(undefined);
        const onBusyChange = vi.fn();
        const options = { projects: ['первый'], add, isOwnerCurrent: () => true, onCompleted, onBusyChange };
        const first = controller.run(options);
        await controller.run(options);
        expect(add).toHaveBeenCalledTimes(1);
        expect(controller.canClose()).toBe(false);
        // Тот же guard использует onCancel: занятое окно не закрывается и не открывает следующий picker.
        const close = vi.fn();
        if (controller.canClose()) { close(); }
        expect(close).not.toHaveBeenCalled();
        pending.resolve({ ok: true }); await first;
        expect(onCompleted).toHaveBeenCalledOnce();
        expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
        expect(controller.canClose()).toBe(true);
    });

    it('Держит блокировку во время обновления каталога после подтверждённой записи', async () => {
        const controller = createProjectCatalogBatchController();
        const refresh = deferred<void>();
        const onCompleted = vi.fn().mockReturnValue(refresh.promise);
        const add = vi.fn().mockResolvedValue({ ok: true });
        const options = { projects: ['первый'], add, isOwnerCurrent: () => true, onCompleted, onBusyChange: vi.fn() };
        const request = controller.run(options);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(onCompleted).toHaveBeenCalledOnce();
        expect(controller.canClose()).toBe(false);
        await controller.run(options);
        expect(add).toHaveBeenCalledTimes(1);
        refresh.resolve(); await request;
        expect(controller.canClose()).toBe(true);
    });

    it('Сброс для нового владельца не позволяет старому ответу закрыть новую пачку', async () => {
        const controller = createProjectCatalogBatchController();
        const old = deferred<unknown>();
        const current = deferred<unknown>();
        const oldBusy = vi.fn();
        const currentBusy = vi.fn();
        const oldCompleted = vi.fn().mockResolvedValue(undefined);
        const currentCompleted = vi.fn().mockResolvedValue(undefined);
        const oldAdd = vi.fn().mockReturnValue(old.promise);
        const oldRequest = controller.run({ projects: ['первый', 'второй'], add: oldAdd, isOwnerCurrent: () => true, onBusyChange: oldBusy, onCompleted: oldCompleted });
        controller.reset();
        const newRequest = controller.run({ projects: ['новый'], add: vi.fn().mockReturnValue(current.promise), isOwnerCurrent: () => true, onBusyChange: currentBusy, onCompleted: currentCompleted });
        old.resolve({ ok: true }); await oldRequest;
        expect(oldAdd).toHaveBeenCalledTimes(1);
        expect(oldCompleted).not.toHaveBeenCalled();
        expect(oldBusy.mock.calls).toEqual([[true]]);
        expect(currentBusy.mock.calls).toEqual([[true]]);
        expect(controller.canClose()).toBe(false);
        current.resolve({ ok: true }); await newRequest;
        expect(currentCompleted).toHaveBeenCalledOnce();
        expect(currentBusy.mock.calls).toEqual([[true], [false]]);
    });

    it('Инвалидирует прежний callback, если новое окно появилось во время обновления', async () => {
        const controller = createProjectCatalogBatchController();
        const refresh = deferred<void>();
        const notify = vi.fn();
        const request = controller.run({
            projects: ['первый'], add: vi.fn().mockResolvedValue({ ok: true }), isOwnerCurrent: () => true, onBusyChange: vi.fn(),
            onCompleted: async (_, isCurrent) => { await refresh.promise; if (isCurrent()) { notify(); } },
        });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        controller.reset();
        refresh.resolve(); await request;
        expect(notify).not.toHaveBeenCalled();
    });

    it('Не запускает пачку из формы прежней роли', async () => {
        const controller = createProjectCatalogBatchController();
        const add = vi.fn();
        const onBusyChange = vi.fn();
        await controller.run({ projects: ['первый'], add, isOwnerCurrent: () => false, onBusyChange, onCompleted: vi.fn() });
        expect(add).not.toHaveBeenCalled();
        expect(onBusyChange).not.toHaveBeenCalled();
        expect(controller.canClose()).toBe(true);
    });
});
