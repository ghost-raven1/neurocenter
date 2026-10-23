import {api,hub} from '../../bridge/state.js';
import type {Package} from '../../bridge/package.js';
import {memoryDigest,memoryNamespace,memoryEntity,normalizeMemorySyncPayload,normalizeMemorySyncContext,type MemorySyncContext,type MemorySyncResult} from './contract.js';
import {memoryTarget} from './target.js';
import {connectMemory,type MemoryPort} from './memory-client.js';
import {projectMemory} from './projection.js';
import {journalKey,projectionStorage,publicMemoryResult,saveMemoryCheckpoint} from './receipts.js';
import {recoverWorkspaceIdentity,withWorkspaceIdentityLock} from '../../bridge/workspace-identity-state.js';
import {withProjectFiles} from '../../bridge/installation-files.js';

interface MemoryJob {id:string;lease:string;payload:{memory?:unknown;package?:Package}}
interface Dependencies {context:(job:MemoryJob)=>Promise<unknown>;target:typeof memoryTarget;connect:typeof connectMemory}
/** Source changes stop the plan; explicit retry reconciles only the previously recorded owned mutations. */
export async function runLearningMemoryJob(job:MemoryJob,deviceId:string,authorize:()=>Promise<unknown>,dependencies:Partial<Dependencies>={}){
 return withWorkspaceIdentityLock(async()=>{
  const recovered=await recoverWorkspaceIdentity();
  // A killed frozen verifier also leaves its file lock; recover it before read-only installation inspection.
  if(recovered)await withProjectFiles(recovered.projectId,async()=>{});
  return runLockedLearningMemoryJob(job,deviceId,authorize,dependencies);
 });
}
/** Projection and identity handoff share the cross-process lock; old jobs cannot mutate during migration. */
async function runLockedLearningMemoryJob(job:MemoryJob,deviceId:string,authorize:()=>Promise<unknown>,dependencies:Partial<Dependencies>){
 const payload=normalizeMemorySyncPayload(job.payload.memory),deps:Dependencies={context:value=>api('learning-memory/context',{jobId:value.id,lease:value.lease}),target:memoryTarget,connect:connectMemory,...dependencies};
 const site=hub(),namespace=memoryNamespace(site,payload.projectId),planDigest=memoryDigest([site,payload]);
 let counts={applied:0,removed:0,remaining:1},result=publicMemoryResult(payload,planDigest,counts,false,'unavailable'),port:MemoryPort|undefined;
 const checkpoint=async(next:MemorySyncResult)=>{await saveMemoryCheckpoint({id:job.id,lease:job.lease,deviceId,payload,result:next});result=next;};
 await checkpoint(result);
 const cancellation=new AbortController();
 const timer=setTimeout(()=>cancellation.abort(new Error('Memory не ответил вовремя.')),120000);
 let denied=false,pollPending=false;
 const current=async()=>{try{cancellation.signal.throwIfAborted();if(hub()!==site)throw new Error('Площадка изменилась.');await authorize();}catch(error){denied=true;throw error;}};
 const poll=setInterval(()=>{if(pollPending)return;pollPending=true;void current().catch(()=>cancellation.abort()).finally(()=>{pollPending=false;});},2000);
 try{
  await current();const context:MemorySyncContext=normalizeMemorySyncContext(await deps.context(job));
  if(memoryDigest(context.payload)!==memoryDigest(payload))throw new Error('Контекст Memory изменился.');
  const target=await deps.target(payload,context.package as Package,deviceId);
  const check=async()=>{await current();await target.assertCurrent();await current();};
  await check();const storage=await projectionStorage(journalKey(site,payload),namespace);
  port=await deps.connect(target.runtime.entrypoint,target.root,cancellation.signal);
  counts=await projectMemory(port,storage.journal,context.context.entries.map(entry=>memoryEntity(namespace,entry)),planDigest,payload.mode==='cleanup',storage.save,check,
   async(applied,removed,remaining)=>{counts={applied,removed,remaining};await checkpoint(publicMemoryResult(payload,planDigest,counts,false,'unavailable'));});
  await checkpoint(publicMemoryResult(payload,planDigest,counts,true,'none'));
 }catch(error){
  const reported=(error as {code?:unknown}).code;
  const code=denied?'authorization':reported==='conflict'?'conflict':reported==='quota'?'quota':'unavailable';
  await checkpoint(publicMemoryResult(payload,planDigest,counts,false,code));
 }finally{clearTimeout(timer);clearInterval(poll);cancellation.abort();await port?.close();}
 return {state:result.status==='complete'?'succeeded' as const:'failed' as const,message:result.status==='complete'?'Принятые знания синхронизированы с Memory.':'Синхронизация выполнена частично. Повтор продолжит сохранённый план.',result:{...result}};
}
