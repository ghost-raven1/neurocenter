import { describe, expect, it, vi } from 'vitest';

import type { IOperation, IOperationDetail, IOperationListParams, IOperationPage } from '../src/core/api/interfaces';
import { createOperationsQueueController, initialOperationsQueueSnapshot } from '../src/modules/Operations/operationsQueueController';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (failure: Error) => void;
    const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

const operation = (id: string, changes: Partial<IOperation> = {}): IOperation => ({
    operationId: id, type: 'SYNC', projectId: 'project', resourceType: 'rag', resourceId: 'index',
    actor: 'admin@example.com', state: 'RUNNING', percent: 30, bytesDone: 30, bytesTotal: 100,
    startedAt: '2026-10-18T00:00:00Z', finishedAt: null, error: null, ...changes,
});
const detail = (id: string, changes: Partial<IOperationDetail> = {}): IOperationDetail => ({
    ...operation(id), log: [{ at: '2026-10-18T00:00:00Z', level: 'INFO', message: 'Выполняется' }], retries: 0, ...changes,
});
const page = (items: IOperation[], total = items.length): IOperationPage => ({ items, page: 1, size: 10, total, activeCount: 5 });
const denied = (status: number) => Object.assign(new Error('Доступ отозван'), { isAxiosError: true, response: { status, data: { message: 'Доступ отозван' } } });

function harness(projectId?: string) {
    let snapshot = initialOperationsQueueSnapshot();
    const readList = vi.fn<(params: IOperationListParams) => Promise<IOperationPage>>();
    const readDetail = vi.fn<(id: string) => Promise<IOperationDetail>>();
    const onChange = vi.fn((value: typeof snapshot) => { snapshot = value; });
    const controller = createOperationsQueueController({ projectId, readList, readDetail, onChange });
    controller.activate();
    return { controller, readList, readDetail, onChange, get snapshot() { return snapshot; } };
}

