import { configureStore } from '@reduxjs/toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bffApi from '../src/core/api/bff';
import type { IPage, IProjectSummary } from '../src/core/api/interfaces';
import type { IAuthMe } from '../src/core/interfaces';
import { authInit } from '../src/features/UserBlock/redux/actions';
import { signOut } from '../src/features/UserBlock/redux/reducers';
import { fetchProjects } from '../src/modules/Projects/redux/actions';
import projectsReducer, { setPage, setQuery } from '../src/modules/Projects/redux/reducers';

const auth: IAuthMe = { user: { id: 'one', email: 'one@example.test', principalName: 'one', displayName: 'Первый', activeRole: 'Разработчик', userRoles: ['Разработчик'], routePermissions: ['projects'], projectRoles: [] }, policies: { projects: ['read'] } };
const project: IProjectSummary = { id: 'project', name: 'Проект', externalResourceId: '', fsRootPath: '', state: 'ACTIVE', head: null, logicalBytes: 0, retainedBytes: 0, retention: 30, activeProfileId: null, activeProfileRevision: 0, activeOperations: 0 };
const params = { page: 1, size: 10, query: '' };
const page: IPage<IProjectSummary> = { ...params, items: [project], total: 40 };
const httpError = (status: number) => ({ isAxiosError: true, response: { status } });
function createStore() {
    const store = configureStore({ reducer: { projects: projectsReducer } });
    store.dispatch(authInit.pending('login', undefined));
    store.dispatch(authInit.fulfilled(auth, 'login', undefined));
    return store;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('Достоверная ошибка списка проектов', () => {
    it('Отличает отказ сервера от пустого каталога и допускает успешный повтор', async () => {
        vi.spyOn(bffApi, 'listProjects').mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(page);
        const store = createStore();
        await store.dispatch(fetchProjects(params));
        expect(store.getState().projects.listError).toEqual({ status: 503, message: 'Сервер не смог загрузить список проектов. Попробуйте ещё раз.' });
        expect(store.getState().projects.loading).toBe(false);
        await store.dispatch(fetchProjects(params));
        expect(store.getState().projects.list).toEqual([project]);
        expect(store.getState().projects.listError).toBeNull();
    });
    it('Временный отказ обновления сохраняет известные данные с явной ошибкой', async () => {
        vi.spyOn(bffApi, 'listProjects').mockResolvedValueOnce(page).mockRejectedValueOnce(new Error('Network Error'));
        const store = createStore();
        await store.dispatch(fetchProjects(params));
        await store.dispatch(fetchProjects(params));
        expect(store.getState().projects.list).toEqual([project]);
        expect(store.getState().projects.listError?.message).toContain('Проверьте соединение');
    });
    it('Новый поиск не выдаёт строки прежнего запроса после сбоя', async () => {
        vi.spyOn(bffApi, 'listProjects').mockResolvedValueOnce(page).mockRejectedValueOnce(httpError(503));
        const store = createStore();
        await store.dispatch(fetchProjects(params));
        store.dispatch(setQuery('другой'));
        await store.dispatch(fetchProjects({ ...params, query: 'другой' }));
        expect(store.getState().projects.list).toEqual([]);
        expect(store.getState().projects.total).toBe(0);
        expect(store.getState().projects.listError?.status).toBe(503);
    });
    it('Смена страницы убирает старые строки, сохраняя известное число страниц', async () => {
        vi.spyOn(bffApi, 'listProjects').mockResolvedValue(page);
        const store = createStore();
        await store.dispatch(fetchProjects(params));
        store.dispatch(setPage(2));
        expect(store.getState().projects.list).toEqual([]);
        expect(store.getState().projects.total).toBe(40);
    });
    it('Отзыв доступа очищает данные, а выход очищает ошибку', async () => {
        vi.spyOn(bffApi, 'listProjects').mockResolvedValueOnce(page).mockRejectedValueOnce(httpError(403));
        const store = createStore();
        await store.dispatch(fetchProjects(params));
        await store.dispatch(fetchProjects(params));
        expect(store.getState().projects.list).toEqual([]);
        expect(store.getState().projects.listError?.status).toBe(403);
        store.dispatch(signOut());
        expect(store.getState().projects.listError).toBeNull();
    });
    it('Поздняя ошибка старого запроса не перекрывает новый успешный список', async () => {
        const old = deferred<IPage<IProjectSummary>>();
        vi.spyOn(bffApi, 'listProjects').mockReturnValueOnce(old.promise).mockResolvedValueOnce(page);
        const store = createStore();
        const first = store.dispatch(fetchProjects(params));
        await store.dispatch(fetchProjects(params));
        old.reject(httpError(503));
        await first;
        expect(store.getState().projects.list).toEqual([project]);
        expect(store.getState().projects.listError).toBeNull();
    });
});
