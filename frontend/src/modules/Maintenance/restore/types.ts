export interface RestoreCheckpoint {id:string;label:string;sha256:string;createdAt:string}
export interface RestorePreviewInput {requestKey:string;checkpointId:string;checkpointSha256:string;targetProject:string}
export interface RestoreInput {requestKey:string;previewId:string;digest:string;confirmation:string}
export interface RestorePreview {checkpointId:string;checkpointSha256:string;targetProject:string;configDigest:string;checkedAt:string;expiresAt:string;digest:string;impact:{databases:string[];volumes:string[];files:number;bytes:number;applicationsStarted:false;currentStackChanged:false}}
export interface RestoreReceipt {ok:true;projectName:string;sha256:string;restoredAt:string;databases:number;durationMs:number;applicationsStarted:false}
export type RestoreState='queued'|'running'|'ready'|'succeeded'|'failed'|'interrupted'|'cancelled';
export interface RestoreJob {id:string;requestKey:string;kind:'preview'|'restore';state:RestoreState;input:RestorePreviewInput|RestoreInput;preview:RestorePreview|null;receipt:RestoreReceipt|null;errorCode:string|null;message:string;createdAt:string;updatedAt:string}
export interface RestoreStatus {runner:{available:boolean;targetPrefix?:string;lastSeenAt?:string};checkpoints:RestoreCheckpoint[];jobs:RestoreJob[]}
export type RestoreIntent={kind:'preview';input:RestorePreviewInput}|{kind:'restore';input:RestoreInput};
export const restoreTerminal=(job:RestoreJob|undefined)=>!!job&&['ready','succeeded','failed','interrupted','cancelled'].includes(job.state);
