import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {api,hub,readState,writeState} from '../../bridge/state.js';
import type {Package} from '../../bridge/package.js';
import {projectFolder} from '../../bridge/workspace.js';
import {readPrivateConfiguration,writePrivateConfiguration} from '../local-configuration/private-store.js';
import {assertHostedInstallation,profileKey,sameSelection,validateSelection,type HostedProfile,type HostedSelection} from './profile.js';
import {createHostedRelay,inferHosted,type HostedRelay} from './relay.js';
export {readHostedRagEmbedding} from './profile.js';
export type {HostedSelection} from './profile.js';
const registry='rag-hosted-connections';
const relays=new Map<string,HostedRelay>();
let operations:Promise<void>=Promise.resolve();
async function exclusive<T>(action:()=>Promise<T>):Promise<T>{const previous=operations;let release=()=>{};operations=new Promise<void>(resolve=>{release=resolve;});await previous;try{return await action();}finally{release();}}
async function keys():Promise<string[]>{const value=await readState<unknown>(registry);if(value===undefined)return [];if(!Array.isArray(value)||value.length>128||value.some(key=>typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)))throw new Error('Повреждён список подключений RAG.');return value as string[];}
async function assertCurrent(profile:HostedProfile):Promise<void>{
    const value=await api<{revision:number;modelPin:string;profile:HostedSelection['profile']}>('embedding/context',{projectId:profile.projectId,bindingId:profile.bindingId,instanceId:profile.instanceId,expectedRevision:profile.selection.revision,expectedModelPin:profile.selection.modelPin});
    if(!sameSelection(profile.selection,{...value,model:null}))throw new Error('Модель проекта изменилась. Обновите страницу и подключите её повторно.');
}
/** Явное согласие проверяет реальную модель до атомарной публикации; индекс не открывается. */
export async function connectHostedRag(projectId:string,bindingId:string,instanceId:string,pkg:Package,selection:HostedSelection,authorize:()=>Promise<void>):Promise<{status:'connected';revision:number;modelPin:string;profile:HostedSelection['profile'];requiresRestart:true}>{
    return exclusive(async()=>{
        validateSelection(selection);await authorize();const root=await projectFolder(projectId);const key=profileKey(hub(),root,instanceId);
        const previous=await readPrivateConfiguration<HostedProfile>(key);
        const candidate:HostedProfile={schemaVersion:1,server:hub(),root,projectId,bindingId,instanceId,pkg,selection,relay:previous?.relay??{port:0,key:randomBytes(32).toString('hex')}};
        await assertHostedInstallation(candidate);await assertCurrent(candidate);
        let created:HostedRelay|undefined;const running=relays.get(key);
        if(running&&(!isDeepStrictEqual(running.profile.relay,candidate.relay)))throw new Error('Локальное подключение изменилось. Перезапустите мост.');
        try{
            if(!running)created=await createHostedRelay(candidate);
            await inferHosted(candidate,['Neurocenter embedding connection probe 1','Neurocenter embedding connection probe 2'],AbortSignal.timeout(120000));
            await authorize();await assertHostedInstallation(candidate);await assertCurrent(candidate);
            const entries=await keys();if(!entries.includes(key)){if(entries.length>=128)throw new Error('Достигнут лимит подключений RAG.');await writeState(registry,[...entries,key]);}
            await writePrivateConfiguration(key,candidate,previous);
            if(running)running.profile=structuredClone(candidate);else relays.set(key,created!);
            return {status:'connected',revision:selection.revision,modelPin:selection.modelPin,profile:selection.profile,requiresRestart:true};
        }catch(error){await created?.close();throw error;}
    });
}
/** Старый адрес сохраняется: занятый порт не заменяется другим без явного подключения. */
export async function startHostedRagConnections():Promise<void>{
    await exclusive(async()=>{for(const key of await keys()){
        if(relays.has(key))continue;
        try{const profile=await readPrivateConfiguration<HostedProfile>(key);if(!profile||profileKey(profile.server,profile.root,profile.instanceId)!==key)continue;
            if(!Number.isInteger(profile.relay?.port)||profile.relay.port<1||profile.relay.port>65535||!/^[a-f0-9]{64}$/.test(profile.relay.key))continue;
            await assertHostedInstallation(profile);relays.set(key,await createHostedRelay(profile));
        }catch{/* Недоступная или отозванная привязка не блокирует запуск остальных проектов. */}
    }});
}
/** Закрывает только собственные loopback-серверы и прерывает их текущие запросы. */
export async function stopHostedRagConnections():Promise<void>{await exclusive(async()=>{const active=[...relays.values()];relays.clear();await Promise.all(active.map(relay=>relay.close()));});}
