'use strict';
const RUNTIME_CACHE_POLICY_JOB='runtime-cache-policy';
const RUNTIME_CACHE_POLICY_CAPABILITY='runtime-cache-policy-v1';
const BRIDGE_UPDATE_CLEANUP_CAPABILITY='bridge-update-cleanup-v1';
const BRIDGE_UPDATE_CURRENT_ONLY_CAPABILITY='bridge-update-current-only-v1';
const RUNTIME_CACHE_TARGET_CAPABILITY='runtime-cache-target-v2';
const {normalizeCleanupPolicy}=require('./bridge-update-cleanup.cjs');
const MiB=1024**2;
const RUNTIME_CACHE_POLICY_LIMITS=Object.freeze({defaultBytes:2048*MiB,minBytes:1024*MiB,maxBytes:16384*MiB,stepBytes:MiB});
const RUNTIME_CACHE_TARGET_LIMITS=Object.freeze({defaultBytes:2048*MiB,minBytes:MiB,maxBytes:Math.floor(Number.MAX_SAFE_INTEGER/MiB)*MiB,stepBytes:MiB});
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const limit=value=>integer(value)&&value>=RUNTIME_CACHE_POLICY_LIMITS.minBytes&&value<=RUNTIME_CACHE_POLICY_LIMITS.maxBytes&&value%MiB===0;
const target=value=>integer(value)&&value>=RUNTIME_CACHE_TARGET_LIMITS.minBytes&&value<=RUNTIME_CACHE_TARGET_LIMITS.maxBytes&&value%MiB===0;

/** A machine-wide budget changes only by an explicit versioned owner command, never by a project setting. */
function normalizeRuntimeCachePolicyPayload(value){
    if(exact(value,['schemaVersion','action'])&&value.schemaVersion===1&&value.action==='inspect')return {schemaVersion:1,action:'inspect'};
    if(exact(value,['schemaVersion','action'])&&value.schemaVersion===2&&value.action==='inspect')return {schemaVersion:2,action:'inspect'};
    if(exact(value,['schemaVersion','action','expectedRevision','cleanup'])&&value.schemaVersion===2&&value.action==='set-cleanup'&&integer(value.expectedRevision)&&value.expectedRevision<Number.MAX_SAFE_INTEGER)
        return {schemaVersion:2,action:'set-cleanup',expectedRevision:value.expectedRevision,cleanup:normalizeCleanupPolicy(value.cleanup)};
    if(exact(value,['schemaVersion','action','expectedRevision','limitBytes'])&&value.schemaVersion===1&&value.action==='set'&&integer(value.expectedRevision)&&value.expectedRevision<Number.MAX_SAFE_INTEGER&&limit(value.limitBytes))
        return {schemaVersion:1,action:'set',expectedRevision:value.expectedRevision,limitBytes:value.limitBytes};
    if(exact(value,['schemaVersion','action','expectedRevision','limitBytes'])&&value.schemaVersion===2&&value.action==='set'&&integer(value.expectedRevision)&&value.expectedRevision<Number.MAX_SAFE_INTEGER&&target(value.limitBytes))
        return {schemaVersion:2,action:'set',expectedRevision:value.expectedRevision,limitBytes:value.limitBytes};
    throw new TypeError('Нужны действие кэша, актуальная ревизия и положительный целый объём в МиБ; для прежнего протокола обновите мост.');
}

/** Only non-secret numeric policy metadata leaves the device; inspection may reveal usage above its budget. */
function normalizeRuntimeCachePolicyResult(value){
    const keys=['schemaVersion','revision','limitBytes','usedBytes','defaultBytes','minBytes','maxBytes','observedAt'];
    const version=record(value)&&value.schemaVersion;
    const bounds=version===2?RUNTIME_CACHE_TARGET_LIMITS:RUNTIME_CACHE_POLICY_LIMITS;
    if(!exact(value,version===2?[...keys,'cleanup']:keys)||![1,2].includes(version)||!integer(value.revision)||!(version===2?target:limit)(value.limitBytes)||!integer(value.usedBytes)
        ||value.defaultBytes!==bounds.defaultBytes||value.minBytes!==bounds.minBytes||value.maxBytes!==bounds.maxBytes
        ||typeof value.observedAt!=='string'||!Number.isFinite(Date.parse(value.observedAt))||new Date(value.observedAt).toISOString()!==value.observedAt)
        throw new TypeError('Некорректная квитанция настройки кэша компьютера.');
    return {schemaVersion:version,revision:value.revision,limitBytes:value.limitBytes,usedBytes:value.usedBytes,defaultBytes:value.defaultBytes,minBytes:value.minBytes,maxBytes:value.maxBytes,observedAt:value.observedAt,...(version===2?{cleanup:normalizeCleanupPolicy(value.cleanup)}:{})};
}
module.exports={RUNTIME_CACHE_POLICY_JOB,RUNTIME_CACHE_POLICY_CAPABILITY,BRIDGE_UPDATE_CLEANUP_CAPABILITY,BRIDGE_UPDATE_CURRENT_ONLY_CAPABILITY,RUNTIME_CACHE_TARGET_CAPABILITY,RUNTIME_CACHE_POLICY_LIMITS,RUNTIME_CACHE_TARGET_LIMITS,normalizeRuntimeCachePolicyPayload,normalizeRuntimeCachePolicyResult};
