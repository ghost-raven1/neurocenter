import base from '../../../core/api/base';
import { bridgeApi } from '../../McpBridge/api';
import type { IOpenCodePersonalKeyRequest } from './contract';

/** Central requests carry only the intended recipient and receipt IDs, never a credential. */
export const localKeyTransferApi = {
    open: async (input: IOpenCodePersonalKeyRequest, signal: AbortSignal): Promise<unknown> =>
        (await base.post('/api/device-jobs', input, { signal, timeout: 10000 })).data,
    request: bridgeApi.request,
    receipt: async (modelId: string, jobId: string, signal: AbortSignal): Promise<unknown> =>
        (
            await base.get(
                `/api/models/${encodeURIComponent(modelId)}/my-access/transfers/${encodeURIComponent(jobId)}`,
                { signal, timeout: 10000 },
            )
        ).data,
};
