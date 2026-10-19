import { configureStore } from '@reduxjs/toolkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import bffApi from '../src/core/api/bff';
import type { IAuthMe } from '../src/core/interfaces';
import { authInit, authLogout, authSwitchRole } from '../src/features/UserBlock/redux/actions';
import userBlock, { signOut } from '../src/features/UserBlock/redux/reducers';

vi.mock('../src/core/api/bff', () => ({ default: { me: vi.fn(), switchRole: vi.fn(), logout: vi.fn() } }));

function session(role = 'Главный админ'): IAuthMe {
    return {
        user: {
            id: 'admin', principalName: 'admin', email: 'admin@example.test', displayName: 'Администратор',
            activeRole: role, userRoles: ['Главный админ', 'Пользователь'], projectRoles: [], routePermissions: ['projects'],
        },
        policies: { projects: role === 'Главный админ' ? ['read', 'write'] : ['read'] },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

function createStore() {
    return configureStore({ reducer: { userBlock } });
}

describe('Порядок ответов авторизации', () => {
    beforeEach(() => { vi.resetAllMocks(); });

    it('Запоздалый вход не возвращает пользователя после выхода', async () => {
        const response = deferred<IAuthMe>();
        vi.mocked(bffApi.me).mockReturnValue(response.promise);
        const store = createStore();
        const request = store.dispatch(authInit());
        store.dispatch(signOut());
        response.resolve(session());
        await request;
        expect(store.getState().userBlock).toMatchObject({ isAuth: false, user: null, processing: false });
    });

    it('Старый ответ не перезаписывает более свежие права', async () => {
        const older = deferred<IAuthMe>();
        const newer = deferred<IAuthMe>();
        vi.mocked(bffApi.me).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        const store = createStore();
        const first = store.dispatch(authInit());
        const second = store.dispatch(authInit());
        newer.resolve(session('Пользователь'));
        await second;
        older.resolve(session());
        await first;
        expect(store.getState().userBlock.user?.activeRole).toBe('Пользователь');
        expect(store.getState().userBlock.policies).toEqual({ projects: ['read'] });
    });

    it('Ошибка старого запроса не завершает новую сессию', async () => {
        const older = deferred<IAuthMe>();
        vi.mocked(bffApi.me).mockReturnValueOnce(older.promise).mockResolvedValueOnce(session());
        const store = createStore();
        const first = store.dispatch(authInit());
        await store.dispatch(authInit());
        older.reject(new Error('Старая сеть'));
        await first;
        expect(store.getState().userBlock).toMatchObject({ isAuth: true, error: '' });
    });

    it('Старый запрос сессии не откатывает успешную смену роли', async () => {
        const refresh = deferred<IAuthMe>();
        vi.mocked(bffApi.me).mockResolvedValueOnce(session()).mockReturnValueOnce(refresh.promise);
        vi.mocked(bffApi.switchRole).mockResolvedValue(session('Пользователь'));
        const store = createStore();
        await store.dispatch(authInit());
        const request = store.dispatch(authInit());
        await store.dispatch(authSwitchRole('Пользователь'));
        refresh.resolve(session());
        await request;
        expect(store.getState().userBlock.user?.activeRole).toBe('Пользователь');
    });

    it('Не запускает параллельное чтение сессии во время смены роли', async () => {
        const change = deferred<IAuthMe>();
        vi.mocked(bffApi.me).mockResolvedValue(session());
        vi.mocked(bffApi.switchRole).mockReturnValue(change.promise);
        const store = createStore();
        await store.dispatch(authInit());
        const request = store.dispatch(authSwitchRole('Пользователь'));
        await store.dispatch(authInit());
        expect(bffApi.me).toHaveBeenCalledTimes(1);
        expect(store.getState().userBlock.processing).toBe(true);
        change.resolve(session('Пользователь'));
        await request;
        expect(store.getState().userBlock.user?.activeRole).toBe('Пользователь');
    });

    it('Выход блокирует новый refresh и игнорирует запоздалую смену роли', async () => {
        const change = deferred<IAuthMe>();
        const logout = deferred<{ redirectUrl?: string }>();
        vi.mocked(bffApi.me).mockResolvedValue(session());
        vi.mocked(bffApi.switchRole).mockReturnValue(change.promise);
        vi.mocked(bffApi.logout).mockReturnValue(logout.promise);
        const store = createStore();
        await store.dispatch(authInit());
        const roleRequest = store.dispatch(authSwitchRole('Пользователь'));
        const logoutRequest = store.dispatch(authLogout());
        await store.dispatch(authInit());
        logout.resolve({});
        await logoutRequest;
        change.resolve(session('Пользователь'));
        await roleRequest;
        expect(bffApi.me).toHaveBeenCalledTimes(1);
        expect(store.getState().userBlock).toMatchObject({ isAuth: false, user: null, processing: false });
    });

    it('После ошибки выхода сохраняет сессию и разрешает повторный refresh', async () => {
        vi.mocked(bffApi.me).mockResolvedValue(session());
        vi.mocked(bffApi.logout).mockRejectedValue(new Error('Сеть недоступна'));
        const store = createStore();
        await store.dispatch(authInit());
        await store.dispatch(authLogout());
        expect(store.getState().userBlock).toMatchObject({ isAuth: true, processing: false });
        await store.dispatch(authInit());
        expect(bffApi.me).toHaveBeenCalledTimes(2);
        expect(store.getState().userBlock.error).toBe('');
    });
});
