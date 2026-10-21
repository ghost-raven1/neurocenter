import { createSlice } from '@reduxjs/toolkit';

import type { IOperationsFilters, IOperationsState, IOperationProgressCache } from '../interfaces';
import { fetchOperation, fetchOperations } from './actions';

const initialState: IOperationsState = {
    list: [],
    page: 1,
    size: 10,
    total: 0,
    activeCount:0,
    loading: false,
    filters: {},
    progressCache: {},
    selected: null,
};

const operationsSlice = createSlice({
    name: 'operations',
    initialState,
    reducers: {
        setActiveCount:(state,action:{payload:number})=>{state.activeCount=action.payload;},
        setFilters: (state, action: { payload: IOperationsFilters }) => {
            state.filters = action.payload;
            state.page = 1;
        },
        setPage: (state, action: { payload: number }) => {
            state.page = action.payload;
        },
        setProgress: (state, action: { payload: IOperationProgressCache & { operationId: string } }) => {
            const { operationId, ...rest } = action.payload;
            state.progressCache[operationId] = rest;
        },
        closeDetail: state => {
            state.selected = null;
        },
    },
    extraReducers: builder => {
        builder
            .addCase(fetchOperations.pending, state => {
                state.loading = true;
            })
            .addCase(fetchOperations.fulfilled, (state, action) => {
                state.loading = false;
                state.list = action.payload.items;
                state.total = action.payload.total;
            })
            .addCase(fetchOperations.rejected, state => {
                state.loading = false;
            })
            .addCase(fetchOperation.fulfilled, (state, action) => {
                state.selected = action.payload;
            });
    },
});

export const { setActiveCount, setFilters, setPage, setProgress, closeDetail } = operationsSlice.actions;

export default operationsSlice.reducer;
