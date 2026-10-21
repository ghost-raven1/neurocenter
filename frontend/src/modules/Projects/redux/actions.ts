import { errorMessage } from '../../../common/utils/errorMessage';
import { createAsyncThunk } from '@reduxjs/toolkit';
import { isAxiosError } from 'axios';

import bffApi from '../../../core/api/bff';
import type { IPage, IProjectDetail, IProjectListParams, IProjectSummary } from '../../../core/api/interfaces';
import type { IProjectLoadError } from '../interfaces';

/**
 * Загрузить страницу списка проектов.
 *
 * @param {IProjectListParams} params - пагинация + поиск
 */
export const fetchProjects = createAsyncThunk<IPage<IProjectSummary>, IProjectListParams, { rejectValue: IProjectLoadError }>(
    'projects/fetchProjects', async (params, { rejectWithValue }) => {
        try { return await bffApi.listProjects(params); }
        catch (error) {
            const status = isAxiosError(error) ? error.response?.status ?? null : null;
            const message = status === 403 ? 'У вас нет доступа к списку проектов. Обратитесь к администратору.'
                : status === null ? 'Не удалось связаться с сервером. Проверьте соединение и повторите загрузку.'
                : 'Сервер не смог загрузить список проектов. Попробуйте ещё раз.';
            return rejectWithValue({ status, message });
        }
    },
);

/**
 * Загрузить карточку проекта.
 *
 * @param {string} projectId - id проекта
 */
export const fetchProject = createAsyncThunk<IProjectDetail, string, { rejectValue: IProjectLoadError }>(
    'projects/fetchProject',
    async (projectId, { rejectWithValue }) => {
        try {
            return await bffApi.getProject(projectId);
        } catch (error) {
            const status = isAxiosError(error) ? error.response?.status ?? null : null;
            const message = status === 404 ? 'Проект удалён или ссылка больше не действует.'
                : status === 403 ? 'У вас нет доступа к этому проекту. Обратитесь к администратору.'
                : status === null ? 'Не удалось связаться с сервером. Проверьте соединение и повторите загрузку.'
                : 'Сервер не смог загрузить проект. Попробуйте ещё раз.';
            return rejectWithValue({ status, message });
        }
    },
);

/**
 * Создать проект.
 *
 * @param {object} payload - поля создания
 */
export const createProject = createAsyncThunk(
    'projects/createProject',
    async (payload: { name: string; externalResourceId: string }, { rejectWithValue }) => {
        try { return await bffApi.createProject(payload); } catch (error) { return rejectWithValue(errorMessage(error, 'Не удалось создать проект')); }
    },
);
