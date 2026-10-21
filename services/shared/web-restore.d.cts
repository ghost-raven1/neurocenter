export interface RestoreCheckpoint {id:string;label:string;sha256:string;createdAt:string}
export interface RestorePreviewInput {requestKey:string;checkpointId:string;checkpointSha256:string;targetProject:string}
export interface RestoreInput {requestKey:string;previewId:string;digest:string;confirmation:string}
export interface RestoreRunnerReport {runnerId:string;configDigest:string;targetPrefix:string;checkpoints:RestoreCheckpoint[]}
export interface RestorePreview {checkpointId:string;checkpointSha256:string;targetProject:string;configDigest:string;checkedAt:string;expiresAt:string;impact:{databases:string[];volumes:string[];files:number;bytes:number;applicationsStarted:false;currentStackChanged:false};digest:string}
export interface RestoreReceipt {ok:true;projectName:string;sha256:string;restoredAt:string;databases:number;durationMs:number;applicationsStarted:false}
export function uuid(value:unknown):value is string;
export function sha(value:unknown):value is string;
export function project(value:unknown):value is string;
export function checkpoint(value:unknown):value is string;
export function digest(value:unknown):string;
export function previewRequest(value:unknown):RestorePreviewInput;
export function restoreRequest(value:unknown):RestoreInput;
export function checkpointInfo(value:unknown):RestoreCheckpoint;
export function runnerReport(value:unknown):RestoreRunnerReport;
export function previewResult(value:unknown):RestorePreview;
export function restoreReceipt(value:unknown):RestoreReceipt;
export const restoreFailureMessages:Readonly<Record<string,string>>;
export function restoreFailureCode(error:unknown):string;
