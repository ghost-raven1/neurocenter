import { describe, expect, it } from 'vitest';
import type { UnknownAction } from '@reduxjs/toolkit';

import type { IAuthMe } from '../src/core/interfaces';
import { authInit, authLogout, authSwitchRole } from '../src/features/UserBlock/redux/actions';
import { signOut } from '../src/features/UserBlock/redux/reducers';
import { fetchBackup, fetchStorage } from '../src/modules/Maintenance/redux/actions';
import reducer from '../src/modules/Maintenance/redux/reducers';

const auth: IAuthMe = {
    user: {
        id: 'one', email: 'one@example.test', principalName: 'one', displayName: 'Первый',
        activeRole: 'Главный админ', userRoles: ['Главный админ', 'Администратор'],
        routePermissions: ['maintenance', 'projects'], projectRoles: [],
    },
    policies: { maintenance: ['read', 'write'], projects: ['read'] },
};
const storage = { totalBytesUsed: 100, totalBytesLimit: 0, stagingBytesBudget: 0, buckets: [] };
const backup = { lastBackupAt: '2026-10-18T00:00:00Z', backupLagSeconds: 0, restoreDrills: [] };
const initialAuth = [authInit.pending('login', undefined), authInit.fulfilled(auth, 'login', undefined)];
const requests = [fetchStorage.pending('storage', undefined), fetchBackup.pending('backup', undefined)];
const responses = [fetchStorage.fulfilled(storage, 'storage', undefined), fetchBackup.fulfilled(backup, 'backup', undefined)];
function apply(...actions: UnknownAction[]) {
    return [...initialAuth, ...actions].reduce(reducer, reducer(undefined, { type: 'init' }));
}

describe('Владелец сводок обслуживания', () => {
    it('Выход отбрасывает поздний ответ и новые вызовы прежних обработчиков', () => {
        const state = apply(...requests, signOut(), ...responses,
            fetchStorage.pending('late', undefined), fetchStorage.fulfilled(storage, 'late', undefined));
        expect(state).toMatchObject({ storage: null, backup: null, authScope: null, storageLoading: false, backupLoading: false });
    });

    it('Успешный logout не позволяет позднему GET вернуть сведения', () => {
        const state = apply(...requests, authLogout.pending('out', undefined), authLogout.fulfilled({}, 'out', undefined), ...responses);
        expect(state).toMatchObject({ storage: null, backup: null, authScope: null });
    });

    it.each([
        ['аккаунта', { ...auth, user: { ...auth.user, id: 'two', email: 'two@example.test' } }],
        ['роли', { ...auth, user: { ...auth.user, activeRole: 'Администратор' } }],
        ['политик при прежней роли', { ...auth, policies: { maintenance: ['read'] } }],
    ])('Смена %s очищает загруженное и игнорирует прежние ответы', (_, changed) => {
        const state = apply(...requests, ...responses, ...requests,
            authInit.pending('next', undefined), authInit.fulfilled(changed, 'next', undefined), ...responses);
        expect(state).toMatchObject({ storage: null, backup: null, storageLoading: false, backupLoading: false });
        expect(state.authScope).not.toBe(apply().authScope);
    });

    it('Поздняя сводка первого аккаунта не подменяет новый результат второго', () => {
        const changed = { ...auth, user: { ...auth.user, id: 'two' } };
        const nextStorage = { ...storage, totalBytesUsed: 200 };
        const state = apply(...requests, authInit.pending('next', undefined), authInit.fulfilled(changed, 'next', undefined),
            fetchStorage.pending('new', undefined), fetchStorage.fulfilled(nextStorage, 'new', undefined), ...responses);
        expect(state.storage).toEqual(nextStorage);
        expect(state.backup).toBeNull();
    });

    it('Проверка прежнего scope сохраняет кэш и pending; HTTP503 сохраняет старую сводку', () => {
        const same = { user: { ...auth.user, userRoles: [...auth.user.userRoles].reverse() }, policies: { projects: ['read'], maintenance: ['write', 'read'] } };
        const state = apply(...requests, ...responses, fetchStorage.pending('refresh', undefined),
            authInit.pending('same', undefined), authInit.fulfilled(same, 'same', undefined),
            fetchStorage.rejected(null, 'refresh', undefined, { message: 'HTTP503', accessDenied: false }));
        expect(state.storage).toEqual(storage);
        expect(state.backup).toEqual(backup);
        expect(state.storageError).toBe('HTTP503');
        expect(state.storageLoading).toBe(false);
    });

    it('Старый authInit не сбрасывает данные уже выбранной роли', () => {
        const changed = { ...auth, user: { ...auth.user, activeRole: 'Администратор' } };
        const state = apply(authInit.pending('old', undefined), authSwitchRole.pending('role', 'Администратор'),
            authSwitchRole.fulfilled(changed, 'role', 'Администратор'), ...requests, ...responses,
            authInit.fulfilled(auth, 'old', undefined), authInit.rejected(new Error('Старый отказ'), 'old', undefined));
        expect(state.storage).toEqual(storage);
        expect(state.authScope).toContain('Администратор');
    });

    it('Неудачные выход и смена роли сохраняют текущего владельца', () => {
        const state = apply(...requests, ...responses,
            authSwitchRole.pending('role', 'Администратор'), authSwitchRole.rejected(new Error('503'), 'role', 'Администратор'),
            authLogout.pending('out', undefined), authLogout.rejected(new Error('503'), 'out', undefined));
        expect(state.storage).toEqual(storage);
        expect(state.backup).toEqual(backup);
        expect(state.authScope).toBe(apply().authScope);
    });

    it('Истёкший текущий auth запрос очищает владельца и поздние ошибки', () => {
        const state = apply(...requests, authLogout.pending('out', undefined),
            authLogout.rejected(null, 'out', undefined, 'unauthorized'),
            fetchStorage.rejected(null, 'storage', undefined, { message: 'Старый отказ', accessDenied: true }), ...responses);
        expect(state).toMatchObject({ storage: null, backup: null, authScope: null, storageError: null, backupAccessDenied: false });
    });
});
