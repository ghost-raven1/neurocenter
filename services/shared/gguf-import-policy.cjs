'use strict';
/** Defaults are configurable admission policy; each created import retains its effective snapshot. */
const DEFAULT_GGUF_IMPORT_POLICY=Object.freeze({maximumBytes:64*1024**3,storageQuotaBytes:256*1024**3,maximumPendingImports:32,metadataBytes:64*1024**2,metadataPairs:65536,tensorCount:100000,arrayElements:2000000,stringBytes:1024**2,activeUploads:3,uploadTimeoutMs:24*60*60*1000,checkIntervalMs:1000,retentionMs:24*60*60*1000,diskReserveBytes:1024**3,runtimeRequestTimeoutMs:30000,runtimeResponseBytes:1024**2});
function ggufImportPolicy(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_GGUF_IMPORT_POLICY,key)))throw new Error('Некорректная политика импорта GGUF.');
 const result={...DEFAULT_GGUF_IMPORT_POLICY,...value};
 if(Object.values(result).some(number=>!Number.isSafeInteger(number)||number<1)||result.uploadTimeoutMs>2147483647||result.checkIntervalMs>2147483647||result.runtimeRequestTimeoutMs>2147483647||result.diskReserveBytes+result.maximumBytes>Number.MAX_SAFE_INTEGER)throw new Error('Лимиты импорта GGUF должны быть положительными безопасными целыми числами.');
 return Object.freeze(result);
}
function configuredGgufImportPolicy(env=process.env){return ggufImportPolicy(env.GGUF_IMPORT_POLICY_JSON?JSON.parse(env.GGUF_IMPORT_POLICY_JSON):{});}
module.exports={DEFAULT_GGUF_IMPORT_POLICY,ggufImportPolicy,configuredGgufImportPolicy};
