import path from 'node:path';
import {hash,hub,readState,writeState,stateDir,type Credentials} from '../../bridge/state.js';
import type {Completion} from '../../bridge/completions.js';
import {syncDirectory} from '../../bridge/atomic-file.js';
import {readPrivateConfiguration,writePrivateConfiguration} from '../local-configuration/private-store.js';
import {withRuntimeCacheLock,measureRuntimeCache} from './cache.js';
import {RUNTIME_CACHE_POLICY_LIMITS,normalizeRuntimeCachePolicyPayload,normalizeRuntimeCachePolicyResult,normalizeRuntimeCacheReceipt,readRuntimeCachePolicy,runtimeCachePolicyKey,runtimeCacheReceiptKey,type RuntimeCachePolicyReceipt} from './policy-store.js';

interface PolicyJob {id:string;lease:string;payload:unknown}
const pendingIndex='runtime-cache-policy-pending';
async function pending():Promise<RuntimeCachePolicyReceipt[]> {
    const value=await readState<unknown>(pendingIndex)??[];
    if(!Array.isArray(value)||value.length>200)throw new Error('Повреждён журнал настройки кэша.');
    const receipts=value.map(normalizeRuntimeCacheReceipt);
    if(new Set(receipts.map(item=>item.jobId)).size!==receipts.length)throw new Error('Повтор в журнале настройки кэша.');
    return receipts;
}
const committed=()=>Object.assign(new Error('Лимит сохранён локально; подтверждение требует восстановления. Не отправляйте новое изменение.'),{localChangesCommitted:true});

/** Политика и её квитанция fsync-фиксируются под той же блокировкой, что и загрузка архивов. */
export async function runRuntimeCachePolicyJob(job:PolicyJob,deviceId:string,authorize:()=>Promise<unknown>) {
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(job.id))throw new Error('Некорректное задание настройки кэша.');
    const payload=normalizeRuntimeCachePolicyPayload(job.payload),payloadHash=hash(JSON.stringify(payload)),site=hub();
    const identity=async()=>{if(hub()!==site||(await readState<Credentials>('credentials'))?.deviceId!==deviceId)throw new Error('Подключение компьютера изменилось.');};
    const check=async()=>{await identity();await authorize();await identity();};
    const save=async(key:string,value:unknown,expected:unknown,beforeCommit:()=>Promise<unknown>=async()=>{})=>{
        await writePrivateConfiguration(key,value,expected,async()=>{await beforeCommit();});
        await syncDirectory(path.join(stateDir(),'local-configuration'));
    };
    return withRuntimeCacheLock(async root=>{
        await identity();
        const policy=await readRuntimeCachePolicy();
        // Перед новой записью завершаем журнал предыдущей: поздний ACK не повторяет изменение.
        if(policy){
            const prior=await readPrivateConfiguration<unknown>(runtimeCacheReceiptKey(policy.lastChange.jobId));
            if(prior===undefined){try{await save(runtimeCacheReceiptKey(policy.lastChange.jobId),policy.lastChange,undefined);}catch{throw committed();}}
            else if(JSON.stringify(normalizeRuntimeCacheReceipt(prior))!==JSON.stringify(policy.lastChange))throw new Error('Квитанция настройки изменилась.');
        }
        const stored=await readPrivateConfiguration<unknown>(runtimeCacheReceiptKey(job.id));
        if(stored!==undefined){
            const receipt=normalizeRuntimeCacheReceipt(stored);
            if(receipt.jobId!==job.id||receipt.deviceId!==deviceId||receipt.payloadHash!==payloadHash)throw new Error('Запрос настройки уже сохранён с другим содержимым.');
            return {state:'succeeded' as const,message:'Сохранённое подтверждение настройки кэша доставлено.',result:{...receipt.result}};
        }
        await check();
        const currentRevision=policy?.revision??0,currentLimit=policy?.limitBytes??RUNTIME_CACHE_POLICY_LIMITS.defaultBytes;
        const usedBytes=await measureRuntimeCache(root);
        if(payload.action==='set'&&payload.expectedRevision!==currentRevision)throw new Error('Лимит изменён в другом окне. Обновите состояние и проверьте введённое значение.');
        if(payload.action==='set'&&payload.limitBytes<usedBytes)throw new Error('Новый лимит меньше занятого объёма. Комплекты сохранены; увеличьте значение.');
        const changed=payload.action==='set'&&payload.limitBytes!==currentLimit;
        const result=normalizeRuntimeCachePolicyResult({schemaVersion:1,revision:currentRevision+(changed?1:0),limitBytes:payload.action==='set'?payload.limitBytes:currentLimit,usedBytes,
            defaultBytes:RUNTIME_CACHE_POLICY_LIMITS.defaultBytes,minBytes:RUNTIME_CACHE_POLICY_LIMITS.minBytes,maxBytes:RUNTIME_CACHE_POLICY_LIMITS.maxBytes,observedAt:new Date().toISOString()});
        const receipt=normalizeRuntimeCacheReceipt({schemaVersion:1,jobId:job.id,lease:job.lease,deviceId,payloadHash,result});
        const pointers=await pending();
        if(pointers.some(item=>item.jobId===job.id))throw new Error('Восстановите подтверждение предыдущей настройки перед продолжением.');
        if(pointers.length>=200)throw new Error('Доставьте подтверждения настроек кэша перед новым изменением.');
        // Intent фиксируется до rename: recovery различает применённый лимит и прерванную подготовку.
        await writeState(pendingIndex,[...pointers,receipt]);
        if(changed){
            let admitted=false;
            try{await save(runtimeCachePolicyKey,{schemaVersion:1,revision:result.revision,limitBytes:result.limitBytes,lastChange:receipt},policy,async()=>{await check();admitted=true;});}
            catch(error){
                // Ошибка fsync/ACK после rename не разрешает объявить настройку неизменённой.
                if(admitted)throw committed();
                throw error;
            }
        }
        try{await save(runtimeCacheReceiptKey(job.id),receipt,undefined,changed?identity:check);}catch(error){if(changed)throw committed();throw error;}
        return {state:'succeeded' as const,message:payload.action==='set'?'Лимит кэша подтверждён на компьютере.':'Состояние кэша получено с компьютера.',result:{...result}};
    });
}

