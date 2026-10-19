import { createSlice } from '@reduxjs/toolkit';

import { authInit, authLogout, authSwitchRole } from './actions';
import type { IUserBlockState } from '../interfaces';

const initialState: IUserBlockState = {
    isAuth: false,
    processing: false,
    error: '',
    user: null,
    policies: {},
    request: null,
};

const userBlockSlice = createSlice({
    name: 'userBlock',
    initialState,
    reducers: {
        setProcessing: (state, action: { payload: boolean }) => {
            state.processing = action.payload;
        },
        clearError: state => {
            state.error = '';
        },
        signOut: () => ({ ...initialState }),
    },
    extraReducers: builder => {
        builder
            .addCase(authInit.pending, (state, action) => {
                state.processing = true;
                state.request = { id: action.meta.requestId, kind: 'init' };
            })
            .addCase(authInit.fulfilled, (state, action) => {
                if (state.request?.id !== action.meta.requestId) { return; }
                state.request = null;
                state.processing = false;
                state.isAuth = true;
                state.user = action.payload.user;
                state.policies = action.payload.policies;
                state.error = '';
            })
            .addCase(authInit.rejected, (state, action) => {
                if (state.request?.id !== action.meta.requestId) { return; }
                state.request = null;
                state.processing = false;
                state.isAuth = false;
                state.user = null;
                state.policies = {};
                state.error = action.payload === 'unauthorized' ? '' : 'Не удалось подключиться к серверу. Проверьте соединение и повторите вход.';
            })
            .addCase(authSwitchRole.pending, (state, action) => {
                state.processing = true;
                state.error = '';
                state.request = { id: action.meta.requestId, kind: 'switchRole' };
            })
            .addCase(authSwitchRole.rejected, (state, action) => {
                if (state.request?.id !== action.meta.requestId) { return; }
                if (action.payload === 'unauthorized') { return initialState; }
                state.request = null;
                state.processing = false;
                state.error = 'Не удалось сменить роль.';
            })
            .addCase(authSwitchRole.fulfilled, (state, action) => {
                if (state.request?.id !== action.meta.requestId) { return; }
                state.request = null;
                state.processing = false;
                state.error = '';
                state.user = action.payload.user;
                state.policies = action.payload.policies;
            })
            .addCase(authLogout.pending, (state, action) => {
                state.processing = true;
                state.error = '';
                state.request = { id: action.meta.requestId, kind: 'logout' };
            })
            .addCase(authLogout.rejected, (state, action) => {
                if (state.request?.id !== action.meta.requestId) { return; }
                if (action.payload === 'unauthorized') { return initialState; }
                state.request = null;
                state.processing = false;
            })
            .addCase(authLogout.fulfilled, (state, action) => {
                if (state.request?.id === action.meta.requestId) { return initialState; }
            });
    },
});

export const { setProcessing, clearError, signOut } = userBlockSlice.actions;

export default userBlockSlice.reducer;
