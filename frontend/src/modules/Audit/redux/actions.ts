import { createAsyncThunk } from '@reduxjs/toolkit';
import { isAxiosError } from 'axios';

import bffApi from '../../../core/api/bff';
import { errorMessage } from '../../../common/utils/errorMessage';
import type { IAuditEvent, IAuditListParams, IPage } from '../../../core/api/interfaces';
import { authDataScope } from '../../../features/UserBlock/authDataScope';
import { AUDIT_ROUTE } from '../../../features/UserBlock/permissions';
import type { RootState } from '../../../store';

interface IAuditReadFailure { message: string; accessDenied: boolean; }
type TAuditReadConfig = { state: Pick<RootState, 'userBlock' | 'audit'>; rejectValue: IAuditReadFailure };

/**
 * Загрузить запись аудита.
 *
 * @param {IAuditListParams} params
 */
export const fetchAudit = createAsyncThunk<IPage<IAuditEvent>, IAuditListParams, TAuditReadConfig>(
    'audit/fetchAudit', async (params, { rejectWithValue }) => {
        try { return await bffApi.listAudit(params); }
        catch (error) {
            return rejectWithValue({
                message: errorMessage(error, 'Не удалось загрузить историю операций'),
                accessDenied: isAxiosError(error) && [401, 403, 404].includes(error.response?.status ?? 0),
            });
        }
    },
    { condition: (_, { getState }) => {
        const { userBlock, audit } = getState();
        if (!userBlock.isAuth || !userBlock.user?.routePermissions.includes(AUDIT_ROUTE)) { return false; }
        return audit.authScope === authDataScope({ user: userBlock.user, policies: userBlock.policies });
    } },
);
