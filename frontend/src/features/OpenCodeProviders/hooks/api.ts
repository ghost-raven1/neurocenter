import api from '../../../core/api/base';
import type { TProviderSetupRequest } from '../interfaces';

/** Only public target IDs and immutable pins cross the site API; local form values have no API field. */
export const providerSetupApi = {
    create: async (input: TProviderSetupRequest): Promise<unknown> =>
        (await api.post('/api/device-jobs', input, { timeout: 10000 })).data,
};
