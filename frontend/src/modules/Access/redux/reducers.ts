import { createSlice } from '@reduxjs/toolkit';

import { fetchDecisions } from './actions';
import type { IAccessDecision } from '../../../core/api/interfaces';

export interface IAccessState {
    decisions: IAccessDecision[];
    externalServiceUrl: string | null;
    scope: string;
    loading: boolean;
    error: string;
    currentRequestId: string | null;
}

const initialState: IAccessState = {
    decisions: [],
    externalServiceUrl: null,
    scope: 'project',
    loading: false,
    error: '',
    currentRequestId: null,
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
            });
    },
});

export const { setScope } = accessSlice.actions;

export default accessSlice.reducer;