/** После аварии доставляется только квитанция; повторной записи политики здесь нет. */
export async function recoverRuntimeCachePolicyCompletions(save:(value:Completion)=>Promise<void>) {
    if(!(await pending()).length)return;
    await withRuntimeCacheLock(async()=>{
        const policy=await readRuntimeCachePolicy();
        for(const pointer of await pending()){
            const stored=await readPrivateConfiguration<unknown>(runtimeCacheReceiptKey(pointer.jobId));
            const receipt=stored===undefined?policy?.lastChange.jobId===pointer.jobId?policy.lastChange:undefined:normalizeRuntimeCacheReceipt(stored);
            if(receipt&&JSON.stringify(receipt)!==JSON.stringify(pointer))throw new Error('Подтверждение настройки не соответствует журналу.');
            if(receipt)await syncDirectory(path.join(stateDir(),'local-configuration'));
            await save({id:pointer.jobId,lease:pointer.lease,deviceId:pointer.deviceId,state:receipt?'succeeded':'failed',
                message:receipt?'Сохранённое подтверждение лимита кэша доставлено.':'Подготовка настройки прервана до сохранения лимита. Обновите состояние.',result:receipt?{...receipt.result}:{}});
        }
    });
}

export async function acknowledgeRuntimeCachePolicyReceipt(jobId:string) {
    if(!(await pending()).some(item=>item.jobId===jobId))return;
    await withRuntimeCacheLock(async()=>{const values=await pending();if(values.some(item=>item.jobId===jobId))await writeState(pendingIndex,values.filter(item=>item.jobId!==jobId));});
}
