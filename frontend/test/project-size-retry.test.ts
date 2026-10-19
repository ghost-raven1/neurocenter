import { configureStore } from '@reduxjs/toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bffApi from '../src/core/api/bff';
import type { IPage, IProjectDetail } from '../src/core/api/interfaces';
import type { IAuthMe } from '../src/core/interfaces';
import { authInit, authSwitchRole } from '../src/features/UserBlock/redux/actions';
import { fetchProject, fetchProjects } from '../src/modules/Projects/redux/actions';
import projectsReducer, { setPage, setQuery } from '../src/modules/Projects/redux/reducers';

const auth: IAuthMe = { user: { id: 'one', email: 'one@example.test', principalName: 'one', displayName: 'Первый', activeRole: 'Разработчик', userRoles: ['Разработчик', 'Наблюдатель'], routePermissions: ['projects'], projectRoles: [] }, policies: { projects: ['read'] } };
const project: IProjectDetail = {
    id: 'a', name: 'Проект A', externalResourceId: 'resource', fsRootPath: '/projects/a', state: 'ACTIVE', head: null,
    logicalBytes: null, logicalSizeError: 'Файлы временно недоступны.', retainedBytes: null, retainedSizeError: 'Сервис временно недоступен.',
    retention: 30, activeProfileId: null, activeProfileRevision: 0, activeOperations: 2, createdAt: '2026-10-19T00:00:00Z',
    quota: { currentBytesLimit: 1000, currentBytesUsed: null, retentionBytesLimit: 2000, retentionBytesUsed: null, stagingBytesLimit: 1000, stagingBytesUsed: 0 },
};
const healthy: IProjectDetail = { ...project, logicalBytes: 42, logicalSizeError: undefined, retainedBytes: 0, retainedSizeError: undefined,
    quota: { ...project.quota, currentBytesUsed: 42, retentionBytesUsed: 0 } };
const params = { page: 3, size: 10, query: 'Проект' };
const page = (item: IProjectDetail): IPage<IProjectDetail> => ({ ...params, items: [item], total: 40 });
function createStore() {
    const store = configureStore({ reducer: { projects: projectsReducer } });
    store.dispatch(authInit.pending('auth', undefined)); store.dispatch(authInit.fulfilled(auth, 'auth', undefined));
    store.dispatch(setQuery(params.query)); store.dispatch(setPage(params.page)); return store;
}
afterEach(() => { vi.restoreAllMocks(); });

for (const kind of ['list', 'detail'] as const) {
    describe(`Повтор измерения с настоящим thunk/reducer: ${kind}`, () => {
        it('Сохраняет контекст проекта при unknown и снимает обе причины после здорового повтора', async () => {
            const store = createStore();
            const read = kind === 'list' ? vi.spyOn(bffApi, 'listProjects').mockResolvedValueOnce(page(project)).mockResolvedValueOnce(page(healthy))
                : vi.spyOn(bffApi, 'getProject').mockResolvedValueOnce(project).mockResolvedValueOnce(healthy);
            const load = () => kind === 'list' ? store.dispatch(fetchProjects(params)) : store.dispatch(fetchProject('a'));
            const current = () => kind === 'list' ? store.getState().projects.list[0] : store.getState().projects.selected;
            await load(); expect(current()).toMatchObject({ id: 'a', activeOperations: 2, logicalBytes: null, retainedBytes: null });
            await load(); expect(current()).toMatchObject({ id: 'a', activeOperations: 2, logicalBytes: 42, retainedBytes: 0 });
            expect(current()?.logicalSizeError).toBeUndefined(); expect(current()?.retainedSizeError).toBeUndefined();
            expect(store.getState().projects).toMatchObject({ page: 3, size: 10, query: 'Проект' });
            expect(read).toHaveBeenNthCalledWith(2, kind === 'list' ? params : 'a');
        });
        it('Новый отказ измерения заменяет число на unknown, не убирая сам проект', async () => {
            const store = createStore();
            if (kind === 'list') {
                vi.spyOn(bffApi, 'listProjects').mockResolvedValueOnce(page(healthy)).mockResolvedValueOnce(page(project));
                await store.dispatch(fetchProjects(params)); await store.dispatch(fetchProjects(params));
                expect(store.getState().projects.list[0]).toMatchObject({ id: 'a', retainedBytes: null, logicalBytes: null });
            } else {
                vi.spyOn(bffApi, 'getProject').mockResolvedValueOnce(healthy).mockResolvedValueOnce(project);
                await store.dispatch(fetchProject('a')); await store.dispatch(fetchProject('a'));
                expect(store.getState().projects.selected).toMatchObject({ id: 'a', retainedBytes: null, logicalBytes: null });
                expect(store.getState().projects.selected?.quota).toMatchObject({ currentBytesUsed: null, retentionBytesUsed: null });
            }
        });
        it('Поздний healthy-ответ прежнего владельца не возвращает закрытые данные', async () => {
            const store = createStore(); let resolve!: (value: IProjectDetail) => void;
            const pending = new Promise<IProjectDetail>(done => { resolve = done; });
            if (kind === 'list') vi.spyOn(bffApi, 'listProjects').mockImplementation(() => pending.then(page));
            else vi.spyOn(bffApi, 'getProject').mockReturnValue(pending);
            const request = kind === 'list' ? store.dispatch(fetchProjects(params)) : store.dispatch(fetchProject('a'));
            store.dispatch(authSwitchRole.pending('role', 'Наблюдатель'));
            store.dispatch(authSwitchRole.fulfilled({ ...auth, user: { ...auth.user, activeRole: 'Наблюдатель' } }, 'role', 'Наблюдатель'));
            resolve(healthy); await request;
            expect(store.getState().projects).toMatchObject({ list: [], selected: null, page: 3, query: 'Проект' });
        });
    });
}
