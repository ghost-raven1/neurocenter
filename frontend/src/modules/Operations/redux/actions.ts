import { createAsyncThunk } from '@reduxjs/toolkit';

import bffApi from '../../../core/api/bff';
import type { IOperationListParams } from '../../../core/api/interfaces';

/**
 * Загрузить страницу списка операций.
 *
 * @param {IOperationListParams} params - пагинация + фильтры
 */
export const fetchOperations = createAsyncThunk(
    'operations/fetchOperations',
    async (params: IOperationListParams) => bffApi.listOperations(params),
);

/**
 * Загрузить детали операции.
 *
 * @param {string} operationId
 */
export const fetchOperation = createAsyncThunk('operations/fetchOperation', async (operationId: string) =>
    bffApi.getOperation(operationId),
);

/**
 * Повторить операцию.
 *
 * @param {string} operationId
 */
export const retryOperation = createAsyncThunk('operations/retryOperation', async (operationId: string) =>
    bffApi.retryOperation(operationId),
);

/**
 * Отменить операцию.
 *
 * @param {string} operationId
 */
export const cancelOperation = createAsyncThunk('operations/cancelOperation', async (operationId: string) =>
    bffApi.cancelOperation(operationId),
);
