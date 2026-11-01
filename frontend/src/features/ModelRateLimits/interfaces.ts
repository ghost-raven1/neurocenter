export interface IModelRateLimit {
    modelId: string;
    revision: number;
    requests: number;
    windowMs: number;
    enabled: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
    canManage: boolean;
    featureEnabled: boolean;
}
export interface IModelRateLimitInput {
    expectedRevision: number;
    requests: number;
    windowMs: number;
    enabled: boolean;
}
export interface IModelRateDraft {
    requests: number | null;
    seconds: number | null;
    enabled: boolean;
}
export interface IModelRateState {
    policy?: IModelRateLimit;
    draft: IModelRateDraft;
    baseRevision?: number;
    loading: boolean;
    saving: boolean;
    error: string;
    notice: string;
    conflict?: IModelRateLimit;
    pending?: IModelRateLimitInput;
}
