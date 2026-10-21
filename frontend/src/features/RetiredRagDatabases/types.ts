export interface IRetiredRagJob {id:string;retirementId:string;state:'queued'|'running'|'failed'|'succeeded';message:string;digest:string;updatedAt:string}
export interface IRetiredRagDatabase {id:string;projectId:string;projectName:string;deletedAt:string;origin:string;
    retention:{revision:number;retainUntil:string|null;reason:string;automaticPurge:false};database:{databaseName:string;state:string;present:boolean;bytes:number}|null;
    blockers:string[];job:IRetiredRagJob|null}
export interface IRetiredRagPreview {id:string;digest:string;expiresAt:string;projectName:string;retentionRevision:number;warning:string;
    facts:{identity:{cluster:string;oid:string;marker:string;databaseName:string;projectId:string};retirementId:string;bytes:number;chunks:number;generations:number;preserves:string[]}}
