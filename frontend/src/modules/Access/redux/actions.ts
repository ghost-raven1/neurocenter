import { createAsyncThunk } from '@reduxjs/toolkit';

import bffApi from '../../../core/api/bff';
import { errorMessage } from '../../../common/utils/errorMessage';

/**
 * Загрузить фактические серверные права активной роли.
 *
 * @param {string} scope - project | collection | skill | package
 */
export const fetchDecisions = createAsyncThunk('access/fetchDecisions', async (scope: string, { rejectWithValue }) => {
    try { return await bffApi.getDecisions(scope); }
    catch (error: unknown) { return rejectWithValue(errorMessage(error, 'Не удалось получить права. Проверьте соединение и повторите попытку.')); }
});
