/** Type-only receipts keep consumer build roots intact; checked storage is separate from runtime readiness. */
export interface GgufMetadata {format:'gguf';version:2|3;architecture:string;tensorCount:number;metadataCount:number}
export interface GgufFileImport {format:'gguf';uploadId:string;sha256:string;bytes:number;fileName:string;architecture:string;version:2|3}
export interface GgufImportIntent {requestKey:string;fileName:string;bytes:number;expectedSha256?:string}
export interface GgufImportReceipt extends GgufImportIntent {
 id:string;state:'WAITING'|'UPLOADING'|'READY'|'CANCELLED'|'ACCEPTED';sha256:string|null;
 metadata:GgufMetadata|null;modelId:string|null;expiresAt:string;limits:Readonly<GgufImportPolicy>;
}
export interface GgufImportAccept {name:string;description?:string;capability:'chat'|'embedding';model?:string}
import type {GgufImportPolicy} from './gguf-import-policy.cjs';
