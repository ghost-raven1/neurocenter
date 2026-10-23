import type {ModelRateDraft, ModelRateLimit, ModelRateLimitInput, ModelRateState} from './types';

export const initialModelRateState = (): ModelRateState => ({draft: {requests: null, seconds: null, enabled: true}, loading: false, saving: false, error: '', notice: ''});
export const rateDraft = (policy: ModelRateLimit): ModelRateDraft => ({requests: policy.requests, seconds: policy.windowMs / 1000, enabled: policy.enabled});
export const rateMatches = (policy: ModelRateLimit, input: Pick<ModelRateLimitInput, 'requests' | 'windowMs' | 'enabled'>): boolean => policy.requests === input.requests && policy.windowMs === input.windowMs && policy.enabled === input.enabled;
export const rateDescription = (policy: Pick<ModelRateLimit, 'requests' | 'windowMs' | 'enabled'>): string => policy.enabled ? `${policy.requests} запросов за ${(policy.windowMs / 1000).toLocaleString('ru-RU')} с` : 'Без ограничения запросов';

/** Seconds stay a presentation unit; server comparisons always use exact whole milliseconds. */
export function rateInput(draft: ModelRateDraft, expectedRevision: number): ModelRateLimitInput {
    if (draft.requests === null || !Number.isInteger(draft.requests) || draft.requests < 1 || draft.requests > 1000) throw new Error('Укажите целое число запросов от 1 до 1000.');
    const windowMs = Math.round((draft.seconds ?? 0) * 1000);
    if (draft.seconds === null || !Number.isFinite(draft.seconds) || windowMs < 1000 || windowMs > 86400000 || Math.abs(draft.seconds * 1000 - windowMs) > 0.00001) throw new Error('Укажите период от 1 до 86400 секунд, до трёх знаков после запятой.');
    return {expectedRevision, requests: draft.requests, windowMs, enabled: draft.enabled};
}
