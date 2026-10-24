import { createSlice, isAnyOf } from '@reduxjs/toolkit';

import { authDataScope } from '../../../features/UserBlock/authDataScope';
import { authInit, authLogout, authSwitchRole } from '../../../features/UserBlock/redux/actions';
import { signOut } from '../../../features/UserBlock/redux/reducers';

import { fetchBackup, fetchStorage } from './actions';
import type { IBackupStatus, IStorageSummary } from '../../../core/api/interfaces';

export interface IMaintenanceState {
    storage: IStorageSummary | null;
    backup: IBackupStatus | null;
    storageLoading: boolean;
    backupLoading: boolean;
    storageError: string | null;
    backupError: string | null;
    storageRequestId: string | null;
    backupRequestId: string | null;
    backupAccessDenied: boolean;
    authScope: string | null;
    authRequestId: string | null;
}

const initialState: IMaintenanceState = {
    storage: null,
    backup: null,
    storageLoading: false,
    backupLoading: false,
    storageError: null,
    backupError: null,
    storageRequestId: null,
    backupRequestId: null,
    backupAccessDenied: false,
    authScope: null,
    authRequestId: null,
};

const maintenanceSlice = createSlice({
    name: 'maintenance',
    initialState,
    reducers: {},
    extraReducers: builder => {
        builder
            .addCase(fetchStorage.pending, (state, action) => {
                if (!state.authScope) { return; }
                state.storageLoading = true;
                state.storageError = null;
                state.storageRequestId = action.meta.requestId;
            })
            .addCase(fetchStorage.fulfilled, (state, action) => {
                if (state.storageRequestId !== action.meta.requestId) { return; }
                state.storageLoading = false;
                state.storageRequestId = null;
                state.storage = action.payload;
            })
            .addCase(fetchStorage.rejected, (state, action) => {
                if (state.storageRequestId !== action.meta.requestId) { return; }
                state.storageLoading = false;
                state.storageRequestId = null;
                const failure = action.payload;
                state.storageError = failure?.message || 'Не удалось загрузить сводку хранилища';
                if (failure?.accessDenied) { state.storage = null; }
            })
            .addCase(fetchBackup.pending, (state, action) => {
                if (!state.authScope) { return; }
                state.backupLoading = true;
                state.backupError = null;
                state.backupRequestId = action.meta.requestId;
            })
            .addCase(fetchBackup.fulfilled, (state, action) => {
                if (state.backupRequestId !== action.meta.requestId) { return; }
                state.backupLoading = false;
                state.backupRequestId = null;
                state.backup = action.payload;
                state.backupAccessDenied = false;
            })
            .addCase(fetchBackup.rejected, (state, action) => {
                if (state.backupRequestId !== action.meta.requestId) { return; }
                state.backupLoading = false;
                state.backupRequestId = null;
                const failure = action.payload;
                state.backupError = failure?.message || 'Не удалось загрузить сведения о резервной копии';
                if (failure?.accessDenied) {
                    state.backup = null;
                    state.backupAccessDenied = true;
                }
            })
            .addCase(authInit.rejected, (state, action) => {
                if (state.authRequestId !== action.meta.requestId) { return; }
                if (action.payload === 'unauthorized' || action.payload === 'forbidden') { return initialState; }
                state.authRequestId = null;
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

export default maintenanceSlice.reducer;
