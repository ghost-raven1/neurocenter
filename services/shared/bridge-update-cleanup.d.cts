export interface CleanupPolicy {enabled:boolean;keepPrevious:number;minAgeDays:number}
export interface RuntimeIdentity {dev:string;ino:string}
export interface RuntimeUseLease {identity:RuntimeIdentity;release():Promise<void>}
export interface CleanupResult {removed:string[];kept:Array<{path:string;reason:string}>;warnings:string[]}
export const OWNER_FILE:string;
export const CAPABILITY_FILE:string;
export const RUNTIME_USE_ENTRYPOINTS:readonly string[];
export const DEFAULT_CLEANUP_POLICY:Readonly<CleanupPolicy>;
export function normalizeCleanupPolicy(input?:unknown):CleanupPolicy;
export function controlRootForInstallRoot(installRoot:string):Promise<string>;
export function acquireRuntimeUseLease(runtimeRoot:string,options?:{required?:boolean}):Promise<RuntimeUseLease|undefined>;
export function acquireForEntrypoint(entrypoint:URL|string,options?:{ascend?:number;required?:boolean}):Promise<RuntimeUseLease|undefined>;
export function writeInstalledRuntimeReceipt(input:{installRoot:string;runtimeRoot:string}):Promise<{baselinePath:string}>;
export function writeSuccessfulBackupReceipt(input:{installRoot:string;backupRoot:string;completedAt?:number}):Promise<{eligible:boolean;receiptPath?:string;reason?:string}>;
export function cleanupSuccessfulBackups(input:{installRoot:string;policy?:CleanupPolicy;now?:number;beforeDelete?:()=>Promise<unknown>;signal?:AbortSignal}):Promise<CleanupResult>;
