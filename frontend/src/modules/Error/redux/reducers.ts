import { createSlice, isAnyOf } from '@reduxjs/toolkit';

import { fetchError } from './actions';
import type { IErrorEvent } from '../../../core/api/interfaces';
import { authDataScope } from '../../../features/UserBlock/authDataScope';
import { authInit, authLogout, authSwitchRole } from '../../../features/UserBlock/redux/actions';
import { signOut } from '../../../features/UserBlock/redux/reducers';

export interface IErrorState {
    list: IErrorEvent[];
    page: number;
    size: number;
    total: number;
    loading: boolean;
    error: string | null;
    loadedPage: number | null;
    requestId: string | null;
    authScope: string | null;
    authRequestId: string | null;
}

const initialState: IErrorState = {
    list: [],
    page: 1,
    size: 20,
    total: 0,
    loading: false,
    error: null,
    loadedPage: null,
    requestId: null,
    authScope: null,
    authRequestId: null,
};

const errorSlice = createSlice({
    name: 'errors',
    initialState,
    reducers: {
        setPage: (state, action: { payload: number }) => {
            state.page = action.payload;
        },
    },
    extraReducers: (builder) => {
        builder
            .addCase(fetchError.pending, (state, action) => {
                if (!state.authScope) {
                    return;
                }
                state.loading = true;
                state.error = null;
                state.requestId = action.meta.requestId;
            })
            .addCase(fetchError.fulfilled, (state, action) => {
                if (state.requestId !== action.meta.requestId) {
                    return;
                }
                state.loading = false;
                state.requestId = null;
                state.list = action.payload.items;
                state.total = action.payload.total;
                state.loadedPage = action.payload.page;
            })
            .addCase(fetchError.rejected, (state, action) => {
                if (state.requestId !== action.meta.requestId) {
                    return;
                }
                state.loading = false;
                state.requestId = null;
                state.error = action.payload?.message || 'Не удалось загрузить ошибки';
                if (action.payload?.accessDenied) {
                    state.list = [];
                    state.total = 0;
                    state.loadedPage = null;
                }
            })
            .addCase(authInit.rejected, (state, action) => {
                if (state.authRequestId !== action.meta.requestId) {
                    return;
                }
                if (action.payload === 'unauthorized' || action.payload === 'forbidden') {
                    return initialState;
                }
                state.authRequestId = null;
            })
            .addCase(authLogout.fulfilled, (state, action) => {
                if (state.authRequestId === action.meta.requestId) {
                    return initialState;
                }
            })
            .addCase(signOut, () => initialState)
            .addMatcher(isAnyOf(authInit.pending, authSwitchRole.pending, authLogout.pending), (state, action) => {
                state.authRequestId = action.meta.requestId;
            })
            .addMatcher(isAnyOf(authInit.fulfilled, authSwitchRole.fulfilled), (state, action) => {
                if (state.authRequestId !== action.meta.requestId) {
                    return;
                }
                const authScope = authDataScope(action.payload);
                if (state.authScope !== authScope) {
                    return { ...initialState, authScope };
                }
                state.authRequestId = null;
            })
            .addMatcher(isAnyOf(authSwitchRole.rejected, authLogout.rejected), (state, action) => {
                if (state.authRequestId !== action.meta.requestId) {
                    return;
                }
                if (action.payload === 'unauthorized') {
                    return initialState;
                }
                state.authRequestId = null;
            });
    },
});

export const { setPage } = errorSlice.actions;

export default errorSlice.reducer;
