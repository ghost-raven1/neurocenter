import base from '../../core/api/base';
import type { IOpenCodeGlobalProvidersRequest } from '@neurocenter/opencode-local-providers';
export interface ILocalProvidersApi {
    list(signal: AbortSignal): Promise<unknown>;
    request(key: string, signal: AbortSignal): Promise<unknown>;
    create(request: IOpenCodeGlobalProvidersRequest, signal: AbortSignal): Promise<unknown>;
    cancel(id: string, signal: AbortSignal): Promise<void>;
}
/** The remote UI transports fixed public intents only; API keys exist only in the bridge's private window. */
export const localProvidersApi: ILocalProvidersApi = {
    list: async (signal) => (await base.get('/api/device-jobs', { signal })).data,
    request: async (key, signal) =>
        (await base.get('/api/device-jobs/requests/' + encodeURIComponent(key), { signal })).data,
    create: async (input, signal) => (await base.post('/api/device-jobs', input, { signal })).data,
    cancel: async (id, signal) => {
        await base.delete('/api/device-jobs/' + encodeURIComponent(id), { signal });
    },
};
