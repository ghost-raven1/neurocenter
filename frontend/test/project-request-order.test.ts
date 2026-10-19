import { describe, expect, it } from 'vitest';
import type { UnknownAction } from '@reduxjs/toolkit';

import type { IAuthMe } from '../src/core/interfaces';
import type { IImageVersion, IProjectDetail, IProjectListParams } from '../src/core/api/interfaces';
import { authInit, authLogout, authSwitchRole } from '../src/features/UserBlock/redux/actions';
import { signOut } from '../src/features/UserBlock/redux/reducers';
import { fetchProject, fetchProjects, fetchVersions } from '../src/modules/Projects/redux/actions';
import projectsReducer, { clearSelected, setPage, setQuery } from '../src/modules/Projects/redux/reducers';
import { fetchRag } from '../src/modules/Rag/redux/actions';
import ragReducer, { clearRag } from '../src/modules/Rag/redux/reducers';

const auth: IAuthMe = {
    user: {
        id: 'user-one', principalName: 'one', email: 'one@example.test', displayName: 'Первый',
        activeRole: 'Разработчик', userRoles: ['Разработчик', 'Наблюдатель'],
        routePermissions: ['projects', 'rag'],
        projectRoles: [{ projectId: 'a', projectName: 'Первый проект', role: 'Разработчик' }],
    },
    policies: { projects: ['read', 'write'], rag: ['read'] },
};
const params: IProjectListParams = { page: 1, size: 10, query: '' };
const project = (id: string): IProjectDetail => ({
    id, name: `Проект ${id}`, externalResourceId: '', fsRootPath: '', state: 'ACTIVE', head: null,
    logicalBytes: 0, retainedBytes: 0, retention: 30, activeProfileId: null, activeProfileRevision: 0,
    activeOperations: 0, createdAt: '2026-10-18T00:00:00Z',
    quota: { currentBytesLimit: 100, currentBytesUsed: 0, retentionBytesLimit: 100, retentionBytesUsed: 0, stagingBytesLimit: 100, stagingBytesUsed: 0 },
});
const version = (snapshotId: string): IImageVersion => ({
    snapshotId, storeId: 'store', parentId: null, status: 'VERIFIED', author: 'Первый',
    createdAt: '2026-10-18T00:00:00Z', bytes: 0, formatVersion: '1', isHead: false, pinned: false,
});
const ragSummary = (projectKey: string) => ({ projectKey, rowCount: 1, lastSyncedAt: null, dimension: 3 });
const signedIn = [authInit.pending('login', undefined), authInit.fulfilled(auth, 'login', undefined)];

function projects(...actions: UnknownAction[]) {
    return [...signedIn, ...actions].reduce(projectsReducer, projectsReducer(undefined, { type: 'init' }));
}

function rag(...actions: UnknownAction[]) {
    return [...signedIn, ...actions].reduce(ragReducer, ragReducer(undefined, { type: 'init' }));
}

