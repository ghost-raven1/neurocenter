export interface GgufImportPolicy {maximumBytes:number;storageQuotaBytes:number;maximumPendingImports:number;metadataBytes:number;metadataPairs:number;tensorCount:number;arrayElements:number;stringBytes:number;activeUploads:number;uploadTimeoutMs:number;checkIntervalMs:number;retentionMs:number;diskReserveBytes:number;runtimeRequestTimeoutMs:number;runtimeResponseBytes:number}
export const DEFAULT_GGUF_IMPORT_POLICY:Readonly<GgufImportPolicy>;
export function ggufImportPolicy(value?:unknown):Readonly<GgufImportPolicy>;
export function configuredGgufImportPolicy(env?:NodeJS.ProcessEnv):Readonly<GgufImportPolicy>;
