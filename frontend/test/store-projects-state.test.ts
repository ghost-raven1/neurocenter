import { describe, expect, it, vi } from 'vitest';

import type { IPage, IProjectListParams, IProjectSummary } from '../src/core/api/interfaces';
import { createAvailableProjectsController, initialAvailableProjectsState } from '../src/modules/Projects/availableProjectsController';

const project = { id: 'prj-example', name: 'example' } as IProjectSummary;
const page = (items = [project]): IPage<IProjectSummary> => ({ items, page: 1, size: 100, total: items.length });

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function setup() {
    let scope = 'owner:developer';
    let state = initialAvailableProjectsState();
    const onChange = vi.fn((next: typeof state) => { state = next; });
    const readPage = vi.fn<(params: IProjectListParams) => Promise<IPage<IProjectSummary>>>().mockResolvedValue(page());
    const controller = createAvailableProjectsController({ getScope: () => scope, readPage, onChange });
    controller.activate();
    return { controller, readPage, onChange, state: () => state, setScope: (next: string) => { scope = next; } };
}

describe('Доступные проекты: загрузка, повтор и текущий владелец', () => {
    it('Начальная ошибка не становится успешным пустым списком, повтор восстанавливает проекты', async () => {
        const { controller, readPage, state } = setup();
        readPage.mockRejectedValueOnce(new Error('Сервис проектов недоступен'));
        await controller.refresh();
        expect(state()).toEqual({ projects: [], ready: false, loading: false, error: 'Сервис проектов недоступен' });
        await controller.refresh();
        expect(state()).toEqual({ projects: [project], ready: true, loading: false, error: '' });
    });

    it('Фоновая ошибка сохраняет известные проекты и сообщает, что обновление не состоялось', async () => {
        const { controller, readPage, state } = setup();
        await controller.refresh();
        readPage.mockRejectedValueOnce(new Error('Временная ошибка'));
        await controller.refresh();
        expect(state()).toMatchObject({ projects: [project], ready: true, loading: false, error: 'Временная ошибка' });
    });

    it('Фоновое чтение сохраняет готовый список для открытого выбора проекта', async () => {
        const { controller, readPage, state } = setup();
        await controller.refresh();
        const pending = deferred<IPage<IProjectSummary>>();
        readPage.mockReturnValueOnce(pending.promise);
        const request = controller.refresh();
        expect(state()).toEqual({ projects: [project], ready: true, loading: true, error: '' });
        pending.resolve(page());
        await request;
        expect(state().loading).toBe(false);
    });

    it.each([401, 403, 404])('Отказ %i очищает ранее доступные проекты, повтор восстанавливает список', async status => {
        const { controller, readPage, state } = setup();
        await controller.refresh();
        readPage.mockRejectedValueOnce({ isAxiosError: true, response: { status } });
        await controller.refresh();
        expect(state()).toMatchObject({ projects: [], ready: false, loading: false });
        expect(state().error).not.toBe('');
        await controller.refresh();
        expect(state()).toEqual({ projects: [project], ready: true, loading: false, error: '' });
    });

    it('Успешный пустой ответ отличается от недоступного сервиса', async () => {
        const { controller, readPage, state } = setup();
        readPage.mockResolvedValueOnce(page([]));
        await controller.refresh();
        expect(state()).toEqual({ projects: [], ready: true, loading: false, error: '' });
    });

    it('Новый ответ побеждает запоздалое фоновое обновление', async () => {
        const older = deferred<IPage<IProjectSummary>>();
        const newer = deferred<IPage<IProjectSummary>>();
        const { controller, readPage, state } = setup();
        readPage.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        const first = controller.refresh();
        const second = controller.refresh();
        const currentProject = { ...project, id: 'prj-new', name: 'new' };
        newer.resolve(page([currentProject]));
        await second;
        older.resolve(page());
        await first;
        expect(state().projects).toEqual([currentProject]);
        expect(state().error).toBe('');
    });

    it('Ошибка старого обновления не стирает более свежий успешный список', async () => {
        const older = deferred<IPage<IProjectSummary>>();
        const { controller, readPage, state } = setup();
        readPage.mockReturnValueOnce(older.promise);
        const first = controller.refresh();
        await controller.refresh();
        older.reject(new Error('Поздняя ошибка'));
        await first;
        expect(state()).toEqual({ projects: [project], ready: true, loading: false, error: '' });
    });

    it.each(['другой аккаунт', 'отозванная роль', 'новые политики'])('Старый ответ не публикуется при смене scope: %s', async scope => {
        const pending = deferred<IPage<IProjectSummary>>();
        const { controller, readPage, onChange, setScope } = setup();
        readPage.mockReturnValueOnce(pending.promise);
        const request = controller.refresh();
        const changes = onChange.mock.calls.length;
        // Изменение store замечается даже до React cleanup старого hook.
        setScope(scope);
        pending.resolve(page());
        await request;
        expect(onChange).toHaveBeenCalledTimes(changes);
        await controller.refresh();
        expect(readPage).toHaveBeenCalledOnce();
    });

    it('Размонтирование и повторная активация не принимают ответ предыдущего экземпляра', async () => {
        const older = deferred<IPage<IProjectSummary>>();
        const { controller, readPage, state } = setup();
        readPage.mockReturnValueOnce(older.promise);
        const previous = controller.refresh();
        controller.dispose();
        controller.activate();
        readPage.mockResolvedValueOnce(page([]));
        await controller.refresh();
        older.resolve(page());
        await previous;
        expect(state()).toEqual({ projects: [], ready: true, loading: false, error: '' });
    });

    it('Собирает страницы атомарно и не подменяет старый список неполной новой страницей', async () => {
        const { controller, readPage, state } = setup();
        await controller.refresh();
        const first = { ...project, id: 'prj-one' };
        const second = { ...project, id: 'prj-two' };
        readPage.mockResolvedValueOnce({ items: [first], page: 1, size: 1, total: 2 })
            .mockRejectedValueOnce(new Error('Вторая страница недоступна'));
        await controller.refresh();
        expect(state().projects).toEqual([project]);
        readPage.mockResolvedValueOnce({ items: [first], page: 1, size: 1, total: 2 })
            .mockResolvedValueOnce({ items: [second], page: 2, size: 1, total: 2 });
        await controller.refresh();
        expect(state().projects).toEqual([first, second]);
        expect(readPage).toHaveBeenLastCalledWith({ page: 2, size: 100 });
    });

    it('Не запрашивает следующую страницу после смены прав', async () => {
        const pending = deferred<IPage<IProjectSummary>>();
        const { controller, readPage, setScope } = setup();
        readPage.mockReturnValueOnce(pending.promise);
        const request = controller.refresh();
        setScope('owner:observer');
        pending.resolve({ items: [project], page: 1, size: 1, total: 2 });
        await request;
        expect(readPage).toHaveBeenCalledOnce();
    });
});
