import {ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {deleteProjectWithAudit} from '../src/catalog/project-deletion';
import {assertBlockedBy,createMcpFixture,deferred,gatewayUrl,listResult,owner,project,request,token,type McpFixture} from './system-role-mcp-postgres.fixture';

const availability=vi.hoisted(()=>({enabled:true}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:async()=>{if(!availability.enabled)throw new ForbiddenException('Fixture feature disabled');}}));
const connection=process.env.SYSTEM_ROLE_MCP_TEST_ADMIN_URL;

/** Real project deletion must retain a claimed tool's physical completion fence, including FK cascades. */
describe.skipIf(!connection).sequential('project retirement preserves device MCP cleanup on caller-owned PostgreSQL',()=>{
 let f:McpFixture;
 beforeEach(async()=>{
  f=await createMcpFixture(connection);
  availability.enabled=true;vi.stubEnv('CATALOG_PG_URL','postgresql://forbidden@127.0.0.1:1/forbidden');
  vi.stubEnv('API_GATEWAY_URL',gatewayUrl);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','native-fixture-internal');
  vi.stubGlobal('fetch',f.fetchBoundary);await f.reset();
 },60000);
 afterEach(async()=>{
  if(f){
   f.setHook();
   // This SQL fixture never launches a physical tool. Close only its own exact leased sessions.
   for(const row of (await f.pool.query('SELECT id,worker_lease FROM system_role_mcp_sessions WHERE claimed_at IS NOT NULL')).rows)
    await f.service.channel.complete(token,{jobId:row.id,lease:row.worker_lease,result:{schemaVersion:1,sessionId:row.id,closed:true}});
   expect(f.transportViolations).toEqual([]);await f.close();
  }
  vi.unstubAllGlobals();vi.unstubAllEnvs();
 });
 const discover=()=>f.service.discover(request(),{projectId:project,target:f.target('device'),requestId:randomUUID()});
 const claim=()=>f.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false});
 const remove=()=>deleteProjectWithAudit(f.models.pool,project,owner);
 const present=async()=>Number((await f.pool.query('SELECT count(*) FROM projects WHERE id=$1',[project])).rows[0].count);
 const complete=(job:{id:string;lease:string})=>f.service.channel.complete(token,{jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}});
 const result=async(job:{id:string;lease:string})=>{
  const call=await f.service.channel.next(token,{jobId:job.id,lease:job.lease}) as {id:string};
  await f.service.channel.dispatch(token,{jobId:job.id,lease:job.lease,callId:call.id});
  await f.service.channel.result(token,{jobId:job.id,lease:job.lease,callId:call.id,result:listResult});
 };
 /** Hold the real deletion project lock, then prove the other transaction waits on that exact backend before allowing CASCADE. */
 const deletionFirst=async<T>(operation:()=>Promise<T>,beforeRelease?:()=>Promise<void>)=>{
  const entered=deferred<number>(),release=deferred();let held=false;
  const watchdog=setTimeout(()=>{release.resolve();entered.reject(new Error('Deletion project barrier did not arrive'));},5000);watchdog.unref();
  f.setHook(async event=>{
   if(held||!event.sql.includes('FROM projects')||!event.sql.includes('FOR UPDATE'))return;
   held=true;entered.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await release.promise;
  });
  let deleted:Promise<{value?:boolean;error?:unknown}>|undefined,operated:Promise<{value?:T;error?:unknown}>|undefined;
  try{
   deleted=remove().then(value=>({value}),error=>({error}));const holder=await entered.promise;
   operated=operation().then(value=>({value}),error=>({error}));let waiter:number|undefined;
   for(let index=0;index<400;index++){
    waiter=(await f.pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
     AND query=$2 AND $1=ANY(pg_blocking_pids(pid))`,[holder,'SELECT id FROM projects WHERE id=$1 FOR SHARE'])).rows[0]?.pid;
    if(waiter)break;await new Promise(resolve=>setTimeout(resolve,5));
   }
   expect(waiter,'Operation never waited for the actual deletion project lock').toBeTypeOf('number');
   await assertBlockedBy(f.pool,waiter!,holder);await beforeRelease?.();release.resolve();
   const outcome={deleted:await deleted,operated:await operated};
   const deleteCode=(outcome.deleted.error as {code?:string})?.code,operationCode=(outcome.operated.error as {code?:string})?.code;
   if(deleteCode||operationCode)throw new Error('MCP_DELETE_ORDER_PROOF '+JSON.stringify({deleteCode:deleteCode??null,operationCode:operationCode??null}));
   return outcome;
  }finally{clearTimeout(watchdog);release.resolve();f.setHook();await Promise.allSettled([...(deleted?[deleted]:[]),...(operated?[operated]:[])]);}
 };

 it('retires an unclaimed discovery without launching a tool or leaving its queued session',async()=>{
  await discover();expect(await remove()).toBe(true);expect(await present()).toBe(0);
  expect(Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_sessions')).rows[0].count)).toBe(0);
 });

 it('returns a recoverable conflict and keeps the project and audit unchanged while a claimed tool may be active',async()=>{
  await discover();const job=(await claim())!;
  await expect(remove()).rejects.toHaveProperty('status',409);
  expect(await present()).toBe(1);expect((await f.service.repository.session(job.id)).claimed_at).not.toBeNull();
  expect(Number((await f.pool.query('SELECT count(*) FROM project_retirements WHERE project_id=$1',[project])).rows[0].count)).toBe(0);
 });

 it('keeps a server-closed session until its exact worker cleanup ACK, even with the execution feature disabled',async()=>{
  await discover();const job=(await claim())!;await f.service.repository.close(job.id);availability.enabled=false;
  await expect(remove()).rejects.toHaveProperty('status',409);expect(await present()).toBe(1);
  await complete(job);expect(await remove()).toBe(true);expect(await present()).toBe(0);
 });

 it('does not treat a stored successful discovery result as physical cleanup',async()=>{
  await discover();const job=(await claim())!;await result(job);
  expect((await f.service.repository.session(job.id)).state).toBe('closed');
  await expect(remove()).rejects.toHaveProperty('status',409);expect(await present()).toBe(1);
  await complete(job);expect(await remove()).toBe(true);
 });

 it('protects a pending physical session from direct project, owner and role-run FK cascades',async()=>{
  const run=await f.run(f.target('device'));await f.enqueue(run.row,f.target('device'));const job=(await claim())!;
  for(const [sql,id] of [
   ['DELETE FROM projects WHERE id=$1',project],
   ['DELETE FROM platform_users WHERE email=$1',owner],
   ['DELETE FROM system_role_runs WHERE id=$1',run.row.id],
  ]){
   await expect(f.pool.query(sql,[id])).rejects.toThrow();
   expect(await present()).toBe(1);expect((await f.service.repository.session(job.id)).claimed_at).not.toBeNull();
  }
  await complete(job);expect(await remove()).toBe(true);
 });

 it('observes a claim committing before a blocked deletion and preserves the claimed session',async()=>{
  await discover();const entered=deferred<number>(),waiting=deferred<number>(),release=deferred();let held=false;
  const watchdog=setTimeout(()=>{release.resolve();entered.reject(new Error('Claim barrier did not arrive'));waiting.reject(new Error('Delete waiter did not arrive'));},5000);watchdog.unref();
  f.setHook(async event=>{
   if(held&&event.sql==='BEGIN'){waiting.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);return;}
   if(held||!event.sql.startsWith('UPDATE system_role_mcp_sessions SET claimed_at='))return;
   held=true;entered.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await release.promise;
  });
  let claimed:ReturnType<typeof claim>|undefined,deleted:Promise<{value?:boolean;error?:unknown}>|undefined;
  try{
   claimed=claim();void claimed.catch(()=>undefined);const blocker=await entered.promise;
   deleted=remove().then(value=>({value}),error=>({error}));
   await assertBlockedBy(f.pool,await waiting.promise,blocker);release.resolve();
   const job=await claimed,outcome=await deleted;
   expect(job).toBeTruthy();expect(outcome).toMatchObject({error:{status:409}});expect(outcome.value).toBeUndefined();
   expect(await present()).toBe(1);expect((await f.service.repository.session(job!.id)).claimed_at).not.toBeNull();
  }finally{clearTimeout(watchdog);release.resolve();f.setHook();await Promise.allSettled([...(claimed?[claimed]:[]),...(deleted?[deleted]:[])]);}
 });

 it('does not deadlock a dispatch that already owns the session against project retirement',async()=>{
  await discover();const job=(await claim())!;
  const call=await f.service.channel.next(token,{jobId:job.id,lease:job.lease}) as {id:string};
  const sessionHeld=deferred<number>(),deletionWaiting=deferred<number>(),release=deferred();let held=false;
  const watchdog=setTimeout(()=>{release.resolve();sessionHeld.reject(new Error('Dispatch session barrier did not arrive'));deletionWaiting.reject(new Error('Deletion transaction did not arrive'));},5000);watchdog.unref();
  f.setHook(async event=>{
   if(held&&event.sql==='BEGIN'){deletionWaiting.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);return;}
   if(held||!event.sql.startsWith('SELECT * FROM system_role_mcp_sessions WHERE id=$1 FOR NO KEY UPDATE'))return;
   held=true;sessionHeld.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await release.promise;
  });
  let dispatched:Promise<{value?:unknown;error?:unknown}>|undefined,deleted:Promise<{value?:boolean;error?:unknown}>|undefined;
  try{
   dispatched=f.service.channel.dispatch(token,{jobId:job.id,lease:job.lease,callId:call.id}).then(value=>({value}),error=>({error}));
   const holder=await sessionHeld.promise;deleted=remove().then(value=>({value}),error=>({error}));
   await assertBlockedBy(f.pool,await deletionWaiting.promise,holder);release.resolve();
   const [dispatchOutcome,deleteOutcome]=await Promise.all([dispatched,deleted]);
   expect(deleteOutcome).toMatchObject({error:{status:409}});expect(dispatchOutcome.error).toBeUndefined();
   expect(await present()).toBe(1);expect((await f.service.repository.call(call.id)).state).toBe('dispatched');
  }finally{clearTimeout(watchdog);release.resolve();f.setHook();await Promise.allSettled([...(dispatched?[dispatched]:[]),...(deleted?[deleted]:[])]);}
 });

 it('confirms a committed cleanup ACK even when project deletion immediately removes its session',async()=>{
  await discover();const job=(await claim())!;let committed=false;
  f.setHook(async event=>{
   if(event.sql!=='COMMIT'||committed)return;committed=true;f.setHook();
   expect(await remove()).toBe(true);
  });
  expect(await complete(job)).toEqual({ok:true,closed:true});expect(committed).toBe(true);expect(await present()).toBe(0);
 });

 for(const source of ['discovery','role run'] as const)it('retires an unclaimed '+source+' when deletion holds project before claim authority',async()=>{
  if(source==='discovery')await discover();else{const run=await f.run(f.target('device'));await f.enqueue(run.row,f.target('device'));}
  const outcome=await deletionFirst(claim);
  expect({deleteCode:(outcome.deleted.error as {code?:string})?.code,claimCode:(outcome.operated.error as {code?:string})?.code}).toEqual({deleteCode:undefined,claimCode:undefined});
  expect(outcome.deleted).toEqual({value:true});expect(outcome.operated).toEqual({value:null});expect(await present()).toBe(0);
  expect(f.executions).toHaveLength(0);
 });

 it('retires an unclaimed server role call when deletion holds project before dispatch authority',async()=>{
  const run=await f.run(),saved=await f.enqueue(run.row),context=await f.service.context(saved.call.id);
  const outcome=await deletionFirst(()=>f.service.serverDispatch({callId:saved.call.id,proof:context.call.proof}));
  expect({deleteCode:(outcome.deleted.error as {code?:string})?.code,dispatchCode:(outcome.operated.error as {code?:string})?.code}).toEqual({deleteCode:undefined,dispatchCode:undefined});
  expect(outcome.deleted).toEqual({value:true});expect(outcome.operated.error).toMatchObject({status:409});expect(await present()).toBe(0);
  expect(f.executions).toHaveLength(0);
 });

 it('rejects discovery creation when deletion holds project before admission authority',async()=>{
  const outcome=await deletionFirst(discover);
  expect(outcome.deleted).toEqual({value:true});expect(outcome.operated.error).toMatchObject({status:409});expect(await present()).toBe(0);
  expect(f.executions).toHaveLength(0);
 });

 it('rejects role tool enqueue when deletion holds project before admission authority',async()=>{
  const run=await f.run(f.target('device'));
  const outcome=await deletionFirst(()=>f.enqueue(run.row,f.target('device')));
  expect(outcome.deleted).toEqual({value:true});expect(outcome.operated.error).toMatchObject({status:409});expect(await present()).toBe(0);
  expect(f.executions).toHaveLength(0);
 });

 for(const source of ['discovery','role run'] as const)for(const operation of ['authorize','context','next','dispatch'] as const)
 it('rejects '+operation+' on '+source+' when an exact cleanup ACK allows waiting project deletion',async()=>{
  if(source==='discovery')await discover();else{const run=await f.run(f.target('device'));await f.enqueue(run.row,f.target('device'));}
  const job=(await claim())!,call=await f.service.channel.next(token,{jobId:job.id,lease:job.lease}) as {id:string};let acknowledged=false;
  const outcome=await deletionFirst(()=>f.service.channel[operation](token,{jobId:job.id,lease:job.lease,...(operation==='dispatch'?{callId:call.id}:{})}),async()=>{
   expect(await complete(job)).toEqual({ok:true,closed:true});
   acknowledged=(await f.service.repository.session(job.id)).worker_closed_at instanceof Date;expect(acknowledged).toBe(true);
  });
  expect(acknowledged).toBe(true);expect(outcome.deleted).toEqual({value:true});
  expect(outcome.operated.error).toMatchObject({status:409});expect(await present()).toBe(0);expect(f.executions).toHaveLength(0);
 });
});
