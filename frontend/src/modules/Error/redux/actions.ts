import { createAsyncThunk } from '@reduxjs/toolkit';
import { isAxiosError } from 'axios';

import bffApi from '../../../core/api/bff';
import { errorMessage } from '../../../common/utils/errorMessage';
import type { IErrorEvent, IErrorListParams, IPage } from '../../../core/api/interfaces';
import { authDataScope } from '../../../features/UserBlock/authDataScope';
import { ERROR_ROUTE } from '../../../features/UserBlock/permissions';
import type { TRootState } from '../../../store';

interface IErrorReadFailure {
    message: string;
    accessDenied: boolean;
}
type TErrorReadConfig = { state: Pick<TRootState, 'userBlock' | 'errors'>; rejectValue: IErrorReadFailure };

/**
 * Загрузить страницу error-событий (GET /api/errors, AD-O5).
 *
 * @param {IErrorListParams} params
 */
export const fetchError = createAsyncThunk<IPage<IErrorEvent>, IErrorListParams, TErrorReadConfig>(
    'errors/fetchError',
    async (params, { rejectWithValue }) => {
        try {
            return await bffApi.listErrors(params);
        } catch (error) {
            return rejectWithValue({
                message: errorMessage(error, 'Не удалось загрузить ошибки'),
                accessDenied: isAxiosError(error) && [401, 403, 404].includes(error.response?.status ?? 0),
            });
        }
    },
    {
        condition: (_, { getState }) => {
            const { userBlock, errors } = getState();
            if (!userBlock.isAuth || !userBlock.user?.routePermissions.includes(ERROR_ROUTE)) {
                return false;
            }
            return errors.authScope === authDataScope({ user: userBlock.user, policies: userBlock.policies });
        },
    },
);
