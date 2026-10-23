'use strict';
const RUNTIME_CACHE_POLICY_JOB='runtime-cache-policy';
const RUNTIME_CACHE_POLICY_CAPABILITY='runtime-cache-policy-v1';
const MiB=1024**2;
const RUNTIME_CACHE_POLICY_LIMITS=Object.freeze({defaultBytes:2048*MiB,minBytes:1024*MiB,maxBytes:16384*MiB,stepBytes:MiB});
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const limit=value=>integer(value)&&value>=RUNTIME_CACHE_POLICY_LIMITS.minBytes&&value<=RUNTIME_CACHE_POLICY_LIMITS.maxBytes&&value%MiB===0;

/** A machine-wide budget changes only by an explicit versioned owner command, never by a project setting. */
function normalizeRuntimeCachePolicyPayload(value){
    if(exact(value,['schemaVersion','action'])&&value.schemaVersion===1&&value.action==='inspect')return {schemaVersion:1,action:'inspect'};
    if(exact(value,['schemaVersion','action','expectedRevision','limitBytes'])&&value.schemaVersion===1&&value.action==='set'&&integer(value.expectedRevision)&&value.expectedRevision<Number.MAX_SAFE_INTEGER&&limit(value.limitBytes))
        return {schemaVersion:1,action:'set',expectedRevision:value.expectedRevision,limitBytes:value.limitBytes};
    throw new TypeError('Нужны действие кэша, актуальная ревизия и целый лимит от 1024 до 16384 МиБ.');
}

/** Only non-secret numeric policy metadata leaves the device; inspection may reveal usage above its budget. */
function normalizeRuntimeCachePolicyResult(value){
    const keys=['schemaVersion','revision','limitBytes','usedBytes','defaultBytes','minBytes','maxBytes','observedAt'];
    if(!exact(value,keys)||value.schemaVersion!==1||!integer(value.revision)||!limit(value.limitBytes)||!integer(value.usedBytes)
        ||value.defaultBytes!==RUNTIME_CACHE_POLICY_LIMITS.defaultBytes||value.minBytes!==RUNTIME_CACHE_POLICY_LIMITS.minBytes||value.maxBytes!==RUNTIME_CACHE_POLICY_LIMITS.maxBytes
        ||typeof value.observedAt!=='string'||!Number.isFinite(Date.parse(value.observedAt))||new Date(value.observedAt).toISOString()!==value.observedAt)
        throw new TypeError('Некорректная квитанция настройки кэша компьютера.');
    return {schemaVersion:1,revision:value.revision,limitBytes:value.limitBytes,usedBytes:value.usedBytes,defaultBytes:value.defaultBytes,minBytes:value.minBytes,maxBytes:value.maxBytes,observedAt:value.observedAt};
}
module.exports={RUNTIME_CACHE_POLICY_JOB,RUNTIME_CACHE_POLICY_CAPABILITY,RUNTIME_CACHE_POLICY_LIMITS,normalizeRuntimeCachePolicyPayload,normalizeRuntimeCachePolicyResult};
