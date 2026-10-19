import api from '../../core/api/base';
import type { IEvaluatedFeatureFlags, IFeatureFlag, IFeatureFlagList, TFeatureFlagKey } from './types';

/** Общий клиент сохраняет проверку сессии и владельца ответа. */
export const featureFlagsApi = {
    list: (): Promise<IFeatureFlagList> => api.get<IFeatureFlagList>('/api/feature-flags').then(result => result.data),
    update: (key: TFeatureFlagKey, enabled: boolean, expectedRevision: number): Promise<IFeatureFlag> =>
        api.patch<IFeatureFlag>('/api/feature-flags/' + key, { enabled, expectedRevision }).then(result => result.data),
    evaluated: (): Promise<IEvaluatedFeatureFlags> => api.get<IEvaluatedFeatureFlags>('/api/feature-flags/evaluated').then(result => result.data),
};
