import type {RestorePreviewInput,RestoreInput,RestorePreview,RestoreReceipt,RestoreRunnerReport} from '../../../shared/web-restore.cjs';
export type {RestorePreviewInput,RestoreInput,RestorePreview,RestoreReceipt,RestoreRunnerReport};
export type RestoreState='queued'|'running'|'ready'|'succeeded'|'failed'|'interrupted'|'cancelled';
export interface RestoreJob {
 id:string;actor:string;request_key:string;kind:'preview'|'restore';input:RestorePreviewInput|RestoreInput;
 input_hash:string;state:RestoreState;preview:RestorePreview|null;receipt:RestoreReceipt|null;error_code:string|null;
 message:string;runner_id:string|null;lease_id:string|null;lease_until:Date|null;created_at:Date;updated_at:Date;
}
export interface RestoreRunner {runner_id:string;config_digest:string;target_prefix:string;checkpoints:RestoreRunnerReport['checkpoints'];seen_at:Date}
/** API не раскрывает серверные пути, Docker stderr или служебную аренду. */
export const restoreJobView=(row:RestoreJob)=>({id:row.id,requestKey:row.request_key,kind:row.kind,state:row.state,input:row.input,
 preview:row.preview,receipt:row.receipt,errorCode:row.error_code,message:row.message,createdAt:row.created_at,updatedAt:row.updated_at});
