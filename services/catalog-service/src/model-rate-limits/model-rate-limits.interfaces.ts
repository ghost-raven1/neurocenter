export interface IModelRateLimitInput {
    expectedRevision: number;
    requests: number;
    windowMs: number;
    enabled: boolean;
}

export interface IModelRateLimitPolicy {
    modelId: string;
    revision: number;
    requests: number;
    windowMs: number;
    enabled: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
}

export interface IModelRateLimitView extends IModelRateLimitPolicy {
    canManage: boolean;
    featureEnabled: boolean;
}

export interface IModelRateAdmission {
    admitted: boolean;
    retryAfterMs: number;
}
