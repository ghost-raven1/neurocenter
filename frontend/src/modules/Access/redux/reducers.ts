import { createSlice, isAnyOf } from '@reduxjs/toolkit';

import { fetchDecisions } from './actions';
import type { IAccessDecision } from '../../../core/api/interfaces';
import { authDataScope } from '../../../features/UserBlock/authDataScope';
import { authInit, authLogout, authSwitchRole } from '../../../features/UserBlock/redux/actions';
import { signOut } from '../../../features/UserBlock/redux/reducers';

export interface IAccessState {
    decisions: IAccessDecision[];
    externalServiceUrl: string | null;
    scope: string;
    loading: boolean;
    error: string;
    currentRequestId: string | null;
    authScope: string | null;
    authRequestId: string | null;
}

const initialState: IAccessState = {
    decisions: [],
    externalServiceUrl: null,
    scope: 'project',
    loading: false,
    error: '',
    currentRequestId: null,
    authScope: null,
    authRequestId: null,
};

const accessSlice = createSlice({
    name: 'access',
    initialState,
    reducers: {
        setScope: (state, action: { payload: string }) => {
            state.scope = action.payload;
        },
    },
    extraReducers: builder => {
        builder
            .addCase(fetchDecisions.pending, (state, action) => {
                if (!state.authScope) { return; }
                state.loading = true;
                state.error = '';
                state.decisions = [];
                state.currentRequestId = action.meta.requestId;
            })
            .addCase(fetchDecisions.fulfilled, (state, action) => {
                if (state.currentRequestId !== action.meta.requestId) { return; }
                state.loading = false;
                state.decisions = action.payload.decisions;
                state.externalServiceUrl = action.payload.externalServiceUrl;
                state.currentRequestId = null;
            })
            .addCase(fetchDecisions.rejected, (state, action) => {
                if (state.currentRequestId !== action.meta.requestId) { return; }
                state.loading = false;
                state.error = typeof action.payload === 'string' ? action.payload : 'Не удалось получить актуальные права.';
                state.currentRequestId = null;
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
                // Обычный heartbeat сохраняет решения; смена владельца отзывает незавершённый GET.
                if (state.authScope !== authScope) { return { ...initialState, authScope, scope: state.scope }; }
                state.authRequestId = null;
            })
            .addMatcher(isAnyOf(authSwitchRole.rejected, authLogout.rejected), (state, action) => {
                if (state.authRequestId !== action.meta.requestId) { return; }
                if (action.payload === 'unauthorized') { return initialState; }
                state.authRequestId = null;
            });
    },
});

export const { setScope } = accessSlice.actions;

export default accessSlice.reducer;
