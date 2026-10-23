export interface ModelRateLimit {
    modelId: string; revision: number; requests: number; windowMs: number; enabled: boolean;
    updatedAt: string | null; updatedBy: string | null; canManage: boolean; featureEnabled: boolean;
}
export interface ModelRateLimitInput {expectedRevision: number; requests: number; windowMs: number; enabled: boolean;}
export interface ModelRateDraft {requests: number | null; seconds: number | null; enabled: boolean;}
export interface ModelRateState {
    policy?: ModelRateLimit; draft: ModelRateDraft; baseRevision?: number;
    loading: boolean; saving: boolean; error: string; notice: string;
    conflict?: ModelRateLimit; pending?: ModelRateLimitInput;
}
