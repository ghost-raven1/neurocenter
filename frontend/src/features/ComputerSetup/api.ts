import api from '../../core/api/base';
import type {OpenCodeCliRequest} from '../../../../services/shared/computer-setup.cjs';

export interface CliObservationApi {
    list: (signal: AbortSignal) => Promise<unknown>;
    request: (key: string, signal: AbortSignal) => Promise<unknown>;
    create: (input: OpenCodeCliRequest, signal: AbortSignal) => Promise<unknown>;
    cancel: (jobId: string, signal: AbortSignal) => Promise<void>;
}

/** Only fixed inspection and receipt endpoints are exposed; a retry never creates a different job. */
export const cliObservationApi: CliObservationApi = {
    list: async signal => (await api.get('/api/device-jobs', {signal, timeout: 10000})).data,
    request: async (key, signal) => (await api.get('/api/device-jobs/requests/' + encodeURIComponent(key), {signal, timeout: 10000})).data,
    create: async (input, signal) => (await api.post('/api/device-jobs', input, {signal, timeout: 10000})).data,
    cancel: async (jobId, signal) => {await api.delete('/api/device-jobs/' + encodeURIComponent(jobId), {signal, timeout: 10000});},
};
