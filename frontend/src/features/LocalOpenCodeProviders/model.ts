import {normalizeGlobalProvidersResult,type OpenCodeGlobalProvidersRequest,type OpenCodeGlobalProvidersResult,type GlobalProvidersKind} from '@neurocenter/opencode-local-providers';
export const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export interface ProviderJob {id:string;deviceId:string;projectId:null;kind:GlobalProvidersKind;state:string;createdAt:string;updatedAt:string;result?:OpenCodeGlobalProvidersResult}
export const terminal=(job:ProviderJob|undefined)=>!!job&&['succeeded','failed','cancelled'].includes(job.state);
/** A request receipt binds the exact active role and immutable device-global intent. */
export async function globalRequestFingerprint(request:OpenCodeGlobalProvidersRequest,role:string){
    const raw=JSON.stringify({role,request:Object.entries(request).sort(([a],[b])=>a.localeCompare(b))});
    const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));return[...new Uint8Array(result)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function readProviderJob(value:unknown,deviceId:string,kind:GlobalProvidersKind,previous?:ProviderJob):ProviderJob{
    if(!record(value)||!uuid(value.id)||value.deviceId!==deviceId||value.projectId!==null||value.kind!==kind||!['queued','running','reconciling','succeeded','failed','cancelled'].includes(String(value.state))
        ||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))throw Error('Состояние локальной проверки не подтверждено.');
    let result:OpenCodeGlobalProvidersResult|undefined;
    if(record(value.result)&&Object.keys(value.result).length)result=normalizeGlobalProvidersResult(value.result,{deviceId,jobId:value.id,kind});
    const job={id:value.id,deviceId,projectId:null,kind,state:String(value.state),createdAt:value.createdAt,updatedAt:value.updatedAt,result} as ProviderJob;
    if(job.state==='succeeded'&&(!result||result.status==='failed')||job.state==='failed'&&result&&result.status!=='failed')throw Error('Квитанция не соответствует исходу локального действия.');
    if(previous?.id===job.id&&(terminal(previous)&&!terminal(job)||Date.parse(job.updatedAt)<Date.parse(previous.updatedAt)))throw Error('Сохранённое состояние проверки регрессировало. Перечитайте квитанцию.');
    return job;
}
