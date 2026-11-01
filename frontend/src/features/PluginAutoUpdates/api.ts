import api from '../../core/api/base';
export interface IPluginUpdateTarget {
    deviceId: string;
    projectId: string;
    bindingId: string;
    assetId: string;
}
export interface IPluginUpdatePolicy {
    id: string;
    enabled: boolean;
    revision: number;
    status: string;
    message: string;
    checkedAt: string | null;
    nextCheckAt: string | null;
    job?: { id: string; state: string; message: string };
}
export interface IPluginUpdateMutation extends IPluginUpdateTarget {
    enabled: boolean;
    expectedRevision: number;
    requestKey: string;
}
export const pluginAutoUpdateApi = {
    read: (target: IPluginUpdateTarget, signal: AbortSignal) =>
        api
            .get<{ policy: IPluginUpdatePolicy | null }>('/api/plugin-auto-updates', {
                params: target,
                signal,
                timeout: 10000,
            })
            .then((value) => value.data.policy),
    save: (input: IPluginUpdateMutation, signal: AbortSignal) =>
        api
            .put<{ policy: IPluginUpdatePolicy }>('/api/plugin-auto-updates', input, { signal, timeout: 15000 })
            .then((value) => value.data.policy),
};
