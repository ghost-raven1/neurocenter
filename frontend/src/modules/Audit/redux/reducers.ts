import { createSlice, isAnyOf } from '@reduxjs/toolkit';

import { fetchAudit } from './actions';
import type { IAuditEvent } from '../../../core/api/interfaces';
import { authDataScope } from '../../../features/UserBlock/authDataScope';
import { authInit, authLogout, authSwitchRole } from '../../../features/UserBlock/redux/actions';
import { signOut } from '../../../features/UserBlock/redux/reducers';

export interface IAuditState {
    list: IAuditEvent[];
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

const initialState: IAuditState = {
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

const auditSlice = createSlice({
    name: 'audit',
    initialState,
    reducers: {
        setPage: (state, action: { payload: number }) => {
            state.page = action.payload;
        },
    },
    extraReducers: builder => {
        builder
            .addCase(fetchAudit.pending, (state, action) => {
                if (!state.authScope) { return; }
                state.loading = true;
                state.error = null;
                state.requestId = action.meta.requestId;
            })
            .addCase(fetchAudit.fulfilled, (state, action) => {
                if (state.requestId !== action.meta.requestId) { return; }
                state.loading = false;
                state.requestId = null;
                state.list = action.payload.items;
                state.total = action.payload.total;
                state.loadedPage = action.payload.page;
            })
            .addCase(fetchAudit.rejected, (state, action) => {
                if (state.requestId !== action.meta.requestId) { return; }
                state.loading = false;
                state.requestId = null;
                state.error = action.payload?.message || 'Не удалось загрузить историю операций';
                if (action.payload?.accessDenied) {
                    state.list = [];
                    state.total = 0;
                    state.loadedPage = null;
                }
            })
            .addCase(authInit.rejected, (state, action) => {
                if (state.authRequestId === action.meta.requestId) { return initialState; }
            })
            .addCase(authLogout.fulfilled, (state, action) => {
                if (state.authRequestId === action.meta.requestId) { return initialState; }
            })
            .addCase(signOut, () => initialState)
            .addMatcher(isAnyOf(authInit.pending, authSwitchRole.pending, authLogout.pending), (state, action) => {
                state.authRequestId = action.meta.requestId;
            })
            .addMatcher(isAnyOf(authInit.fulfilled, authSwitchRole.fulfilled), (state, action) => {
                if (state.authRequestId !== action.meta.requestId) { return; }
                const authScope = authDataScope(action.payload);
                if (state.authScope !== authScope) { return { ...initialState, authScope }; }
                state.authRequestId = null;
            })
            .addMatcher(isAnyOf(authSwitchRole.rejected, authLogout.rejected), (state, action) => {
                if (state.authRequestId !== action.meta.requestId) { return; }
                if (action.payload === 'unauthorized') { return initialState; }
                state.authRequestId = null;
            });
    },
});

export const { setPage } = auditSlice.actions;

export default auditSlice.reducer;
