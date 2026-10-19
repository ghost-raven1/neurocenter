import { createAsyncThunk } from '@reduxjs/toolkit';

import bffApi from '../../../core/api/bff';
import type { ISkillCreateRequest, ISkillsListQuery, ISkillUpdateRequest } from '../../../core/api/interfaces';

/**
 * Загрузить дерево каталога скиллов.
 */
export const fetchSkillTree = createAsyncThunk('skills/fetchSkillTree', () => bffApi.getSkillTree());

/**
 * Загрузить список скиллов (по каталогу / всему дереву, с фильтрами).
 *
 * @param {ISkillsListQuery} params - параметры списка
 */
export const fetchSkillList = createAsyncThunk('skills/fetchSkillList', (params: ISkillsListQuery) => bffApi.listSkills(params));

/**
 * Прочитать скилл по пути.
 *
 * @param {string} path - относительный путь без расширения
 */
export const fetchSkill = createAsyncThunk('skills/fetchSkill', (path: string) => bffApi.getSkill(path));

/**
 * Создать скилл.
 *
 * @param {ISkillCreateRequest} payload - данные создания
 */
export const createSkill = createAsyncThunk('skills/createSkill', (payload: ISkillCreateRequest) => bffApi.createSkill(payload));

/**
 * Обновить скилл (бамп версии + запись в историю).
 *
 * @param payload - путь скилла + данные обновления
 */
export const updateSkill = createAsyncThunk(
    'skills/updateSkill',
    (payload: { path: string; request: ISkillUpdateRequest }) => bffApi.updateSkill(payload.path, payload.request),
);

/**
 * Удалить скилл.
 *
 * @param {string} path - относительный путь без расширения
 */
export const deleteSkill = createAsyncThunk('skills/deleteSkill', (path: string) => bffApi.deleteSkill(path));

/**
 * Создать папку в каталоге скиллов.
 *
 * @param {string} path - относительный путь папки
 */
export const createSkillDirectory = createAsyncThunk('skills/createSkillDirectory', (path: string) => bffApi.createSkillDirectory(path));
