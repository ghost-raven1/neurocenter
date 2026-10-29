export const OPENCODE_GLOBAL_PROVIDERS_READ_JOB:'inspect-opencode-global-providers';
export const OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB:'open-opencode-global-providers';
export const OPENCODE_GLOBAL_PROVIDERS_CAPABILITY:'opencode-global-providers-v1';
export const OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION:'1.14.48';
export const OPENCODE_GLOBAL_PROVIDERS_SCHEMAS:{request:Record<string,unknown>;payloadRead:Record<string,unknown>;payloadOpen:Record<string,unknown>;inventory:Record<string,unknown>;results:Record<string,unknown>};
export type GlobalProvidersKind=typeof OPENCODE_GLOBAL_PROVIDERS_READ_JOB|typeof OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB;
export type GlobalProvidersIssue='invalid-json'|'unsafe-file'|'source-changed'|'environment-override'|'entry-limit'|'read-failed'|'permission-denied'|'cancelled'|'session-unavailable'|'unsupported-version'|'unknown';
export interface GlobalProvider {id:string;modelIds:string[];hasConfiguration:boolean;hasAuthentication:boolean;authentication:'api'|'oauth'|'wellknown'|'reference'|'none'|'unknown';enabled:boolean}
export interface OpenCodeGlobalProvidersInventory {providers:GlobalProvider[];configurationFound:boolean;authenticationFound:boolean;overrideDetected:boolean;issues:GlobalProvidersIssue[]}
export interface OpenCodeGlobalProvidersRequest {deviceId:string;kind:GlobalProvidersKind;scope:'global';requestKey:string}
export interface OpenCodeGlobalProvidersPayload {schemaVersion:1;scope:'global';deviceId:string;expiresAt?:string}
interface Identity extends OpenCodeGlobalProvidersPayload {jobId:string;checkedAt:string;kind:GlobalProvidersKind}
export type OpenCodeGlobalProvidersResult=Identity&({status:'checked'|'partial';inventory:OpenCodeGlobalProvidersInventory}|{status:'opened';expiresAt:string}|{status:'failed';issue:GlobalProvidersIssue});
export interface GlobalProvidersLimits {fileBytes:number;providers:number;modelsPerProvider:number;secretBytes:number;sessionMs:number;requestBytes:number;publicBytes:number;httpRequestMs:number;httpHeadersMs:number;httpHeadersCount:number;sessions:number}
export const DEFAULT_GLOBAL_PROVIDERS_LIMITS:Readonly<GlobalProvidersLimits>;
export function globalProvidersLimits(env?:Record<string,string|undefined>):Readonly<GlobalProvidersLimits>;
export function normalizeGlobalProvidersRequest(value:unknown):OpenCodeGlobalProvidersRequest;
export function normalizeGlobalProvidersPayload(value:unknown,kind?:string):OpenCodeGlobalProvidersPayload;
export function normalizeGlobalProvidersInventory(value:unknown):OpenCodeGlobalProvidersInventory;
export function normalizeGlobalProvidersResult(value:unknown,expected?:{deviceId:string;jobId:string;kind:string;expiresAt?:string}):OpenCodeGlobalProvidersResult;
export function globalProviderId(value:unknown):value is string;
export function globalProviderModelId(value:unknown):value is string;
