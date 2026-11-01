import baseApi from '../../core/api/base';
import type { IModelRateLimit, IModelRateLimitInput } from './interfaces';

/** Validate the independent policy receipt before it becomes an editable revision. */
function checked(value: IModelRateLimit, modelId: string): IModelRateLimit {
    if (
        !value ||
        value.modelId !== modelId ||
        !Number.isInteger(value.revision) ||
        value.revision < 0 ||
        !Number.isInteger(value.requests) ||
        value.requests < 1 ||
        value.requests > 1000 ||
        !Number.isInteger(value.windowMs) ||
        value.windowMs < 1000 ||
        value.windowMs > 86400000 ||
        typeof value.enabled !== 'boolean' ||
        typeof value.canManage !== 'boolean' ||
        typeof value.featureEnabled !== 'boolean' ||
        !(value.updatedBy === null || typeof value.updatedBy === 'string') ||
        !(
            value.updatedAt === null ||
            (typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)))
        )
    )
        throw new Error('Сервер вернул некорректные настройки лимита. Обновите сведения.');
    return value;
}
const route = (id: string) => `/api/models/${encodeURIComponent(id)}/rate-limit`;
export const modelRateApi = {
    async read(modelId: string, projectId: string | undefined, signal: AbortSignal): Promise<IModelRateLimit> {
        const response = await baseApi.get<IModelRateLimit>(route(modelId), {
            signal,
            timeout: 10000,
            ...(projectId ? { params: { projectId } } : {}),
        });
        return checked(response.data, modelId);
    },
    async write(modelId: string, input: IModelRateLimitInput, signal: AbortSignal): Promise<IModelRateLimit> {
        const response = await baseApi.put<IModelRateLimit>(route(modelId), input, { signal, timeout: 10000 });
        return checked(response.data, modelId);
    },
};
