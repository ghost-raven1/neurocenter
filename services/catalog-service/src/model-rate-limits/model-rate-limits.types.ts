export interface ModelRateLimitInput {
    expectedRevision: number;
    requests: number;
    windowMs: number;
    enabled: boolean;
}
export interface ModelRateLimitPolicy {
    modelId: string;
    revision: number;
    requests: number;
    windowMs: number;
    enabled: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
}
export interface ModelRateLimitView extends ModelRateLimitPolicy {
    canManage: boolean;
    featureEnabled: boolean;
}
export interface ModelRateAdmission {
    admitted: boolean;
    retryAfterMs: number;
}
export const DEFAULT_MODEL_RATE_LIMIT = {
    revision: 0,
    requests: 5,
    windowMs: 5000,
    enabled: true,
    updatedAt: null,
    updatedBy: null,
} as const;
