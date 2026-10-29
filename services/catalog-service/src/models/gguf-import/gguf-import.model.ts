import {BadRequestException} from '@nestjs/common';
import type {GgufImportIntent,GgufImportReceipt,GgufMetadata} from '../../../../shared/gguf-import';
import type {GgufImportPolicy} from '../../../../shared/gguf-import-policy.cjs';
import {uploadId} from '../../source-upload/source-upload.model';
import {validateModelCreate} from '../model-validation';

export {uploadId as ggufImportId};
export interface GgufUploadRow {
 id:string;actor:string;request_key:string;request_hash:string;file_name:string;bytes:string;expected_sha256:string|null;sha256:string|null;
 state:GgufImportReceipt['state'];auth_epoch:string;lease_token:string|null;metadata:GgufMetadata|null;limits:GgufImportPolicy;
 model_id:string|null;accept_hash:string|null;expires_at:Date|string;created_at:Date|string;updated_at:Date|string;cleaned_at:Date|string|null;
}
export function ggufReceipt(row:GgufUploadRow):GgufImportReceipt{return {id:row.id,requestKey:row.request_key,fileName:row.file_name,bytes:Number(row.bytes),...(row.expected_sha256?{expectedSha256:row.expected_sha256}:{}),sha256:row.sha256,state:row.state,metadata:row.metadata,modelId:row.model_id,expiresAt:new Date(row.expires_at).toISOString(),limits:row.limits};}
/** The admission accepts a single complete GGUF; bytes remain outside JSON. */
export function ggufIntent(raw:unknown,limits:GgufImportPolicy):GgufImportIntent {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('Выберите GGUF и передайте UUID, имя и размер.');
 const item=raw as Record<string,unknown>;
 if(Object.keys(item).some(key=>!['requestKey','fileName','bytes','expectedSha256'].includes(key))||!uploadId(item.requestKey)||typeof item.fileName!=='string'||Buffer.byteLength(item.fileName,'utf8')>240||!item.fileName.toLowerCase().endsWith('.gguf')||/[\\/\x00-\x1f\x7f]/.test(item.fileName)||item.fileName.startsWith('.')||!Number.isSafeInteger(item.bytes)||Number(item.bytes)<1||Number(item.bytes)>limits.maximumBytes||item.expectedSha256!==undefined&&(typeof item.expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(item.expectedSha256)))throw new BadRequestException('Нужен один файл .gguf в пределах настроенного размера, UUID и необязательный SHA-256.');
 return {requestKey:item.requestKey.toLowerCase(),fileName:item.fileName,bytes:Number(item.bytes),...(item.expectedSha256?{expectedSha256:String(item.expectedSha256)}:{})};
}
export function ggufAcceptance(raw:unknown,id:string){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('Укажите имя и назначение модели.');const input=raw as Record<string,unknown>;
 if(Object.keys(input).some(key=>!['name','description','capability','model'].includes(key))||!['chat','embedding'].includes(String(input.capability)))throw new BadRequestException('GGUF импорт поддерживает chat и embedding.');
 return validateModelCreate({...input,runtime:'ollama',model:input.model??`imported-${id}:v1`});
}
