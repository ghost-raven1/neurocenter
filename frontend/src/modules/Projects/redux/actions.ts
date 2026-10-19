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
 * Загрузить версии образа проекта.
 *
 * @param {string} projectId - id проекта
 */
export const fetchVersions = createAsyncThunk('projects/fetchVersions', async (projectId: string) => {
    return bffApi.listVersions(projectId);
});

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

/** Параметры CAS-обновления head (из ConfirmCasModal). */
interface ICasArgs {
    projectId: string;
    snapshotId: string;
    expectedHeadId: string;
    expectedHeadRevision: number;
}

/**
 * Активировать (сделать head) проверенный снимок (CAS).
 *
 * @param {ICasArgs} args - параметры CAS
 */
export const activateHead = createAsyncThunk('projects/activateHead', async (args: ICasArgs) => {
    return bffApi.activateHead(args.projectId, args.snapshotId, {
        expectedHeadId: args.expectedHeadId,
        expectedHeadRevision: args.expectedHeadRevision,
    });
});

/**
 * Rollback head на уже проверенный снимок (CAS).
 *
 * @param {ICasArgs} args - параметры CAS
 */
export const rollbackHead = createAsyncThunk('projects/rollbackHead', async (args: ICasArgs) => {
    return bffApi.rollbackHead(args.projectId, args.snapshotId, {
        expectedHeadId: args.expectedHeadId,
        expectedHeadRevision: args.expectedHeadRevision,
    });
});

/**
 * Удалить снимок (tombstone + GC по grace period).
 *
 * @param {string} projectId
 * @param {string} snapshotId
 */
export const deleteSnapshot = createAsyncThunk('projects/deleteSnapshot', async ({ projectId, snapshotId }: { projectId: string; snapshotId: string }) => {
    return bffApi.deleteSnapshot(projectId, snapshotId, {});
});

/**
 * Выпустить релизный профиль (+ опционально смена head одной транзакцией).
 *
 * @param {object} payload - id проекта, снимок, скилл-пины, expected profile, moveHead
 */
export const releaseProfile = createAsyncThunk(
    'projects/releaseProfile',
    async (payload: {
        projectId: string;
        snapshotId: string;
        skillPins: { skillSlug: string; skillId: string; skillVersionId: string }[];
        expectedProfileId?: string;
        moveHead?: { expectedHeadId: string; expectedHeadRevision: number };
    }) => {
        return bffApi.releaseProfile(payload.projectId, {
            snapshotId: payload.snapshotId,
            skillPins: payload.skillPins,
            expectedProfileId: payload.expectedProfileId,
            moveHead: payload.moveHead,
        });
    },
);
