import { describe, expect, it, vi } from 'vitest';

import type { IOperationPage } from '../src/core/api/interfaces';
import { activeOperationsFromPage, createActiveOperationsController, type IActiveOperations } from '../src/modules/Operations/activeOperationsController';

const page = (percent = 30): IOperationPage => ({
    items: [], page: 1, size: 1, total: 100, activeCount: 4,
    activeProgress: { percent, running: 3, queued: 1 },
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

describe('Прогресс на кнопке операций', () => {
    it.each([401, 403])('Отказ %s убирает прежний счётчик и процент до успешной перепроверки', async status => {
        const failure = Object.assign(new Error('Доступ отозван'), { isAxiosError: true, response: { status } });
        const read = vi.fn().mockResolvedValueOnce(page(42)).mockRejectedValueOnce(failure).mockResolvedValueOnce(page(80));
        let value!: IActiveOperations;
        const controller = createActiveOperationsController(read, next => { value = next; });
        controller.activate(); await controller.refresh(); await controller.refresh();
        expect(value).toMatchObject({ count: 0, percent: null, updatedAt: null, stale: true, accessDenied: true });
        await controller.refresh();
        expect(value).toMatchObject({ count: 4, percent: 80, stale: false, accessDenied: false });
    });

    it('Поздний успешный ответ не возвращает процент после свежего запрета', async () => {
        const old = deferred<IOperationPage>();
        const failure = Object.assign(new Error('Доступ отозван'), { isAxiosError: true, response: { status: 403 } });
        const read = vi.fn().mockReturnValueOnce(old.promise).mockRejectedValueOnce(failure);
        let value!: IActiveOperations;
        const controller = createActiveOperationsController(read, next => { value = next; });
        controller.activate(); const first = controller.refresh(); await controller.refresh();
        old.resolve(page(90)); await first;
        expect(value).toMatchObject({ count: 0, percent: null, accessDenied: true });
    });

    it('Показывает сводку всей активной очереди независимо от первой страницы истории', () => {
        expect(activeOperationsFromPage(page(42.6))).toMatchObject({ count: 4, percent: 43, running: 3, queued: 1, stale: false });
    });

    it('Старый сервер сохраняет счётчик без выдуманного процента', () => {
        const legacy = page();
        delete legacy.activeProgress;
        expect(activeOperationsFromPage(legacy)).toMatchObject({ count: 4, percent: null, running: null, queued: null });
    });

    it.each([-10, 130])('Ограничивает некорректный процент %s границами полосы', percent => {
        expect(activeOperationsFromPage(page(percent)).percent).toBe(percent < 0 ? 0 : 100);
    });

    it('При завершении всех заданий убирает прогресс и активный счётчик', () => {
        expect(activeOperationsFromPage({ ...page(100), activeCount: 0, activeProgress: { percent: 0, running: 0, queued: 0 } }))
            .toMatchObject({ count: 0, percent: null, running: 0, queued: 0 });
    });

    it('Не выдаёт нечисловой ответ за достоверный процент', () => {
        expect(activeOperationsFromPage(page(Number.NaN)).percent).toBeNull();
    });

    it('Более поздний запрос обновляет процент, старый ответ его не откатывает', async () => {
        const old = deferred<IOperationPage>();
        const current = deferred<IOperationPage>();
        const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        let value!: IActiveOperations;
        const controller = createActiveOperationsController(read, next => { value = next; });
        controller.activate();
        const first = controller.refresh();
        const second = controller.refresh();
        current.resolve(page(80)); await second;
        old.resolve(page(10)); await first;
        expect(value).toMatchObject({ count: 4, percent: 80, stale: false });
    });

    it('Сетевая ошибка сохраняет прошлый прогресс с отметкой устаревания, повтор восстанавливает его', async () => {
        const read = vi.fn().mockResolvedValueOnce(page(25)).mockRejectedValueOnce(new Error('Нет сети')).mockResolvedValueOnce(page(70));
        let value!: IActiveOperations;
        const controller = createActiveOperationsController(read, next => { value = next; });
        controller.activate(); await controller.refresh();
        const updatedAt = value.updatedAt;
        await controller.refresh();
        expect(value).toMatchObject({ percent: 25, stale: true, updatedAt });
        await controller.refresh();
        expect(value).toMatchObject({ percent: 70, stale: false });
    });

    it('Старый отказ не помечает свежий прогресс устаревшим', async () => {
        const old = deferred<IOperationPage>();
        const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(80));
        let value!: IActiveOperations;
        const controller = createActiveOperationsController(read, next => { value = next; });
        controller.activate(); const first = controller.refresh();
        await controller.refresh(); old.reject(new Error('Старый отказ')); await first;
        expect(value).toMatchObject({ percent: 80, stale: false });
    });

    it('Выход и повторное открытие не принимают прогресс прежнего владельца', async () => {
        const old = deferred<IOperationPage>();
        const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(65));
        let value!: IActiveOperations;
        const controller = createActiveOperationsController(read, next => { value = next; });
        controller.activate(); const first = controller.refresh();
        controller.dispose(); controller.activate(); await controller.refresh();
        old.resolve(page(95)); await first;
        expect(value).toMatchObject({ percent: 65, stale: false });
    });

    it('После размонтирования не обновляет кнопку и не выполняет новые запросы', async () => {
        const pending = deferred<IOperationPage>();
        const onChange = vi.fn();
        const read = vi.fn().mockReturnValue(pending.promise);
        const controller = createActiveOperationsController(read, onChange);
        controller.activate(); const request = controller.refresh(); controller.dispose();
        const calls = onChange.mock.calls.length;
        pending.resolve(page()); await request; await controller.refresh();
        expect(onChange).toHaveBeenCalledTimes(calls);
        expect(read).toHaveBeenCalledTimes(1);
    });
});