describe('Очередь операций и конкурирующие запросы', () => {
    it.each([401, 403])('Отказ %s очищает очередь, журнал и право действия без нового входа', async status => {
        const h = harness();
        h.readList.mockResolvedValueOnce(page([operation('known')])).mockRejectedValueOnce(denied(status));
        h.readDetail.mockResolvedValueOnce(detail('known'));
        await h.controller.reload(); await h.controller.select('known'); await h.controller.reload();
        expect(h.snapshot).toMatchObject({ list: [], total: 0, selected: null, selectedId: '',
            loading: false, detailLoading: false, updatedAt: null, accessDenied: true, error: 'Доступ отозван' });
    });

    it('Отказ подробностей 403 очищает прежний журнал и список, оставляя объяснение в открытой панели', async () => {
        const h = harness();
        h.readList.mockResolvedValue(page([operation('known')]));
        h.readDetail.mockResolvedValueOnce(detail('known')).mockRejectedValueOnce(denied(403));
        await h.controller.reload(); await h.controller.select('known'); await h.controller.refreshDetail();
        expect(h.snapshot).toMatchObject({ list: [], selected: null, selectedId: 'known', accessDenied: true,
            detailLoading: false, detailError: 'Доступ отозван' });
    });

    it('Удалённая операция 404 не оставляет старый журнал и кнопки действий', async () => {
        const h = harness();
        h.readDetail.mockResolvedValueOnce(detail('known')).mockRejectedValueOnce(denied(404));
        await h.controller.select('known'); await h.controller.refreshDetail();
        expect(h.snapshot).toMatchObject({ selected: null, selectedId: 'known', accessDenied: false, detailError: 'Доступ отозван' });
    });

    it('Поздний успешный журнал не восстанавливает данные после запрета списка', async () => {
        const h = harness(); const pending = deferred<IOperationDetail>();
        h.readDetail.mockResolvedValueOnce(detail('known')).mockReturnValueOnce(pending.promise);
        await h.controller.select('known'); const previous = h.controller.refreshDetail();
        h.readList.mockRejectedValue(denied(403)); await h.controller.reload();
        pending.resolve(detail('known')); await previous;
        expect(h.snapshot).toMatchObject({ selected: null, selectedId: '', accessDenied: true, detailLoading: false });
    });

    it('Поздний успешный список не восстанавливает данные после запрета подробностей', async () => {
        const h = harness(); const pending = deferred<IOperationPage>();
        h.readList.mockReturnValue(pending.promise); const previous = h.controller.reload();
        h.readDetail.mockRejectedValue(denied(403)); await h.controller.select('known');
        pending.resolve(page([operation('known')])); await previous;
        expect(h.snapshot).toMatchObject({ list: [], accessDenied: true, loading: false });
    });

    it('Явная успешная перепроверка после 403 возвращает доступ к полученной очереди', async () => {
        const h = harness();
        h.readList.mockRejectedValueOnce(denied(403)).mockResolvedValueOnce(page([operation('fresh')]));
        await h.controller.reload(); await h.controller.reload();
        expect(h.snapshot).toMatchObject({ accessDenied: false, error: '', total: 1 });
        expect(h.snapshot.list[0].operationId).toBe('fresh');
    });

    it('Передаёт проект, страницу и точный статус в серверный запрос', async () => {
        const h = harness('another-project');
        h.readList.mockResolvedValue(page([operation('failed', { state: 'FAILED' })], 30));
        await h.controller.setPage(2);
        await h.controller.setState('FAILED');
        expect(h.readList.mock.calls.map(([params]) => params)).toEqual([
            { page: 2, size: 10, projectId: 'another-project', state: undefined },
            { page: 1, size: 10, projectId: 'another-project', state: 'FAILED' },
        ]);
        expect(h.snapshot.page).toBe(1);
        expect(h.snapshot.state).toBe('FAILED');
        expect(h.snapshot.updatedAt).toEqual(expect.any(String));
    });

    it('Старый poll не перезаписывает ручное обновление и не скрывает его индикатор', async () => {
        const h = harness();
        const previous = deferred<IOperationPage>();
        const current = deferred<IOperationPage>();
        h.readList.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
        const poll = h.controller.reload();
        const manual = h.controller.reload();
        previous.resolve(page([operation('old')]));
        await poll;
        expect(h.snapshot.list).toEqual([]);
        expect(h.snapshot.loading).toBe(true);
        current.resolve(page([operation('fresh')]));
        await manual;
        expect(h.snapshot.list.map(item => item.operationId)).toEqual(['fresh']);
        expect(h.snapshot.loading).toBe(false);
    });

    it('Поздняя ошибка списка не заменяет свежий результат', async () => {
        const h = harness();
        const previous = deferred<IOperationPage>();
        h.readList.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(page([operation('fresh')]));
        const poll = h.controller.reload();
        await h.controller.reload();
        previous.reject(new Error('Старое соединение оборвалось'));
        await poll;
        expect(h.snapshot.error).toBe('');
        expect(h.snapshot.list[0].operationId).toBe('fresh');
    });

    it('Смена фильтра закрывает детали и игнорирует ответы предыдущего фильтра', async () => {
        const h = harness();
        const previousList = deferred<IOperationPage>();
        const previousDetail = deferred<IOperationDetail>();
        h.readList.mockReturnValueOnce(previousList.promise).mockResolvedValueOnce(page([operation('failed', { state: 'FAILED' })]));
        h.readDetail.mockReturnValueOnce(previousDetail.promise);
        const list = h.controller.reload();
        const selected = h.controller.select('old');
        await h.controller.setState('FAILED');
        previousList.resolve(page([operation('old')]));
        previousDetail.resolve(detail('old'));
        await Promise.all([list, selected]);
        expect(h.snapshot.list[0].operationId).toBe('failed');
        expect(h.snapshot.selectedId).toBe('');
        expect(h.snapshot.selected).toBeNull();
        expect(h.snapshot.detailLoading).toBe(false);
    });

    it('Сброс статуса возвращает полный список без дополнительного запроса счётчика', async () => {
        const h = harness();
        h.readList.mockResolvedValue(page([]));
        await h.controller.setState('SUCCEEDED');
        await h.controller.setState();
        expect(h.readList).toHaveBeenCalledTimes(2);
        expect(h.readList).toHaveBeenLastCalledWith({ page: 1, size: 10, projectId: undefined, state: undefined });
        expect(h.snapshot.state).toBeUndefined();
    });

    it('При уменьшении количества операций загружает последнюю существующую страницу', async () => {
        const h = harness();
        h.readList.mockResolvedValueOnce(page([], 11)).mockResolvedValueOnce(page([operation('last')], 11));
        await h.controller.setPage(4);
        expect(h.readList.mock.calls.map(([params]) => params.page)).toEqual([4, 2]);
        expect(h.snapshot.page).toBe(2);
        expect(h.snapshot.list[0].operationId).toBe('last');
        expect(h.snapshot.loading).toBe(false);
    });

    it('Ошибка фона сохраняет ранее показанные строки и время успешного чтения', async () => {
        const h = harness();
        h.readList.mockResolvedValueOnce(page([operation('known')])).mockRejectedValueOnce(new Error('Сеть недоступна'));
        await h.controller.reload();
        const updatedAt = h.snapshot.updatedAt;
        await h.controller.reload();
        expect(h.snapshot.list[0].operationId).toBe('known');
        expect(h.snapshot.updatedAt).toBe(updatedAt);
        expect(h.snapshot.total).toBe(1);
        expect(h.snapshot.error).toBe('Сеть недоступна');
        expect(h.snapshot.loading).toBe(false);
    });

    it('Ответ ранее выбранной операции не заменяет текущие подробности', async () => {
        const h = harness();
        const previous = deferred<IOperationDetail>();
        h.readDetail.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(detail('current'));
        const first = h.controller.select('previous');
        await h.controller.select('current');
        previous.resolve(detail('previous'));
        await first;
        expect(h.snapshot.selectedId).toBe('current');
        expect(h.snapshot.selected?.operationId).toBe('current');
        expect(h.snapshot.detailLoading).toBe(false);
    });

    it('Закрытие деталей запрещает их позднее открытие и чтение до нового выбора', async () => {
        const h = harness();
        const pending = deferred<IOperationDetail>();
        h.readDetail.mockReturnValueOnce(pending.promise);
        const selected = h.controller.select('closing');
        h.controller.close();
        pending.reject(new Error('Поздний отказ'));
        await selected;
        await h.controller.refreshDetail();
        expect(h.snapshot.selectedId).toBe('');
        expect(h.snapshot.selected).toBeNull();
        expect(h.snapshot.detailError).toBe('');
        expect(h.readDetail).toHaveBeenCalledTimes(1);
    });

    it('При ошибке обновления деталей оставляет журнал и показывает причину', async () => {
        const h = harness();
        h.readDetail.mockResolvedValueOnce(detail('known')).mockRejectedValueOnce(new Error('Не удалось обновить журнал'));
        await h.controller.select('known');
        await h.controller.refreshDetail();
        expect(h.snapshot.selected?.operationId).toBe('known');
        expect(h.snapshot.detailError).toBe('Не удалось обновить журнал');
        expect(h.snapshot.detailLoading).toBe(false);
    });

    it('Запоздалое обновление деталей не отменяет свежую ошибку или новый журнал', async () => {
        const h = harness();
        const previous = deferred<IOperationDetail>();
        h.readDetail.mockResolvedValueOnce(detail('known')).mockReturnValueOnce(previous.promise)
            .mockResolvedValueOnce(detail('known', { percent: 90 }));
        await h.controller.select('known');
        const poll = h.controller.refreshDetail();
        await h.controller.refreshDetail();
        previous.reject(new Error('Старый запрос'));
        await poll;
        expect(h.snapshot.selected?.percent).toBe(90);
        expect(h.snapshot.detailError).toBe('');
    });

    it('Размонтирование запрещает обновления и новые запросы', async () => {
        const h = harness();
        const pendingList = deferred<IOperationPage>();
        const pendingDetail = deferred<IOperationDetail>();
        h.readList.mockReturnValueOnce(pendingList.promise);
        h.readDetail.mockReturnValueOnce(pendingDetail.promise);
        const list = h.controller.reload();
        const selected = h.controller.select('old');
        h.controller.dispose();
        h.onChange.mockClear();
        pendingList.resolve(page([operation('old')]));
        pendingDetail.resolve(detail('old'));
        await Promise.all([list, selected]);
        await h.controller.reload();
        await h.controller.refreshDetail();
        await h.controller.setPage(2);
        await h.controller.setState('FAILED');
        await h.controller.select('other');
        h.controller.close();
        expect(h.onChange).not.toHaveBeenCalled();
        expect(h.readList).toHaveBeenCalledTimes(1);
        expect(h.readDetail).toHaveBeenCalledTimes(1);
    });

    it('Новый владелец начинает с пустого состояния и не принимает старые ответы', async () => {
        const h = harness();
        const previous = deferred<IOperationPage>();
        h.readList.mockResolvedValueOnce(page([operation('known')])).mockReturnValueOnce(previous.promise)
            .mockResolvedValueOnce(page([operation('new-owner')]));
        await h.controller.reload();
        const poll = h.controller.reload();
        h.controller.dispose();
        h.controller.activate();
        expect(h.snapshot).toEqual(initialOperationsQueueSnapshot());
        await h.controller.reload();
        previous.resolve(page([operation('previous-owner')]));
        await poll;
        expect(h.snapshot.list[0].operationId).toBe('new-owner');
    });

    it('До активации не читает API и не публикует данные', async () => {
        const readList = vi.fn();
        const readDetail = vi.fn();
        const onChange = vi.fn();
        const controller = createOperationsQueueController({ readList, readDetail, onChange });
        await controller.reload();
        await controller.select('id');
        await controller.setState('FAILED');
        expect(readList).not.toHaveBeenCalled();
        expect(readDetail).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });
});
