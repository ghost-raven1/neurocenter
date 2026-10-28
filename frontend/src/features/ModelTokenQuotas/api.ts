import base from '../../core/api/base';
import type {QuotaInput, QuotaUser} from './types';

const route = (modelId: string, email: string): string => `/api/models/${encodeURIComponent(modelId)}/token-quotas/${encodeURIComponent(email)}`;
export const quotaApi = {
    async users(signal: AbortSignal): Promise<QuotaUser[]> {
        const {data} = await base.get<QuotaUser[]>('/api/platform/users', {signal, timeout: 10000});
        if (!Array.isArray(data) || data.some(value => !value || typeof value.email !== 'string' || typeof value.displayName !== 'string' || typeof value.enabled !== 'boolean')) throw Error('Некорректный список пользователей. Повторите загрузку.');
        return data.map(({email, displayName, enabled}) => ({email, displayName, enabled}));
    },
    read: (modelId: string, email: string, signal: AbortSignal): Promise<unknown> => base.get(route(modelId, email), {signal, timeout: 10000}).then(value => value.data),
    write: (modelId: string, email: string, input: QuotaInput, signal: AbortSignal): Promise<unknown> => base.put(route(modelId, email), input, {signal, timeout: 10000}).then(value => value.data),
    receipt: (modelId: string, email: string, key: string, signal: AbortSignal): Promise<unknown> => base.get(`${route(modelId, email)}/requests/${encodeURIComponent(key)}`, {signal, timeout: 10000}).then(value => value.data),
};
