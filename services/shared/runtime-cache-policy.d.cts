export const RUNTIME_CACHE_POLICY_JOB:'runtime-cache-policy';
export const RUNTIME_CACHE_POLICY_CAPABILITY:'runtime-cache-policy-v1';
export const RUNTIME_CACHE_POLICY_LIMITS:Readonly<{defaultBytes:number;minBytes:number;maxBytes:number;stepBytes:number}>;
export type RuntimeCachePolicyPayload={schemaVersion:1;action:'inspect'}|{schemaVersion:1;action:'set';expectedRevision:number;limitBytes:number};
export interface RuntimeCachePolicyResult {schemaVersion:1;revision:number;limitBytes:number;usedBytes:number;defaultBytes:number;minBytes:number;maxBytes:number;observedAt:string}
export function normalizeRuntimeCachePolicyPayload(value:unknown):RuntimeCachePolicyPayload;
export function normalizeRuntimeCachePolicyResult(value:unknown):RuntimeCachePolicyResult;
