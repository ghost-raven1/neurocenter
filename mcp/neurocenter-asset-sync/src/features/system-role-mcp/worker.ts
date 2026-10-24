import {setTimeout as delay} from 'node:timers/promises';
import {hub} from '../../bridge/state.js';
import {roleMcpApi} from './api.js';
import {sendRoleMcpResult} from './receipts.js';
import {roleMcpTarget} from './target.js';
import {connectRoleMcp,type RoleMcpPort} from './client.js';
import {SYSTEM_ROLE_MCP_LIMITS as limits,type RoleMcpSessionContext,type RoleMcpCallContext} from './contract.js';

export interface SessionJob {id:string;lease:string;project_id?:string|null;payload:Record<string,unknown>}
interface Dependencies {context:(job:SessionJob)=>Promise<RoleMcpSessionContext>;next:(job:SessionJob)=>Promise<RoleMcpCallContext|{closed:true}|null>;
 dispatch:(job:SessionJob,call:RoleMcpCallContext)=>Promise<unknown>;result:(job:SessionJob,call:RoleMcpCallContext,value:unknown)=>Promise<unknown>;
 target:typeof roleMcpTarget;connect:typeof connectRoleMcp}
/** One queue lease owns the browser session. A disconnected dispatch is never replayed by a new worker. */
export async function runSystemRoleMcpJob(job:SessionJob,deviceId:string,authorize:()=>Promise<unknown>,dependencies:Partial<Dependencies>={},signal?:AbortSignal){
 const controller=new AbortController(),externalAbort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',externalAbort,{once:true});if(signal?.aborted)externalAbort();
 const body={jobId:job.id,lease:job.lease},deps:Dependencies={context:()=>roleMcpApi('context',body,controller.signal),next:()=>roleMcpApi('next',body,controller.signal),
  dispatch:(_job,call)=>roleMcpApi('dispatch',{...body,callId:call.id},controller.signal),result:(_job,call,result)=>sendRoleMcpResult({...body,callId:call.id,result},deviceId,call.kind,controller.signal),
  target:roleMcpTarget,connect:connectRoleMcp,...dependencies};
 const site=hub();let port:RoleMcpPort|undefined,target:Awaited<ReturnType<typeof roleMcpTarget>>|undefined,pending=false;
 const timer=setTimeout(()=>controller.abort(new Error('Сессия MCP превысила время ожидания.')),limits.sessionMs);timer.unref();
 const check=async()=>{controller.signal.throwIfAborted();if(hub()!==site)throw new Error('Площадка изменилась.');await authorize();controller.signal.throwIfAborted();};
 const poll=setInterval(()=>{if(pending)return;pending=true;void check().catch(error=>controller.abort(error)).finally(()=>{pending=false;});},1000);poll.unref();
 let state:'succeeded'|'failed'='succeeded';
 try{
  await check();const context=await deps.context(job);
  if(context.jobId!==job.id||context.projectId!==job.project_id||context.sessionId!==job.payload.sessionId||Date.parse(context.deadlineAt)<=Date.now())throw new Error('Сессия MCP изменилась или истекла.');
  const expires=setTimeout(()=>controller.abort(),Math.max(1,Date.parse(context.deadlineAt)-Date.now()));expires.unref();
  try{
   target=await deps.target(context,deviceId,check);port=await deps.connect(target.launch,controller.signal,async()=>{await check();await target!.check();});
   while(true){
    await check();const call=await deps.next(job);if(!call){await delay(200,undefined,{signal:controller.signal});continue;}if('closed'in call)break;
    if(Date.parse(call.deadlineAt)<=Date.now())throw new Error('Вызов MCP истёк до отправки.');
    let dispatched=false,completed=false;
    try{
     if(call.kind==='list'){await check();await target!.check();dispatched=true;await deps.dispatch(job,call);}
     const value=call.kind==='list'?{tools:await port.list()}:await port.call(call.name!,call.schemaDigest!,call.arguments!,async()=>{
      await check();await target!.check();dispatched=true;await deps.dispatch(job,call);
     });
     // Delivery may be retried by the caller only with this same call ID; a new call is never created here.
     completed=true;await deps.result(job,call,{state:'succeeded',value});
    }catch{
     if(completed)throw new Error('Результат MCP завершён, но его локальная квитанция недоступна.');
     await deps.result(job,call,{state:dispatched?'unknown':'failed',message:dispatched?'MCP получил запрос, но подтверждение результата потеряно. Повтор не выполнен.':'MCP не выполнил запрос: проверьте подключение, настройку и аргументы.'}).catch(()=>{});
     if(dispatched)throw new Error('Нужна проверка неизвестного результата MCP.');
    }
   }
  }finally{clearTimeout(expires);}
 }catch{state='failed';}
 finally{clearTimeout(timer);clearInterval(poll);signal?.removeEventListener('abort',externalAbort);controller.abort();await port?.close();await target?.close();}
 return {state,message:'Сессия инструментов системного агента закрыта. Результаты вызовов сохранены отдельно.',result:{schemaVersion:1,sessionId:String(job.payload.sessionId??''),closed:true}};
}