describe('Владелец запроса проекта', () => {
    it('Быстрый переход сохраняет новую карточку после запоздавшего ответа предыдущей', () => {
        const state = projects(
            fetchProject.pending('first', 'a'), fetchProject.pending('second', 'b'),
            fetchProject.fulfilled(project('b'), 'second', 'b'),
            fetchProject.fulfilled(project('a'), 'first', 'a'),
        );
        expect(state.selected?.id).toBe('b');
        expect(state.selectedLoading).toBe(false);
    });

    it('Ошибка старого запроса не убирает индикатор новой карточки', () => {
        const state = projects(
            fetchProject.pending('first', 'a'), fetchProject.pending('second', 'b'),
            fetchProject.rejected(new Error('404'), 'first', 'a'),
        );
        expect(state.selectedLoading).toBe(true);
        expect(state.selected).toBeNull();
    });

    it('Обновление по сокету сохраняет видимую карточку и принимает только последнюю версию', () => {
        let state = projects(fetchProject.pending('initial', 'a'), fetchProject.fulfilled(project('a'), 'initial', 'a'));
        state = projectsReducer(state, fetchProject.pending('old-refresh', 'a'));
        expect(state.selected?.id).toBe('a');
        state = projectsReducer(state, fetchProject.pending('new-refresh', 'a'));
        state = projectsReducer(state, fetchProject.fulfilled({ ...project('a'), logicalBytes: 20 }, 'new-refresh', 'a'));
        state = projectsReducer(state, fetchProject.fulfilled({ ...project('a'), logicalBytes: 10 }, 'old-refresh', 'a'));
        expect(state.selected?.logicalBytes).toBe(20);
    });

    it('Deep-link по имени не очищает уже загруженную карточку при обновлении', () => {
        const state = projects(
            fetchProject.pending('initial', 'Проект a'), fetchProject.fulfilled(project('a'), 'initial', 'Проект a'),
            fetchProject.pending('refresh', 'Проект a'),
        );
        expect(state.selected?.id).toBe('a');
        expect(state.selectedLoading).toBe(true);
    });

    it('Переход в другой проект очищает прежние версии и инвалидирует их поздний ответ', () => {
        const state = projects(
            fetchProject.pending('initial', 'a'), fetchProject.fulfilled(project('a'), 'initial', 'a'),
            fetchVersions.pending('versions', 'a'), fetchProject.pending('next', 'b'),
            fetchVersions.fulfilled([version('snapshot-a')], 'versions', 'a'),
        );
        expect(state.versions).toEqual([]);
        expect(state.versionsLoading).toBe(false);
    });

    it('Пересекающиеся запросы версий не подменяют выбранный проект и не выключают его загрузку', () => {
        let state = projects(fetchVersions.pending('a', 'a'), fetchVersions.pending('b', 'b'));
        state = projectsReducer(state, fetchVersions.rejected(new Error('Сбой'), 'a', 'a'));
        expect(state.versionsLoading).toBe(true);
        state = projectsReducer(state, fetchVersions.fulfilled([version('snapshot-b')], 'b', 'b'));
        state = projectsReducer(state, fetchVersions.fulfilled([version('snapshot-a')], 'a', 'a'));
        expect(state.versions.map(item => item.snapshotId)).toEqual(['snapshot-b']);
    });

    it('Уход со страницы отменяет владельцев карточки и версий, сохраняя список и фильтры', () => {
        const currentParams = { ...params, query: 'Проект', page: 2 };
        const state = projects(
            setQuery('Проект'), setPage(2),
            fetchProjects.pending('list', currentParams), fetchProjects.fulfilled({ ...currentParams, items: [project('a')], total: 1 }, 'list', currentParams),
            fetchProject.pending('detail', 'a'), fetchVersions.pending('versions', 'a'),
            clearSelected(), fetchProject.fulfilled(project('a'), 'detail', 'a'),
            fetchVersions.fulfilled([version('a')], 'versions', 'a'),
        );
        expect(state).toMatchObject({ selected: null, versions: [], page: 2, query: 'Проект' });
        expect(state.list.map(item => item.id)).toEqual(['a']);
    });
});

describe('Поиск и пагинация проектов', () => {
    it('Изменение поиска блокирует прежний результат ещё до запуска нового запроса', () => {
        const state = projects(
            fetchProjects.pending('old', params), setQuery('новый'),
            fetchProjects.fulfilled({ ...params, items: [project('old')], total: 99 }, 'old', params),
        );
        expect(state).toMatchObject({ query: 'новый', page: 1, list: [], total: 0 });
    });

    it('Смена страницы не позволяет старому обработчику обновления перехватить текущий список', () => {
        const next = { ...params, page: 2 };
        let state = projects(setPage(2), fetchProjects.pending('new', next), fetchProjects.pending('stale-callback', params));
        state = projectsReducer(state, fetchProjects.fulfilled({ ...next, items: [project('b')], total: 20 }, 'new', next));
        state = projectsReducer(state, fetchProjects.fulfilled({ ...params, items: [project('a')], total: 10 }, 'stale-callback', params));
        expect(state.page).toBe(2);
        expect(state.list.map(item => item.id)).toEqual(['b']);
        expect(state.total).toBe(20);
    });

    it('Старое обновление списка не завершает новую загрузку и не перезаписывает её результат', () => {
        let state = projects(fetchProjects.pending('old', params), fetchProjects.pending('new', params));
        state = projectsReducer(state, fetchProjects.rejected(new Error('Сбой'), 'old', params));
        expect(state.loading).toBe(true);
        state = projectsReducer(state, fetchProjects.fulfilled({ ...params, items: [project('b')], total: 1 }, 'new', params));
        state = projectsReducer(state, fetchProjects.fulfilled({ ...params, items: [project('a')], total: 1 }, 'old', params));
        expect(state.list.map(item => item.id)).toEqual(['b']);
    });
});

