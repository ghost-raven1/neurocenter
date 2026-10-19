import { createAsyncThunk } from '@reduxjs/toolkit';
import { isAxiosError } from 'axios';

import bffApi from '../../../core/api/bff';
import type { IAuthMe } from '../../../core/interfaces';
import type { IUserBlockState } from '../interfaces';

type AuthThunkConfig = { state: { userBlock: IUserBlockState }; rejectValue: 'unauthorized' };

/** Refresh и смена роли ждут завершения текущего изменения сессии. */
function canStartSessionRequest(state: AuthThunkConfig['state']): boolean {
    return !state.userBlock.request || state.userBlock.request.kind === 'init';
}

/**
 * Инициализация сессии: запрос данных пользователя и политик (GET /auth/me).
 * На 401 reducer завершает только ту сессию, которой принадлежит ответ.
 */
export const authInit = createAsyncThunk<IAuthMe, void, AuthThunkConfig>(
    'userBlock/init',
    async (_, { rejectWithValue }) => {
        try { return await bffApi.me(); }
        catch (error) {
            if (isAxiosError(error) && error.response?.status === 401) { return rejectWithValue('unauthorized'); }
            throw error;
        }
    },
    { condition: (_, { getState }) => canStartSessionRequest(getState()) },
);

/**
 * Переключение активной роли (переопределение routePermissions/policies).
 *
 * @param {string} role - ключ роли
 */
export const authSwitchRole = createAsyncThunk<IAuthMe, string, AuthThunkConfig>(
    'userBlock/switchRole',
    async (role, { rejectWithValue }) => {
        try { return await bffApi.switchRole(role); }
        catch (error) {
            if (isAxiosError(error) && error.response?.status === 401) { return rejectWithValue('unauthorized'); }
            throw error;
        }
    },
    { condition: (_, { getState }) => canStartSessionRequest(getState()) },
);

/**
 * Выход из системы (BFF logout + опциональный редирект на Blitz).
 */
export const authLogout = createAsyncThunk<{ redirectUrl?: string }, void, AuthThunkConfig>(
    'userBlock/logout',
    async (_, { rejectWithValue }) => {
        try { return await bffApi.logout(); }
        catch (error) {
            if (isAxiosError(error) && error.response?.status === 401) { return rejectWithValue('unauthorized'); }
            throw error;
        }
    },
);

/**
 * Запуск OAuth-логина через Blitz (редирект на BFF authorization endpoint).
 *
 * @returns void
 */
export const authLoginBlitz = (): void => {
    // Редирект на SSO-мост: /auth/login → 302 на Blitz (или mock-сессия в dev)
    window.location.assign('/auth/login?returnTo='+encodeURIComponent(window.location.pathname+window.location.search));
};
