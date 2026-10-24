import { createSlice, isAnyOf } from '@reduxjs/toolkit';

import { authDataScope } from '../../../features/UserBlock/authDataScope';
import { authInit, authLogout, authSwitchRole } from '../../../features/UserBlock/redux/actions';
import { signOut } from '../../../features/UserBlock/redux/reducers';
import type { IAuthMe } from '../../../core/interfaces';
import type { IProjectListParams } from '../../../core/api/interfaces';
import { fetchProject, fetchProjects } from './actions';
import type { IProjectsState } from '../interfaces';

const initialState: IProjectsState = {
    list: [],
    page: 1,
    size: 10,
    total: 0,
    query: '',
    loading: false,
    listError: null,
    listRequestId: null,
    authScope: null,
    authRequestId: null,
    selectedId: null,
    selected: null,
    selectedLoading: false,
    selectedRequestId: null,
    selectedError: null,
};

function matchesListParams(state: IProjectsState, params: IProjectListParams): boolean {
    return state.page === params.page && state.size === params.size && state.query === (params.query ?? '');
}

function clearSelectedProject(state: IProjectsState): void {
    state.selectedId = null;
    state.selected = null;
    state.selectedLoading = false;
    state.selectedRequestId = null;
    state.selectedError = null;
}

/** Ответы прежней роли теряют владельца, даже если HTTP-запрос уже нельзя отменить. */
function applyAuthScope(state: IProjectsState, auth: IAuthMe): IProjectsState | undefined {
    const authScope = authDataScope(auth);
    if (state.authScope !== authScope) {
        return { ...initialState, page: state.page, size: state.size, query: state.query, authScope };
    }
}

const projectsSlice = createSlice({
    name: 'projects',
    initialState,
    reducers: {
        setQuery: (state, action: { payload: string }) => {
            if (state.query === action.payload && state.page === 1) {
                return;
            }
            state.query = action.payload;
            state.page = 1;
            state.list = [];
            state.total = 0;
            state.listError = null;
            state.listRequestId = null;
            state.loading = false;
        },
        setPage: (state, action: { payload: number }) => {
            if (state.page === action.payload) {
                return;
            }
            state.page = action.payload;
            state.list = [];
            state.listError = null;
            state.listRequestId = null;
            state.loading = false;
        },
        clearSelected: clearSelectedProject,
    },
    extraReducers: builder => {
        builder
            .addCase(fetchProjects.pending, (state, action) => {
                if (!state.authScope || !matchesListParams(state, action.meta.arg)) {
                    return;
                }
                state.loading = true;
                state.listError = null;
                state.listRequestId = action.meta.requestId;
            })
            .addCase(fetchProjects.fulfilled, (state, action) => {
                if (state.listRequestId !== action.meta.requestId || !matchesListParams(state, action.meta.arg)) {
                    return;
                }
                state.loading = false;
                state.listRequestId = null;
                state.list = action.payload.items;
                state.total = action.payload.total;
                state.listError = null;
            })
            .addCase(fetchProjects.rejected, (state, action) => {
                if (state.listRequestId !== action.meta.requestId) {
                    return;
                }
                state.loading = false;
                state.listRequestId = null;
                state.listError = action.payload ?? { status: null, message: 'Не удалось загрузить список проектов. Попробуйте ещё раз.' };
                if (state.listError.status === 403 || state.listError.status === 404) {
                    state.list = [];
                    state.total = 0;
                }
            })
            .addCase(fetchProject.pending, (state, action) => {
                if (!state.authScope) {
                    return;
                }
                if (state.selectedId !== action.meta.arg && state.selected?.id !== action.meta.arg && state.selected?.name !== action.meta.arg) {
                    clearSelectedProject(state);
                }
                state.selectedId = action.meta.arg;
                state.selectedLoading = true;
                state.selectedRequestId = action.meta.requestId;
                state.selectedError = null;
            })
            .addCase(fetchProject.fulfilled, (state, action) => {
                if (state.selectedRequestId !== action.meta.requestId) {
                    return;
                }
                state.selectedLoading = false;
                state.selectedRequestId = null;
                state.selected = action.payload;
                state.selectedId = action.payload.id;
            })
            .addCase(fetchProject.rejected, (state, action) => {
                if (state.selectedRequestId !== action.meta.requestId) {
                    return;
                }
                const error = action.payload ?? { status: null, message: 'Не удалось загрузить проект. Попробуйте ещё раз.' };
                if (error.status === 403 || error.status === 404) {
                    clearSelectedProject(state);
                }
                state.selectedId = action.meta.arg;
                state.selectedLoading = false;
                state.selectedRequestId = null;
                state.selectedError = error;
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
                const nextState = applyAuthScope(state, action.payload);
                if (nextState) {
                    return nextState;
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

export const { setQuery, setPage, clearSelected } = projectsSlice.actions;

export default projectsSlice.reducer;