describe('Изоляция кэша по пользователю и правам', () => {
    const changes: Array<[string, IAuthMe]> = [
        ['пользователя', { ...auth, user: { ...auth.user, id: 'user-two' } }],
        ['активной роли', { ...auth, user: { ...auth.user, activeRole: 'Наблюдатель' } }],
        ['прав проекта при прежней роли', { ...auth, user: { ...auth.user, projectRoles: [] } }],
        ['политик при прежней роли', { ...auth, policies: { projects: ['read'] } }],
    ];

    it.each(changes)('Смена %s очищает данные и отклоняет ответы прежних запросов', (_, changed) => {
        const actions = [
            fetchProjects.pending('list', params), fetchProject.pending('detail', 'a'), fetchVersions.pending('versions', 'a'),
            authInit.pending('refresh', undefined), authInit.fulfilled(changed, 'refresh', undefined),
            fetchProjects.fulfilled({ ...params, items: [project('a')], total: 1 }, 'list', params),
            fetchProject.fulfilled(project('a'), 'detail', 'a'), fetchVersions.fulfilled([version('a')], 'versions', 'a'),
        ];
        expect(projects(...actions)).toMatchObject({ list: [], selected: null, versions: [], loading: false });
        const ragState = rag(
            fetchRag.pending('knowledge', undefined), authInit.pending('refresh', undefined),
            authInit.fulfilled(changed, 'refresh', undefined), fetchRag.fulfilled([ragSummary('a')], 'knowledge', undefined),
        );
        expect(ragState.list).toEqual([]);
    });

    it('Обычная проверка сессии с другим порядком прав сохраняет данные и текущую загрузку', () => {
        const reordered: IAuthMe = {
            user: { ...auth.user, routePermissions: [...auth.user.routePermissions].reverse(), userRoles: [...auth.user.userRoles].reverse() },
            policies: { rag: ['read'], projects: ['write', 'read'] },
        };
        const state = projects(
            setQuery('Проект'), fetchProject.pending('detail', 'a'), authInit.pending('refresh', undefined),
            authInit.fulfilled(reordered, 'refresh', undefined), fetchProject.fulfilled(project('a'), 'detail', 'a'),
        );
        expect(state.query).toBe('Проект');
        expect(state.selected?.id).toBe('a');
    });

    it('Поздний ответ проверки прежней роли не отменяет новую роль или её запросы', () => {
        const changed = { ...auth, user: { ...auth.user, activeRole: 'Наблюдатель' } };
        const state = projects(
            authInit.pending('old-auth', undefined), authSwitchRole.pending('role', 'Наблюдатель'),
            authSwitchRole.fulfilled(changed, 'role', 'Наблюдатель'), fetchProject.pending('new-data', 'a'),
            authInit.fulfilled(auth, 'old-auth', undefined), authInit.rejected(new Error('Сбой'), 'old-auth', undefined),
            fetchProject.fulfilled(project('a'), 'new-data', 'a'),
        );
        expect(state.selected?.id).toBe('a');
        expect(state.authScope).toContain('Наблюдатель');
    });

    it('Выход не позволяет поздней проверке сессии или новым старым обработчикам восстановить данные', () => {
        const actions = [
            authInit.pending('refresh', undefined), fetchProject.pending('detail', 'a'), signOut(),
            authInit.fulfilled(auth, 'refresh', undefined), fetchProject.fulfilled(project('a'), 'detail', 'a'),
            fetchProject.pending('late-callback', 'a'), fetchProject.fulfilled(project('a'), 'late-callback', 'a'),
        ];
        expect(projects(...actions)).toMatchObject({ selected: null, authScope: null, selectedLoading: false });
        expect(rag(
            authInit.pending('refresh', undefined), fetchRag.pending('data', undefined), signOut(),
            authInit.fulfilled(auth, 'refresh', undefined), fetchRag.fulfilled([ragSummary('a')], 'data', undefined),
            fetchRag.pending('late', undefined), fetchRag.fulfilled([ragSummary('a')], 'late', undefined),
        )).toMatchObject({ list: [], authScope: null, loading: false });
    });

    it('Неудачная смена роли и выход сохраняют действующую сессию, а успешный выход очищает кэш', () => {
        let state = projects(
            fetchProject.pending('data', 'a'), fetchProject.fulfilled(project('a'), 'data', 'a'),
            authSwitchRole.pending('role', 'Наблюдатель'), authSwitchRole.rejected(new Error('Сбой'), 'role', 'Наблюдатель'),
            authLogout.pending('logout', undefined), authLogout.rejected(new Error('Сбой'), 'logout', undefined),
        );
        expect(state.selected?.id).toBe('a');
        state = projectsReducer(state, authLogout.pending('retry', undefined));
        state = projectsReducer(state, authLogout.fulfilled({}, 'retry', undefined));
        expect(state.selected).toBeNull();
        expect(state.authScope).toBeNull();
    });

    it.each(['role', 'logout'])('Истёкшая сессия в текущем запросе %s очищает кэш и блокирует поздние данные', kind => {
        const rejection = kind === 'role'
            ? authSwitchRole.rejected(null, 'expired', 'Наблюдатель', 'unauthorized')
            : authLogout.rejected(null, 'expired', undefined, 'unauthorized');
        const pending = kind === 'role'
            ? authSwitchRole.pending('expired', 'Наблюдатель')
            : authLogout.pending('expired', undefined);
        expect(projects(
            fetchProject.pending('data', 'a'), pending, rejection,
            fetchProject.fulfilled(project('a'), 'data', 'a'),
        )).toMatchObject({ selected: null, authScope: null });
        expect(rag(
            fetchRag.pending('data', undefined), pending, rejection,
            fetchRag.fulfilled([ragSummary('a')], 'data', undefined),
        )).toMatchObject({ list: [], authScope: null });
    });
});

