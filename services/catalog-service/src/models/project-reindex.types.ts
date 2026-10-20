import type { IProjectEmbeddingProfile, IProjectRagContext } from './project-embedding.types';

export interface IReindexConnectionTarget {deviceId:string;assetId:string;assetKind:'mcp'|'plugin';version:number;expectedManifest:string;expectedBindingId:string;expectedInstanceId:string;}
export interface IReindexPlanData {
    context:IProjectRagContext;
    connection?:IReindexConnectionTarget;
    modelId:string;modelPin:string;profile:IProjectEmbeddingProfile;
    sourceSnapshot:string|null;rowCount:number;requiredBytes:number;
}
export interface IProjectReindexPlan {
    id:string;projectId:string;state:'preparing'|'needs_input'|'building'|'ready'|'applied'|'failed'|'cancelling'|'cancelled'|'stale';
    digest:string;approved:boolean;data:IReindexPlanData;progress:number;message:string;createdAt:string;
    local?:{jobId:string|null;state:string;message:string;percent:number|null};
}
export interface IReindexRow {
    id:string;project_id:string;request_key:string;actor:string;active_role:string;state:IProjectReindexPlan['state'];
    digest:string;approved:boolean;data:IReindexPlanData;connection_job_id?:string|null;connection_error?:string|null;connection_request_key?:string;progress:number|string;message:string;created_at:string|Date;
}
export interface IGenerationReceipt {
    id:string;projectId:string;profile:IProjectEmbeddingProfile;state:'building'|'ready'|'cancelled'|'failed';
    sourceGeneration:string;sourceSnapshot:string;rowCount:number;processedRows:number;snapshotHash:string|null;receiptHash:string|null;
}
