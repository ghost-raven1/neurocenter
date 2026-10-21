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
