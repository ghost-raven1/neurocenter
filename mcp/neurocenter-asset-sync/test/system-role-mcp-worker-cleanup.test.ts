import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {runSystemRoleMcpJob,type SessionJob} from '../src/features/system-role-mcp/worker.js';
import {roleMcpLifecycleSupported} from '../src/features/system-role-mcp/owned-process.js';

function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
function fixture(){
 const id=randomUUID(),job:SessionJob={id,lease:randomUUID(),project_id:'project',payload:{sessionId:id}};
 const target={launch:{}as never,check:async()=>{},close:vi.fn(async()=>{})};
 const deps={context:async()=>({jobId:id,sessionId:id,projectId:'project',deadlineAt:new Date(Date.now()+60000).toISOString()})as never,
  next:async()=>({closed:true as const}),target:vi.fn(async()=>target),connect:vi.fn(async()=>({list:async()=>[],call:async()=>({text:'',truncated:false}),close:async()=>{}}))};
 return {job,target,deps};
}
describe('system-role transport ownership and closed-session cancellation',()=>{
 it('does not acknowledge closure before both transport and private HOME cleanup finish',async()=>{
  const {job,target,deps}=fixture(),transport=deferred(),home=deferred(),entered=deferred();let completed=false;
  deps.connect.mockResolvedValue({list:async()=>[],call:async()=>({text:'',truncated:false}),close:async()=>{entered.resolve();await transport.promise;}});
  target.close.mockImplementation(async()=>home.promise);
  const pending=runSystemRoleMcpJob(job,randomUUID(),async()=>({}),deps).then(value=>{completed=true;return value;});
  await entered.promise;expect(completed).toBe(false);expect(target.close).not.toHaveBeenCalled();transport.resolve();
  await vi.waitFor(()=>expect(target.close).toHaveBeenCalledOnce());expect(completed).toBe(false);home.resolve();
  expect((await pending).result).toEqual({schemaVersion:1,sessionId:job.id,closed:true});
 });
 it('attempts HOME cleanup after a transport cleanup failure and withholds closed:true',async()=>{
  const {job,target,deps}=fixture();deps.connect.mockResolvedValue({list:async()=>[],call:async()=>({text:'',truncated:false}),close:async()=>{throw new Error('owned group still live');}});
  await expect(runSystemRoleMcpJob(job,randomUUID(),async()=>({}),deps)).rejects.toThrow('owned group still live');expect(target.close).toHaveBeenCalledOnce();
 });
 it('aborts a held call when authorize returns closed:true, then closes both local resources',async()=>{
  const {job,target,deps}=fixture(),entered=deferred();let closed=false,cancelled=false,transportClosed=false;
  const next={id:randomUUID(),kind:'call',name:'held',schemaDigest:'0'.repeat(64),arguments:{},deadlineAt:new Date(Date.now()+60000).toISOString()};
  deps.next=async()=>next as never;
  deps.connect.mockImplementation(async(_launch,signal)=>({list:async()=>[],call:async()=>{entered.resolve();await new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(new Error('cancelled'));},{once:true}));return {text:'',truncated:false};},close:async()=>{transportClosed=true;}}));
  const pending=runSystemRoleMcpJob(job,randomUUID(),async()=>({closed}),{...deps,result:async()=>{},dispatch:async()=>{}});
  await entered.promise;closed=true;const result=await pending;expect(cancelled).toBe(true);expect(transportClosed).toBe(true);expect(target.close).toHaveBeenCalledOnce();expect(result.state).toBe('failed');
 });
 it('never executes a recovery-only claim',async()=>{
  const {job,deps}=fixture();await expect(runSystemRoleMcpJob({...job,recoveryOnly:true},randomUUID(),async()=>({}),deps)).rejects.toThrow();expect(deps.target).not.toHaveBeenCalled();
 });
 it('does not advertise the lifecycle on Windows and refuses a direct launch before context access',async()=>{
  expect(roleMcpLifecycleSupported('win32')).toBe(false);expect(roleMcpLifecycleSupported('darwin')).toBe(true);expect(roleMcpLifecycleSupported('linux')).toBe(true);
  const {job,deps}=fixture(),original=Object.getOwnPropertyDescriptor(process,'platform')!;
  try{Object.defineProperty(process,'platform',{value:'win32'});await expect(runSystemRoleMcpJob(job,randomUUID(),async()=>({}),deps)).rejects.toThrow();expect(deps.target).not.toHaveBeenCalled();}
  finally{Object.defineProperty(process,'platform',original);}
 });
});
