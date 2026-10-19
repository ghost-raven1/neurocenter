import { createAsyncThunk } from '@reduxjs/toolkit';

import bffApi from '../../../core/api/bff';
import { errorMessage } from '../../../common/utils/errorMessage';
import { maintenanceAccessDenied } from '../maintenanceReadFailure';
import type { IMaintenanceReadFailure } from '../maintenanceReadFailure';
import type { IBackupStatus, IStorageSummary } from '../../../core/api/interfaces';

type TReadConfig = { rejectValue: IMaintenanceReadFailure };

/** Загрузить сводку по хранилищу. */
export const fetchStorage = createAsyncThunk<IStorageSummary, void, TReadConfig>('maintenance/fetchStorage', async (_, { rejectWithValue }) => {
    try { return await bffApi.getStorage(); }
    catch (error) { return rejectWithValue({ message: errorMessage(error, 'Не удалось загрузить сводку хранилища'), accessDenied: maintenanceAccessDenied(error) }); }
});

/** Загрузить статус бэкапа. */
export const fetchBackup = createAsyncThunk<IBackupStatus, void, TReadConfig>('maintenance/fetchBackup', async (_, { rejectWithValue }) => {
    try { return await bffApi.getBackup(); }
    catch (error) { return rejectWithValue({ message: errorMessage(error, 'Не удалось загрузить сведения о резервной копии'), accessDenied: maintenanceAccessDenied(error) }); }
});
