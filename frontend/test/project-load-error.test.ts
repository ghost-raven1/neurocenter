import { configureStore } from '@reduxjs/toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import bffApi from '../src/core/api/bff';
import type { IProjectDetail } from '../src/core/api/interfaces';
import type { IAuthMe } from '../src/core/interfaces';
import { authInit } from '../src/features/UserBlock/redux/actions';
import { signOut } from '../src/features/UserBlock/redux/reducers';
import { fetchProject } from '../src/modules/Projects/redux/actions';
import projectsReducer, { clearSelected } from '../src/modules/Projects/redux/reducers';

const auth: IAuthMe = {
    user: {
        id: 'one', email: 'one@example.test', principalName: 'one', displayName: 'Первый',
        activeRole: 'Разработчик', userRoles: ['Разработчик'], routePermissions: ['projects'], projectRoles: [],
    },
    policies: { projects: ['read'] },
};
const project: IProjectDetail = {
    id: 'a', name: 'Первый проект', externalResourceId: '', fsRootPath: '', state: 'ACTIVE', head: null,
    logicalBytes: 10, retainedBytes: 0, retention: 30, activeProfileId: null, activeProfileRevision: 0,
    activeOperations: 0, createdAt: '2026-10-18T00:00:00Z',
    quota: { currentBytesLimit: 100, currentBytesUsed: 10, retentionBytesLimit: 100, retentionBytesUsed: 0, stagingBytesLimit: 100, stagingBytesUsed: 0 },
};

function createStore() {
    const store = configureStore({ reducer: { projects: projectsReducer } });
    store.dispatch(authInit.pending('login', undefined));
    store.dispatch(authInit.fulfilled(auth, 'login', undefined));
    return store;
}

function httpError(status: number) {
    return { isAxiosError: true, response: { status, data: { message: 'Internal server error' } } };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    return { promise, resolve, reject };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Достоверная ошибка загрузки проекта', () => {
    it.each([
        [404, 'Проект удалён или ссылка больше не действует.'],
        [403, 'У вас нет доступа к этому проекту. Обратитесь к администратору.'],
        [503, 'Сервер не смог загрузить проект. Попробуйте ещё раз.'],
        [null, 'Не удалось связаться с сервером. Проверьте соединение и повторите загрузку.'],
    ] as const)('Реальный thunk сохраняет статус %s и понятное сообщение', async (status, message) => {
        vi.spyOn(bffApi, 'getProject').mockRejectedValue(status === null ? new Error('Network Error') : httpError(status));
        const store = createStore();
        const result = await store.dispatch(fetchProject('a'));
        expect(fetchProject.rejected.match(result)).toBe(true);
        expect(result.payload).toEqual({ status, message });
        expect(store.getState().projects.selectedError).toEqual({ status, message });
        expect(store.getState().projects.selectedLoading).toBe(false);
    });

    it.each([403, 404])('Ответ %s убирает ранее открытую карточку', async status => {
        vi.spyOn(bffApi, 'getProject').mockResolvedValueOnce(project).mockRejectedValueOnce(httpError(status));
        const store = createStore();
        await store.dispatch(fetchProject('a'));
        await store.dispatch(fetchProject('a'));
        expect(store.getState().projects.selected).toBeNull();
        expect(store.getState().projects.selectedId).toBe('a');
        expect(store.getState().projects.selectedError?.status).toBe(status);
    });

    it.each([null, 500])('Временный сбой %s сохраняет открытую карточку и допускает успешный повтор', async status => {
        const retry = deferred<IProjectDetail>();
        vi.spyOn(bffApi, 'getProject')
            .mockResolvedValueOnce(project)
            .mockRejectedValueOnce(status === null ? new Error('Network Error') : httpError(status))
            .mockReturnValueOnce(retry.promise);
        const store = createStore();
        await store.dispatch(fetchProject('a'));
        await store.dispatch(fetchProject('a'));
        expect(store.getState().projects.selected?.logicalBytes).toBe(10);
        expect(store.getState().projects.selectedError?.status).toBe(status);

        const loading = store.dispatch(fetchProject('a'));
        expect(store.getState().projects.selectedError).toBeNull();
        expect(store.getState().projects.selectedLoading).toBe(true);
        retry.resolve({ ...project, logicalBytes: 20 });
        await loading;
        expect(store.getState().projects.selected?.logicalBytes).toBe(20);
        expect(store.getState().projects.selectedError).toBeNull();
    });

    it('Поздний отказ старой карточки не превращает новый успешный переход в ошибку', async () => {
        const old = deferred<IProjectDetail>();
        const current = deferred<IProjectDetail>();
        vi.spyOn(bffApi, 'getProject').mockImplementation(id => id === 'a' ? old.promise : current.promise);
        const store = createStore();
        const first = store.dispatch(fetchProject('a'));
        const second = store.dispatch(fetchProject('b'));
        current.resolve({ ...project, id: 'b' });
        await second;
        old.reject(httpError(404));
        await first;
        expect(store.getState().projects.selected?.id).toBe('b');
        expect(store.getState().projects.selectedError).toBeNull();
    });

    it('Уход со страницы и завершение сессии очищают ошибку прежнего проекта', async () => {
        vi.spyOn(bffApi, 'getProject').mockRejectedValue(httpError(404));
        const store = createStore();
        await store.dispatch(fetchProject('a'));
        store.dispatch(clearSelected());
        expect(store.getState().projects.selectedError).toBeNull();
        await store.dispatch(fetchProject('a'));
        store.dispatch(signOut());
        expect(store.getState().projects.selectedError).toBeNull();
    });
});
