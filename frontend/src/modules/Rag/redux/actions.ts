import { createAsyncThunk } from '@reduxjs/toolkit';
import { isAxiosError } from 'axios';

import bffApi from '../../../core/api/bff';
import type { IRagProjectSummary } from '../../../core/api/interfaces';
import type { IRagLoadError } from '../interfaces';

/**
 * Загрузить список develop-индексов RAG по всем projectKey.
 */
export const fetchRag = createAsyncThunk<IRagProjectSummary[], void, { rejectValue: IRagLoadError }>(
    'rag/fetch', async (_, { rejectWithValue }) => {
        try { return await bffApi.listRagProjects(); }
        catch (error) {
            const status = isAxiosError(error) ? error.response?.status ?? null : null;
            const message = status === 403 ? 'У вас нет доступа к списку баз знаний. Обратитесь к администратору.'
                : status === null ? 'Не удалось связаться с сервером. Проверьте соединение и повторите загрузку.'
                : 'Сервер не смог загрузить список баз знаний. Попробуйте ещё раз.';
            return rejectWithValue({ status, message });
        }
    },
);
