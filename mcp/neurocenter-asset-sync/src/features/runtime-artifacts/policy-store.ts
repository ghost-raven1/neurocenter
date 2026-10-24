import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {hash} from '../../bridge/state.js';
import {readPrivateConfiguration} from '../local-configuration/private-store.js';
import {updateCleanup} from './update-cleanup.js';
import type {RuntimeCachePolicyResult} from '../../../../../services/shared/runtime-cache-policy.cjs';

const contract=createRequire(import.meta.url)(fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../../../../services/shared/runtime-cache-policy.cjs':'../../shared/runtime-cache-policy.cjs',import.meta.url))) as typeof import('../../../../../services/shared/runtime-cache-policy.cjs');
export const {RUNTIME_CACHE_POLICY_JOB,RUNTIME_CACHE_POLICY_CAPABILITY,RUNTIME_CACHE_POLICY_LIMITS,RUNTIME_CACHE_TARGET_LIMITS,normalizeRuntimeCachePolicyPayload,normalizeRuntimeCachePolicyResult}=contract;
export const runtimeCachePolicyKey=hash('runtime-cache-policy:v1');
export const runtimeCacheReceiptKey=(jobId:string)=>hash('runtime-cache-policy-receipt:v1:'+jobId);
export interface RuntimeCachePolicyReceipt {schemaVersion:1;jobId:string;lease:string;deviceId:string;payloadHash:string;result:RuntimeCachePolicyResult}
export interface RuntimeCachePolicy {schemaVersion:1;revision:number;limitBytes:number;lastChange:RuntimeCachePolicyReceipt;cleanup?:import('../../../../../services/shared/runtime-cache-policy.cjs').BridgeUpdateCleanupPolicy}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');

/** Локальный журнал хранит только численный лимит и квитанцию; настройки проектов в него не входят. */
export function normalizeRuntimeCacheReceipt(value:unknown):RuntimeCachePolicyReceipt {
    if(!exact(value,['schemaVersion','jobId','lease','deviceId','payloadHash','result'])||value.schemaVersion!==1||!uuid(value.jobId)||!uuid(value.lease)||!uuid(value.deviceId)||typeof value.payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(value.payloadHash))throw new Error('Повреждена квитанция настройки кэша.');
    return {...value,result:normalizeRuntimeCachePolicyResult(value.result)} as RuntimeCachePolicyReceipt;
}

export async function readRuntimeCachePolicy():Promise<RuntimeCachePolicy|undefined> {
    const value=await readPrivateConfiguration<unknown>(runtimeCachePolicyKey);
    if(value===undefined)return undefined;
    if(!exact(value,['schemaVersion','revision','limitBytes','lastChange',...(value&&typeof value==='object'&&Object.hasOwn(value,'cleanup')?['cleanup']:[])])||value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||Number(value.revision)<1)throw new Error('Повреждена настройка кэша.');
    const lastChange=normalizeRuntimeCacheReceipt(value.lastChange);
    if(lastChange.result.revision!==value.revision||lastChange.result.limitBytes!==value.limitBytes)throw new Error('Квитанция не соответствует настройке кэша.');
    const cleanup=Object.hasOwn(value,'cleanup')?updateCleanup.normalizeCleanupPolicy(value.cleanup):undefined;
    if(lastChange.result.schemaVersion===2&&JSON.stringify(lastChange.result.cleanup)!==JSON.stringify(cleanup))throw new Error('Квитанция не соответствует настройке очистки.');
    return {...value,lastChange,...(cleanup?{cleanup}:{})} as RuntimeCachePolicy;
}

export async function readBridgeCleanupPolicy(){return (await readRuntimeCachePolicy())?.cleanup??updateCleanup.normalizeCleanupPolicy();}

/** Значение по умолчанию сохраняет прежний предел; повреждённая настройка не расширяет бюджет. */
export async function runtimeCacheLimit():Promise<number> {
    return (await readRuntimeCachePolicy())?.limitBytes??RUNTIME_CACHE_POLICY_LIMITS.defaultBytes;
}
