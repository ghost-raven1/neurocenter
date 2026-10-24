import { createSlice, isAnyOf } from '@reduxjs/toolkit';

import { fetchRag } from './actions';
import type { IRagProjectSummary } from '../../../core/api/interfaces';
import { authDataScope } from '../../../features/UserBlock/authDataScope';
import { authInit, authLogout, authSwitchRole } from '../../../features/UserBlock/redux/actions';
import { signOut } from '../../../features/UserBlock/redux/reducers';
import type { IRagLoadError } from '../interfaces';

export interface IRagState {
    list: IRagProjectSummary[];
    loading: boolean;
    listError: IRagLoadError | null;
    requestId: string | null;
    authScope: string | null;
    authRequestId: string | null;
}

const initialState: IRagState = {
    list: [],
    loading: false,
    listError: null,
    requestId: null,
    authScope: null,
    authRequestId: null,
};

const ragSlice = createSlice({
    name: 'rag',
    initialState,
    reducers: {
        clearRag: state => ({ ...initialState, authScope: state.authScope, authRequestId: state.authRequestId }),
    },
    extraReducers: builder => {
        builder
            .addCase(fetchRag.pending, (state, action) => {
                if (!state.authScope) {
                    return;
                }
                state.loading = true;
                state.listError = null;
                state.requestId = action.meta.requestId;
            })
            .addCase(fetchRag.fulfilled, (state, action) => {
                if (state.requestId !== action.meta.requestId) {
                    return;
                }
                state.loading = false;
                state.requestId = null;
                state.list = action.payload;
                state.listError = null;
            })
            .addCase(fetchRag.rejected, (state, action) => {
                if (state.requestId !== action.meta.requestId) {
                    return;
                }
                state.loading = false;
                state.requestId = null;
                state.listError = action.payload ?? { status: null, message: 'Не удалось загрузить список баз знаний. Попробуйте ещё раз.' };
                if (state.listError.status === 401 || state.listError.status === 403 || state.listError.status === 404) {
                    state.list = [];
                }
            })
            .addCase(authInit.rejected, (state, action) => {
                if (state.authRequestId === action.meta.requestId) {
                    if (action.payload === 'unauthorized' || action.payload === 'forbidden') { return initialState; }
                    state.authRequestId = null;
                }
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
                if (state.authRequestId === action.meta.requestId) {
                    if (action.payload === 'unauthorized') {
                        return initialState;
                    }
                    state.authRequestId = null;
                }
            });
    },
});

export const { clearRag } = ragSlice.actions;

export default ragSlice.reducer;
