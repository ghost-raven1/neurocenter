import { configureStore } from '@reduxjs/toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import bffApi from '../src/core/api/bff';
import type { IRagProjectSummary } from '../src/core/api/interfaces';
import type { IAuthMe } from '../src/core/interfaces';
import { authInit } from '../src/features/UserBlock/redux/actions';
import { signOut } from '../src/features/UserBlock/redux/reducers';
import { fetchRag } from '../src/modules/Rag/redux/actions';
import ragReducer from '../src/modules/Rag/redux/reducers';

const auth: IAuthMe = { user: { id: 'one', email: 'one@example.test', principalName: 'one', displayName: 'Первый', activeRole: 'Разработчик', userRoles: ['Разработчик'], routePermissions: ['rag'], projectRoles: [] }, policies: { rag: ['read'] } };
const summary: IRagProjectSummary = { projectKey: 'prj-qa', rowCount: 1, lastSyncedAt: null, dimension: 3 };
const httpError = (status: number) => ({ isAxiosError: true, response: { status } });

function createStore() {
    const store = configureStore({ reducer: { rag: ragReducer } });
    store.dispatch(authInit.pending('login', undefined));
    store.dispatch(authInit.fulfilled(auth, 'login', undefined));
    return store;
}

afterEach(() => vi.restoreAllMocks());

describe('Ошибка общего списка баз знаний', () => {
    it('Сетевой отказ отличается от успешного пустого ответа, повтор снимает ошибку', async () => {
        vi.spyOn(bffApi, 'listRagProjects').mockRejectedValueOnce(new Error('Network Error')).mockResolvedValueOnce([]);
        const store = createStore();
        await store.dispatch(fetchRag());
        expect(store.getState().rag.listError?.message).toContain('Проверьте соединение');
        expect(store.getState().rag.loading).toBe(false);
        await store.dispatch(fetchRag());
        expect(store.getState().rag.list).toEqual([]);
        expect(store.getState().rag.listError).toBeNull();
    });

    it('Сбой обновления сохраняет предыдущие данные вместе с предупреждением', async () => {
        vi.spyOn(bffApi, 'listRagProjects').mockResolvedValueOnce([summary]).mockRejectedValueOnce(httpError(503));
        const store = createStore();
        await store.dispatch(fetchRag());
        await store.dispatch(fetchRag());
        expect(store.getState().rag.list).toEqual([summary]);
        expect(store.getState().rag.listError?.status).toBe(503);
    });

    it('Отказ в доступе очищает старые данные, выход очищает ошибку', async () => {
        vi.spyOn(bffApi, 'listRagProjects').mockResolvedValueOnce([summary]).mockRejectedValueOnce(httpError(403));
        const store = createStore();
        await store.dispatch(fetchRag());
        await store.dispatch(fetchRag());
        expect(store.getState().rag.list).toEqual([]);
        expect(store.getState().rag.listError?.status).toBe(403);
        store.dispatch(signOut());
        expect(store.getState().rag.listError).toBeNull();
    });

    it('Поздний отказ не перекрывает результат более нового запроса', async () => {
        let reject!: (error: unknown) => void;
        const previous = new Promise<IRagProjectSummary[]>((_, fail) => { reject = fail; });
        vi.spyOn(bffApi, 'listRagProjects').mockReturnValueOnce(previous).mockResolvedValueOnce([summary]);
        const store = createStore();
        const first = store.dispatch(fetchRag());
        await store.dispatch(fetchRag());
        reject(httpError(503));
        await first;
        expect(store.getState().rag.list).toEqual([summary]);
        expect(store.getState().rag.listError).toBeNull();
    });
});
