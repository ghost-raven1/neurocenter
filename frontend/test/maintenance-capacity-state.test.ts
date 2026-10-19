import { describe, expect, it, vi } from 'vitest';

import { createCapacityStatusController, initialCapacityStatusState } from '../src/modules/Maintenance/capacityStatusController';
import type { ICapacityStatus } from '../src/modules/Maintenance/capacityStatusController';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (failure: Error) => void;
    const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

function harness() {
    let state = initialCapacityStatusState();
    const read = vi.fn<() => Promise<ICapacityStatus>>();
    const onChange = vi.fn((value: typeof state) => { state = value; });
    const controller = createCapacityStatusController(read, onChange);
    controller.activate();
    return { controller, read, onChange, get state() { return state; } };
}

const fresh: ICapacityStatus = { available: true, observedAt: '2026-10-18T02:00:00Z', reserveBytes: 1024 };

describe('Физические ресурсы и конкурирующие обновления', () => {
    it.each([401, 403])('Отказ доступа %s убирает прежний замер и допускает явный повтор', async code => {
        const h = harness();
        h.read.mockResolvedValueOnce(fresh).mockRejectedValueOnce({ isAxiosError: true, response: { status: code } });
        await h.controller.refresh();
        await h.controller.refresh();
        expect(h.state.data).toBeNull();
        expect(h.state.error).toBeTruthy();
        h.read.mockResolvedValueOnce(fresh);
        await h.controller.refresh();
        expect(h.state.data).toEqual(fresh);
        expect(h.state.error).toBeNull();
    });

    it('Более ранний poll не заменяет новый замер', async () => {
        const h = harness();
        const previous = deferred<ICapacityStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(fresh);
        const poll = h.controller.refresh();
        await h.controller.refresh();
        previous.resolve({ available: false });
        await poll;
        expect(h.state.data).toEqual(fresh);
        expect(h.state.loading).toBe(false);
    });

    it('Ошибка прошлого запроса не скрывает свежий замер', async () => {
        const h = harness();
        const previous = deferred<ICapacityStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(fresh);
        const poll = h.controller.refresh();
        await h.controller.refresh();
        previous.reject(new Error('Старый запрос оборвался'));
        await poll;
        expect(h.state.data).toEqual(fresh);
        expect(h.state.error).toBeNull();
    });

    it('Не скрывает индикатор нового запроса при завершении предыдущего', async () => {
        const h = harness();
        const previous = deferred<ICapacityStatus>();
        const current = deferred<ICapacityStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
        const poll = h.controller.refresh();
        const manual = h.controller.refresh();
        previous.resolve(fresh);
        await poll;
        expect(h.state.loading).toBe(true);
        current.resolve(fresh);
        await manual;
        expect(h.state.loading).toBe(false);
    });

    it('При новом отказе сохраняет прошлый замер и показывает причину', async () => {
        const h = harness();
        h.read.mockResolvedValueOnce(fresh).mockRejectedValueOnce(new Error('Сеть недоступна'));
        await h.controller.refresh();
        await h.controller.refresh();
        expect(h.state.data).toEqual(fresh);
        expect(h.state.error).toBe('Сеть недоступна');
        expect(h.state.loading).toBe(false);
    });

    it('Размонтирование запрещает позднее обновление и новые запросы', async () => {
        const h = harness();
        const pending = deferred<ICapacityStatus>();
        h.read.mockReturnValueOnce(pending.promise);
        const loading = h.controller.refresh();
        h.controller.dispose();
        h.onChange.mockClear();
        pending.reject(new Error('Поздняя ошибка'));
        await loading;
        await h.controller.refresh();
        expect(h.onChange).not.toHaveBeenCalled();
        expect(h.read).toHaveBeenCalledTimes(1);
    });

    it('Смена аккаунта очищает прежние данные и игнорирует старое соединение', async () => {
        const h = harness();
        const previous = deferred<ICapacityStatus>();
        h.read.mockResolvedValueOnce(fresh).mockReturnValueOnce(previous.promise);
        await h.controller.refresh();
        const poll = h.controller.refresh();
        h.controller.dispose();
        h.controller.activate();
        expect(h.state).toEqual(initialCapacityStatusState());
        const nextAccount = { available: false, reason: 'CAPACITY_NOT_CONFIGURED' };
        h.read.mockResolvedValueOnce(nextAccount);
        await h.controller.refresh();
        previous.resolve(fresh);
        await poll;
        expect(h.state.data).toEqual(nextAccount);
    });
});
