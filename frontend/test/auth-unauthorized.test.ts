import { configureStore } from '@reduxjs/toolkit';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import base, { setUnauthorizedHandler } from '../src/core/api/base';
import type { IAuthMe } from '../src/core/interfaces';
import { authInit, authLogout, authSwitchRole } from '../src/features/UserBlock/redux/actions';
import userBlock, { signOut } from '../src/features/UserBlock/redux/reducers';

const originalAdapter = base.defaults.adapter;
const session: IAuthMe = {
    user: {
        id: 'admin', principalName: 'admin', email: 'admin@example.test', displayName: 'Администратор',
        activeRole: 'Главный админ', userRoles: ['Главный админ'], projectRoles: [], routePermissions: ['projects'],
    },
    policies: { projects: ['read'] },
};

function unauthorized(config: InternalAxiosRequestConfig): AxiosError {
    return new AxiosError('Сессия истекла', 'ERR_BAD_REQUEST', config, undefined, {
        data: {}, status: 401, statusText: 'Unauthorized', headers: {}, config,
    });
}

function response(config: InternalAxiosRequestConfig): AxiosResponse {
    return { data: session, status: 200, statusText: 'OK', headers: {}, config };
}

afterEach(() => {
    base.defaults.adapter = originalAdapter;
    setUnauthorizedHandler(() => undefined);
});

describe('Обработка HTTP 401 с учётом владельца auth запроса', () => {
    it('Поздний CRUD 401 прежнего пользователя не завершает новую сессию', async () => {
        let rejectOlder!: () => void;
        let sent!: () => void;
        const started = new Promise<void>(resolve => { sent = resolve; });
        base.defaults.adapter = config => new Promise((_, reject) => {
            rejectOlder = () => reject(unauthorized(config)); sent();
        });
        const store = configureStore({ reducer: { userBlock } });
        store.dispatch(authInit.pending('first', undefined));
        store.dispatch(authInit.fulfilled(session, 'first', undefined));
        const handler = vi.fn(() => { store.dispatch(signOut()); });
        setUnauthorizedHandler(handler, () => store.getState().userBlock.user);
        const older = base.post('/api/ai-plugins', { name: 'Первый пользователь' }).catch(error => error);
        await started;
        const next = { ...session, user: { ...session.user, id: 'second', email: 'second@example.test' } };
        store.dispatch(authInit.pending('second', undefined));
        store.dispatch(authInit.fulfilled(next, 'second', undefined));
        rejectOlder();
        expect(await older).toMatchObject({ response: { status: 401 } });
        expect(handler).not.toHaveBeenCalled();
        expect(store.getState().userBlock).toMatchObject({ isAuth: true, user: next.user });
    });

    it('Повторный вход того же пользователя не оживляет его прежний CRUD 401', async () => {
        let rejectOlder!: () => void;
        let sent!: () => void;
        const started = new Promise<void>(resolve => { sent = resolve; });
        base.defaults.adapter = config => new Promise((_, reject) => {
            rejectOlder = () => reject(unauthorized(config)); sent();
        });
        const store = configureStore({ reducer: { userBlock } });
        store.dispatch(authInit.pending('first', undefined));
        store.dispatch(authInit.fulfilled(session, 'first', undefined));
        const handler = vi.fn(() => { store.dispatch(signOut()); });
        setUnauthorizedHandler(handler, () => store.getState().userBlock.user);
        const older = base.patch('/api/ai-plugins/tool', {}).catch(error => error);
        await started;
        store.dispatch(signOut());
        store.dispatch(authInit.pending('next', undefined));
        store.dispatch(authInit.fulfilled(structuredClone(session), 'next', undefined));
        rejectOlder();
        expect(await older).toMatchObject({ response: { status: 401 } });
        expect(handler).not.toHaveBeenCalled();
        expect(store.getState().userBlock).toMatchObject({ isAuth: true, user: session.user });
    });

    it('Свежий CRUD 401 того же владельца завершает сессию', async () => {
        base.defaults.adapter = config => Promise.reject(unauthorized(config));
        const handler = vi.fn();
        setUnauthorizedHandler(handler, () => 'current');
        await expect(base.patch('/api/ai-plugins/tool', {})).rejects.toMatchObject({ response: { status: 401 } });
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('Настоящий Axios interceptor не завершает новую сессию из-за старого 401', async () => {
        let rejectOlder!: () => void;
        let calls = 0;
        base.defaults.adapter = config => {
            if (++calls === 1) {
                return new Promise((_, reject) => { rejectOlder = () => reject(unauthorized(config)); });
            }
            return Promise.resolve(response(config));
        };
        const store = configureStore({ reducer: { userBlock } });
        const globalSignOut = vi.fn(() => { store.dispatch(signOut()); });
        setUnauthorizedHandler(globalSignOut);
        const older = store.dispatch(authInit());
        await store.dispatch(authInit());
        rejectOlder();
        await older;
        expect(globalSignOut).not.toHaveBeenCalled();
        expect(store.getState().userBlock).toMatchObject({ isAuth: true, error: '', user: session.user });
    });

    it.each(['init', 'switchRole', 'logout'] as const)('Актуальный 401 в %s завершает сессию', async action => {
        let expired = false;
        base.defaults.adapter = config => expired
            ? Promise.reject(unauthorized(config))
            : Promise.resolve(response(config));
        const store = configureStore({ reducer: { userBlock } });
        await store.dispatch(authInit());
        expired = true;
        if (action === 'init') { await store.dispatch(authInit()); }
        if (action === 'switchRole') { await store.dispatch(authSwitchRole('Пользователь')); }
        if (action === 'logout') { await store.dispatch(authLogout()); }
        expect(store.getState().userBlock).toMatchObject({ isAuth: false, user: null, policies: {}, processing: false });
    });

    it('Для обычного API сохраняет глобальную обработку истёкшей сессии', async () => {
        base.defaults.adapter = config => Promise.reject(unauthorized(config));
        const handler = vi.fn();
        setUnauthorizedHandler(handler);
        await expect(base.get('/api/projects')).rejects.toMatchObject({ response: { status: 401 } });
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
