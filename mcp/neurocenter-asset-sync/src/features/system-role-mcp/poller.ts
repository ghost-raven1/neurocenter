import {readState,type Credentials} from '../../bridge/state.js';
import {roleMcpApi,captureRoleMcpIdentity,type RoleMcpIdentity} from './api.js';
import {deliverRoleMcpResults} from './receipts.js';
import {runSystemRoleMcpJob,type SessionJob} from './worker.js';
import {beginRoleMcpIntent,retainRoleMcpClaim,retainRoleMcpCompletion,retireRoleMcpIntent} from './session-journal.js';
import {roleMcpProcessOwner,roleMcpLifecycleSupported} from './owned-process.js';
import {roleMcpLocalSession,cleanRoleMcpSession} from './local-session.js';
import {assertRoleMcpClaim,recoverRoleMcpSessions,acknowledgeRoleMcpCompletion,type RoleMcpClaimRequest} from './session-recovery.js';

interface PollerDependencies {claim:(signal:AbortSignal,request:RoleMcpClaimRequest,identity:RoleMcpIdentity)=>Promise<SessionJob|null>;authorize:(job:SessionJob,signal:AbortSignal,identity:RoleMcpIdentity)=>Promise<unknown>;
 run:typeof runSystemRoleMcpJob;complete:(job:SessionJob,value:unknown,identity:RoleMcpIdentity)=>Promise<unknown>;recover:(deviceId:string,signal:AbortSignal)=>Promise<void>;
 credentials:()=>Promise<Credentials|undefined>;identity:()=>Promise<RoleMcpIdentity>}
/** MCP transport leases run beside ordinary jobs, so browser sessions never starve a local Codex model or another role. */
export function startRoleMcpPoller(dependencies:Partial<PollerDependencies>={}){
 const deps:PollerDependencies={claim:(signal,request,identity)=>roleMcpApi('claim',request,signal,identity),authorize:(job,signal,identity)=>roleMcpApi('authorize',{jobId:job.id,lease:job.lease},signal,identity),
  run:runSystemRoleMcpJob,complete:(job,value,identity)=>roleMcpApi('complete',{jobId:job.id,lease:job.lease,...value as object},undefined,identity),
  recover:deliverRoleMcpResults,credentials:()=>readState<Credentials>('credentials'),identity:captureRoleMcpIdentity,...dependencies};
 const controller=new AbortController(),tasks=new Map<string,Promise<void>>(),active=new Set<string>();let polling:Promise<void>|undefined;
 let owner:Awaited<ReturnType<typeof roleMcpProcessOwner>>|undefined;
 const tick=()=>{
  if(polling||controller.signal.aborted||!roleMcpLifecycleSupported())return;
  polling=(async()=>{
   const credentials=await deps.credentials();if(!credentials)return;const identity=await deps.identity();if(identity.deviceId!==credentials.deviceId)return;
   owner??=await roleMcpProcessOwner();
   await deps.recover(credentials.deviceId,controller.signal);
   await recoverRoleMcpSessions(identity,active,request=>deps.claim(controller.signal,request,identity),deps.complete);
   while(tasks.size<2&&!controller.signal.aborted){
    let intent=await beginRoleMcpIntent(identity,owner);const job=await deps.claim(controller.signal,{requestId:intent.requestId,recoveryOnly:false},identity);
    if(!job){await retireRoleMcpIntent(identity,intent);return;}
    assertRoleMcpClaim(job,intent.requestId);if(tasks.has(job.id))throw new Error('Сессия MCP уже выполняется.');
    intent=await retainRoleMcpClaim(identity,intent,job);if(job.recoveryOnly)continue;
    const ownership=await roleMcpLocalSession(identity,()=>intent,item=>{intent=item;});active.add(intent.requestId);
    const task=(async()=>{
     // Cancellation can stop awaiting a retain, but cannot cancel its filesystem
     // commit. Drain that exact session's write before publishing or retiring it.
     const result=await deps.run(job,credentials.deviceId,()=>deps.authorize(job,controller.signal,identity),{identity,ownership},controller.signal).finally(()=>ownership.settled());
     await cleanRoleMcpSession(identity,intent);
     intent=await retainRoleMcpCompletion(identity,intent,{jobId:job.id,lease:job.lease,...result});
     await acknowledgeRoleMcpCompletion(identity,intent,deps.complete);
    })().catch(()=>{}).finally(()=>{tasks.delete(job.id);active.delete(intent.requestId);});tasks.set(job.id,task);
   }
  })().catch(()=>{}).finally(()=>{polling=undefined;});
 };
 const timer=setInterval(tick,1000);timer.unref();tick();
 return {wake:tick,async stop(){clearInterval(timer);controller.abort();await polling;await Promise.allSettled([...tasks.values()]);},get active(){return tasks.size;}};
}
