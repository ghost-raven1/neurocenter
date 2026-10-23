import {hash,readState,writeState} from '../../bridge/state.js';
import {readPrivateConfiguration,writePrivateConfiguration,removePrivateConfiguration} from '../local-configuration/private-store.js';
import type {Completion} from '../../bridge/completions.js';
import {memoryDigest,normalizeMemorySyncPayload,normalizeMemorySyncResult,type MemorySyncPayload,type MemorySyncResult} from './contract.js';
import {assertProjectionJournal,type ProjectionJournal} from './projection.js';

interface Pending {id:string;lease:string;deviceId:string;payload:MemorySyncPayload;result:MemorySyncResult}
const index='learning-memory-pending',pendingKey=(id:string)=>hash('learning-memory-result:'+id);
export const journalKey=(site:string,payload:Pick<MemorySyncPayload,'projectId'|'bindingId'|'instanceId'|'assetId'>)=>hash(JSON.stringify(['learning-memory-ownership',site,payload.projectId,payload.bindingId,payload.instanceId,payload.assetId]));
/** CAS updates retain only owned text; the pointer used by recovery contains public receipt data. */
export async function projectionStorage(key:string,namespace:string){
 let saved=await readPrivateConfiguration<ProjectionJournal>(key);
 if(saved)assertProjectionJournal(saved,namespace);
 const journal:ProjectionJournal=structuredClone(saved??{schemaVersion:1,namespace,owned:{}});
 return {journal,save:async(value:ProjectionJournal)=>{await writePrivateConfiguration(key,value,saved);saved=structuredClone(value);}};
}
export function publicMemoryResult(payload:MemorySyncPayload,planDigest:string,counts:{applied:number;removed:number;remaining:number},complete:boolean,code:MemorySyncResult['code']):MemorySyncResult{
 const {projectId,bindingId,instanceId,assetId,manifest,learningDigest,mode}=payload;
 return normalizeMemorySyncResult({schemaVersion:1,protocol:'project-learning-memory-v1',projectId,bindingId,instanceId,assetId,manifest,learningDigest,mode,status:complete?'complete':'partial',...counts,
  receiptDigest:memoryDigest([planDigest,counts,complete,code]),code},payload);
}
async function pointers():Promise<Pending[]>{
 const value=await readState<unknown>(index)??[];
 if(!Array.isArray(value)||value.length>200||new Set(value.map(item=>item?.id)).size!==value.length
  ||value.some(item=>!item||!/^[-a-f0-9]{36}$/.test(item.id)||!/^[-a-f0-9]{36}$/.test(item.lease)||!/^[-a-f0-9]{36}$/.test(item.deviceId)))throw new Error('Повреждён список квитанций Memory.');
 for(const item of value)normalizeMemorySyncResult(item.result,normalizeMemorySyncPayload(item.payload));return value;
}
export async function saveMemoryCheckpoint(value:Pending){
 const pending=await pointers();if(!pending.some(item=>item.id===value.id)){if(pending.length>=200)throw new Error('Доставьте сохранённые квитанции Memory перед новой синхронизацией.');await writeState(index,[...pending,value]);}
 const key=pendingKey(value.id),before=await readPrivateConfiguration<Pending>(key);
 if(before&&(before.deviceId!==value.deviceId||before.lease!==value.lease))throw new Error('Квитанция Memory принадлежит другому заданию.');
 await writePrivateConfiguration(key,value,before);
}
/** Recovery delivers a conservative checkpoint; it never reruns MCP mutations on its own. */
export async function recoverMemoryCompletions(save:(completion:Completion)=>Promise<void>){
 for(const pointer of await pointers()){
  const id=pointer.id,value=await readPrivateConfiguration<Pending>(pendingKey(id))??pointer;
  if(value.id!==pointer.id||value.deviceId!==pointer.deviceId||value.lease!==pointer.lease||memoryDigest(value.payload)!==memoryDigest(pointer.payload))throw new Error('Квитанция Memory относится к другому заданию.');
  const result=normalizeMemorySyncResult(value.result,normalizeMemorySyncPayload(value.payload));
  await save({id,lease:value.lease,deviceId:value.deviceId,state:result.status==='complete'?'succeeded':'failed',message:result.status==='complete'?'Принятые знания синхронизированы с Memory.':'Сохранён частичный результат. Продолжение доступно в обучении проекта.',result:{...result}});
 }
}
export async function acknowledgeMemoryCheckpoint(id:string){
 const pending=await pointers(),key=pendingKey(id),value=await readPrivateConfiguration<Pending>(key);
 await writeState(index,pending.filter(item=>item.id!==id));if(value)await removePrivateConfiguration(key,value);
}
