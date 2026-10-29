'use strict';
const {TEXT_KNOWLEDGE_LIMITS,TEXT_KNOWLEDGE_CEILINGS,textKnowledgeLimits}=require('./project-text-knowledge.cjs');
const {DEFAULT_GGUF_IMPORT_POLICY,ggufImportPolicy}=require('./gguf-import-policy.cjs');
const RUNTIME_LIMIT_CEILINGS=Object.freeze({textKnowledge:TEXT_KNOWLEDGE_CEILINGS,ggufImport:Object.freeze({maximumBytes:8*1024**4,storageQuotaBytes:32*1024**4,
 maximumPendingImports:10000,metadataBytes:256*1024**2,metadataPairs:1000000,tensorCount:1000000,arrayElements:16000000,stringBytes:16*1024**2,
 activeUploads:32,uploadTimeoutMs:2147483647,checkIntervalMs:2147483647,retentionMs:3650*24*60*60*1000,diskReserveBytes:8*1024**4,
 runtimeRequestTimeoutMs:2147483647,runtimeResponseBytes:16*1024**2})});
const DEFAULT_RUNTIME_LIMIT_POLICY=Object.freeze({textKnowledge:TEXT_KNOWLEDGE_LIMITS,ggufImport:DEFAULT_GGUF_IMPORT_POLICY});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
/** The policy contains only bounded public numbers; credentials, paths and arbitrary keys are refused. */
function runtimeLimitPolicy(value){
 if(!exact(value,['textKnowledge','ggufImport']))throw new Error('Нужны полные группы лимитов текста и GGUF.');
 const textKnowledge=textKnowledgeLimits(value.textKnowledge);
 if(!exact(value.ggufImport,Object.keys(DEFAULT_GGUF_IMPORT_POLICY)))throw new Error('Нужны все объявленные лимиты импорта GGUF.');
 const ggufImport=ggufImportPolicy(value.ggufImport);
 for(const [key,max]of Object.entries(RUNTIME_LIMIT_CEILINGS.ggufImport))if(ggufImport[key]>max)throw new Error(`GGUF ${key}: максимум ${max}.`);
 if(ggufImport.maximumBytes>ggufImport.storageQuotaBytes||ggufImport.checkIntervalMs>ggufImport.uploadTimeoutMs)throw new Error('Квота GGUF должна вмещать файл, а интервал проверки — таймаут загрузки.');
 return Object.freeze({textKnowledge,ggufImport});
}
function runtimeLimitInput(value){
 if(!exact(value,['expectedRevision','requestKey','policy'])||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0
  ||typeof value.requestKey!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.requestKey))throw new Error('Передайте ревизию, ключ повтора и полную политику.');
 return {expectedRevision:value.expectedRevision,requestKey:value.requestKey,policy:runtimeLimitPolicy(value.policy)};
}
module.exports={RUNTIME_LIMIT_CEILINGS,DEFAULT_RUNTIME_LIMIT_POLICY,runtimeLimitPolicy,runtimeLimitInput};
