import type {RepositoryAdapter} from './types';
export interface SourceUploadIntent {requestKey:string;name:string;sha256:string;bytes:number}
export interface UploadedSource {type:'upload';uploadId:string;sha256:string;bytes:number;entrypoint:string}
export interface SourceUploadMetadata {
 candidates:string[];entrypoint:string;requiresEntrypointChoice:boolean;runnableKinds:['mcp'];adapter?:RepositoryAdapter;supportedTargets?:string[];
 choices:Array<{entrypoint:string;adapter:RepositoryAdapter;targets:string[];runtimeEntrypoint?:string}>;
}
export interface SourceUpload {id:string;requestKey:string;name:string;sha256:string;bytes:number;state:'WAITING'|'UPLOADING'|'READY'|'CANCELLED';expiresAt:string;metadata?:SourceUploadMetadata}
export const sourceUploadLimit=256*1024**2;
/** Build requests contain only a verified durable handle, never the binary File object. */
export function uploadedBuildSource(upload:SourceUpload,entrypoint:string):UploadedSource{
 const selected=entrypoint||upload.metadata?.entrypoint||'';
 if(upload.state!=='READY'||!upload.metadata?.candidates.includes(selected))throw new Error('Завершите загрузку и выберите проверенный файл запуска.');
 return {type:'upload',uploadId:upload.id,sha256:upload.sha256,bytes:upload.bytes,entrypoint:selected};
}
