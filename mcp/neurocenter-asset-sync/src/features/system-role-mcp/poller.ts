import {readState,type Credentials} from '../../bridge/state.js';
import {roleMcpApi} from './api.js';
import {deliverRoleMcpResults} from './receipts.js';
import {runSystemRoleMcpJob,type SessionJob} from './worker.js';

interface PollerDependencies {claim:(signal:AbortSignal)=>Promise<SessionJob|null>;authorize:(job:SessionJob,signal:AbortSignal)=>Promise<unknown>;
 run:typeof runSystemRoleMcpJob;complete:(job:SessionJob,value:unknown)=>Promise<unknown>;recover:(deviceId:string,signal:AbortSignal)=>Promise<void>;
 credentials:()=>Promise<Credentials|undefined>}
/** MCP transport leases run beside ordinary jobs, so browser sessions never starve a local Codex model or another role. */
export function startRoleMcpPoller(dependencies:Partial<PollerDependencies>={}){
 const deps:PollerDependencies={claim:signal=>roleMcpApi('claim',{},signal),authorize:(job,signal)=>roleMcpApi('authorize',{jobId:job.id,lease:job.lease},signal),
  run:runSystemRoleMcpJob,complete:(job,value)=>roleMcpApi('complete',{jobId:job.id,lease:job.lease,...value as object}),
  recover:deliverRoleMcpResults,credentials:()=>readState<Credentials>('credentials'),...dependencies};
 const controller=new AbortController(),tasks=new Map<string,Promise<void>>();let polling:Promise<void>|undefined;
 const tick=()=>{
  if(polling||controller.signal.aborted)return;
  polling=(async()=>{
   const credentials=await deps.credentials();if(!credentials)return;
   await deps.recover(credentials.deviceId,controller.signal);
   while(tasks.size<2&&!controller.signal.aborted){
    const job=await deps.claim(controller.signal);if(!job)return;
    if(!/^[a-f0-9-]{36}$/.test(job.id)||!/^[a-f0-9-]{36}$/.test(job.lease)||job.payload?.sessionId!==job.id||tasks.has(job.id))return;
    const task=(async()=>{
     const result=await deps.run(job,credentials.deviceId,()=>deps.authorize(job,controller.signal),{},controller.signal);
     await deps.complete(job,result).catch(()=>{});
    })().catch(()=>{}).finally(()=>tasks.delete(job.id));tasks.set(job.id,task);
   }
  })().catch(()=>{}).finally(()=>{polling=undefined;});
 };
 const timer=setInterval(tick,1000);timer.unref();tick();
 return {wake:tick,async stop(){clearInterval(timer);controller.abort();await polling;await Promise.allSettled([...tasks.values()]);},get active(){return tasks.size;}};
}