describe('Порядок загрузки баз знаний', () => {
    it('Запоздавшие ответ и ошибка не подменяют последнюю сводку', () => {
        let state = rag(fetchRag.pending('old', undefined), fetchRag.pending('new', undefined));
        state = ragReducer(state, fetchRag.rejected(new Error('Сбой'), 'old', undefined));
        expect(state.loading).toBe(true);
        state = ragReducer(state, fetchRag.fulfilled([ragSummary('b')], 'new', undefined));
        state = ragReducer(state, fetchRag.fulfilled([ragSummary('a')], 'old', undefined));
        expect(state.list.map(item => item.projectKey)).toEqual(['b']);
    });

    it('Уход со страницы не позволяет позднему ответу вернуть сводку', () => {
        const state = rag(fetchRag.pending('data', undefined), clearRag(), fetchRag.fulfilled([ragSummary('a')], 'data', undefined));
        expect(state.list).toEqual([]);
        expect(state.loading).toBe(false);
        expect(state.authScope).not.toBeNull();
    });

    it('Обычная проверка сессии не отменяет актуальную загрузку знаний', () => {
        const state = rag(
            fetchRag.pending('data', undefined), authInit.pending('refresh', undefined), authInit.fulfilled(auth, 'refresh', undefined),
            fetchRag.fulfilled([ragSummary('a')], 'data', undefined),
        );
        expect(state.list.map(item => item.projectKey)).toEqual(['a']);
    });
});
