import {ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {digest} from '../src/devices/device-store';
import {assertBlockedBy,createMcpFixture,deferred,deviceId,gatewayUrl,listResult,owner,project,request,token,type McpFixture} from './system-role-mcp-postgres.fixture';

const availability=vi.hoisted(()=>({enabled:true}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:async()=>{if(!availability.enabled)throw new ForbiddenException('Fixture feature disabled');}}));
const connection=process.env.SYSTEM_ROLE_MCP_MAINTENANCE_TEST_ADMIN_URL;

/** Actual migrations, pairing, maintenance, private claims and row-lock races on an explicitly owned database; no MCP/model process. */
describe.skipIf(!connection).sequential('bridge maintenance drains the private MCP lane on caller-owned PostgreSQL',()=>{
 let f:McpFixture;
 beforeAll(async()=>{f=await createMcpFixture(connection);},60000);
 beforeEach(async()=>{
  availability.enabled=true;vi.stubEnv('CATALOG_PG_URL','postgresql://forbidden@127.0.0.1:1/forbidden');
  vi.stubEnv('API_GATEWAY_URL',gatewayUrl);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','native-fixture-internal');
  vi.stubGlobal('fetch',f.fetchBoundary);await f.reset();
  await f.pool.query('UPDATE bridge_devices SET paused_until=NULL,token_hash=$2 WHERE id=$1',[deviceId,digest(token)]);
 });
 afterEach(async()=>{if(f){await f.stop();expect(f.transportViolations).toEqual([]);}vi.unstubAllGlobals();vi.unstubAllEnvs();});
 afterAll(async()=>{await f?.close();});
 const discover=()=>f.service.discover(request(),{projectId:project,target:f.target('device'),requestId:randomUUID()});
 const claim=()=>f.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false});
 const pause=()=>f.devices.pause(token);

 /** Both production operations hold the same real device row; a watchdog is cleanup only, not race evidence. */
 async function ordered<A,B>(match:(sql:string)=>boolean,first:()=>Promise<A>,second:()=>Promise<B>):Promise<[A,B]>{
  const entered=deferred<number>(),waiting=deferred<number>(),release=deferred();let held=false;
  const watchdog=setTimeout(()=>{release.resolve();entered.reject(new Error('Owned maintenance barrier did not arrive'));waiting.reject(new Error('Owned waiter did not arrive'));},5000);
  watchdog.unref();let a:Promise<A>|undefined,b:Promise<B>|undefined;
  f.setHook(async event=>{
   if(held&&event.sql==='BEGIN'){waiting.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);return;}
   if(held||!match(event.sql))return;held=true;
   entered.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await release.promise;
  });
  try{
   a=first();void a.catch(()=>undefined);const blocker=await entered.promise;
   b=second();void b.catch(()=>undefined);await assertBlockedBy(f.pool,await waiting.promise,blocker);
   release.resolve();return await Promise.all([a,b]);
  }finally{clearTimeout(watchdog);release.resolve();f.setHook();await Promise.allSettled([...(a?[a]:[]),...(b?[b]:[])]);}
 }

 it('claims an unpaused approved private session without creating an ordinary bridge job',async()=>{
  await discover();const before=Number((await f.pool.query('SELECT count(*) FROM bridge_jobs')).rows[0].count);
  const job=await claim();expect(job).toMatchObject({kind:'system-role-mcp-session',project_id:project});
  expect(Number((await f.pool.query('SELECT count(*) FROM bridge_jobs')).rows[0].count)).toBe(before);
 });

 it('keeps a queued private session unclaimed during maintenance and admits the same session after resume',async()=>{
  const view=await discover(),saved=await f.service.repository.discovery(view.id,owner);
  expect(await pause()).toEqual({activeJobs:0});expect(await claim()).toBeNull();
  expect((await f.service.repository.session(saved!.session_id)).claimed_at).toBeNull();
  await f.devices.resume(token);expect((await claim())?.id).toBe(saved!.session_id);
 });

 it('counts a claimed MCP session, permits its live renewal and clears the count only after its own receipt cleanup',async()=>{
  await discover();const job=(await claim())!;expect(job).not.toBeNull();
  expect(await pause()).toEqual({activeJobs:1});
  expect(await f.service.channel.authorize(token,{jobId:job.id,lease:job.lease})).toEqual({ok:true,closed:false});
  const call=await f.service.channel.next(token,{jobId:job.id,lease:job.lease});expect(call).toBeTruthy();
  await f.service.channel.dispatch(token,{jobId:job.id,lease:job.lease,callId:(call as {id:string}).id});
  await f.service.channel.result(token,{jobId:job.id,lease:job.lease,callId:(call as {id:string}).id,result:listResult});
  expect(await pause()).toEqual({activeJobs:1});
  await f.service.channel.complete(token,{jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}});
  expect(await pause()).toEqual({activeJobs:0});
 });

 it('commits maintenance before a blocked claim and prevents private admission after the device row unlocks',async()=>{
  await discover();
  const [paused,job]=await ordered(sql=>sql.startsWith('UPDATE bridge_devices SET paused_until='),pause,claim);
  expect(paused).toEqual({activeJobs:0});expect(job).toBeNull();
  expect(Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_sessions WHERE claimed_at IS NOT NULL')).rows[0].count)).toBe(0);
 });

 it('commits a private claim before blocked maintenance and reports it as active after the device row unlocks',async()=>{
  await discover();
  const [job,paused]=await ordered(sql=>sql.startsWith('UPDATE system_role_mcp_sessions SET claimed_at='),claim,pause);
  expect(job).toBeTruthy();expect(paused).toEqual({activeJobs:1});
 });

 it('preserves maintenance during actual pairing renewal, rejects the old credential and resumes with the rotated one',async()=>{
  const view=await discover(),saved=await f.service.repository.discovery(view.id,owner);await pause();
  const replacement='b'.repeat(64),pair=await f.devices.start({name:'Renewed fixture',fingerprint:'d'.repeat(64),credentialHash:digest(replacement)},token);
  await f.devices.approve({email:owner,activeRole:'Админ проекта'} as never,pair.userCode);
  expect(await f.devices.poll(pair.deviceCode)).toMatchObject({state:'connected',deviceId});
  const device=await f.devices.identity(replacement);
  await f.devices.heartbeat(device,{...device.report,bindings:(device.report.bindings as Array<Record<string,unknown>>).map(binding=>({...binding,folderName:'owned-maintenance-fixture'}))});
  await expect(f.devices.pause(token)).rejects.toHaveProperty('status',401);
  await expect(claim()).rejects.toHaveProperty('status',401);
  expect(await f.service.channel.claim(replacement,{requestId:randomUUID(),recoveryOnly:false})).toBeNull();
  expect((await f.pool.query('SELECT paused_until>clock_timestamp() AS paused FROM bridge_devices WHERE id=$1',[deviceId])).rows[0].paused).toBe(true);
  await f.devices.resume(replacement);expect((await f.service.channel.claim(replacement,{requestId:randomUUID(),recoveryOnly:false}))?.id).toBe(saved!.session_id);
 });

 it('retains drain counts and receipt cleanup with expired or revoked credentials while rejecting fresh execution',async()=>{
  await discover();const job=(await claim())!;
  await f.pool.query("UPDATE bridge_devices SET revoked=true,expires_at=now()-interval '1 minute' WHERE id=$1",[deviceId]);
  expect(await pause()).toEqual({activeJobs:1});await expect(claim()).rejects.toHaveProperty('status',401);
  expect(await f.service.channel.complete(token,{jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}})).toEqual({ok:true,closed:true});
  expect(await pause()).toEqual({activeJobs:0});
 });

 it('retains a closed dispatched session as busy until an exact post-cleanup device receipt arrives',async()=>{
  await discover();const job=(await claim())!;
  const call=await f.service.channel.next(token,{jobId:job.id,lease:job.lease});
  await f.service.channel.dispatch(token,{jobId:job.id,lease:job.lease,callId:(call as {id:string}).id});
  await f.service.repository.close(job.id);
  expect((await f.service.repository.session(job.id)).state).toBe('closed');
  expect((await f.service.repository.call((call as {id:string}).id)).state).toBe('unknown');
  expect(await pause()).toEqual({activeJobs:1});
  await f.service.channel.complete(token,{jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}});
  expect(await pause()).toEqual({activeJobs:0});
 });

 it('keeps a completed discovery result busy while its local MCP port may still be closing',async()=>{
  await discover();const job=(await claim())!;
  const call=await f.service.channel.next(token,{jobId:job.id,lease:job.lease});
  await f.service.channel.dispatch(token,{jobId:job.id,lease:job.lease,callId:(call as {id:string}).id});
  await f.service.channel.result(token,{jobId:job.id,lease:job.lease,callId:(call as {id:string}).id,result:listResult});
  expect((await f.service.repository.call((call as {id:string}).id)).state).toBe('succeeded');
  expect((await f.service.repository.session(job.id)).state).toBe('closed');
  expect(await pause()).toEqual({activeJobs:1});
  await f.service.channel.complete(token,{jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}});
  expect(await pause()).toEqual({activeJobs:0});
 });

 it('accepts only an exact cleanup proof and replays its stored ACK without changing the original time',async()=>{
  await discover();const job=(await claim())!,body={jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}};
  await expect(f.service.channel.complete('c'.repeat(64),body)).rejects.toHaveProperty('status',401);
  await expect(f.service.channel.complete(token,{...body,lease:randomUUID()})).rejects.toHaveProperty('status',401);
  await expect(f.service.channel.complete(token,{...body,result:{...body.result,closed:false}})).rejects.toHaveProperty('status',400);
  expect((await f.service.repository.session(job.id)).worker_closed_at).toBeNull();expect(await pause()).toEqual({activeJobs:1});
  await f.service.channel.complete(token,body);const acknowledged=(await f.service.repository.session(job.id)).worker_closed_at;
  expect(acknowledged).toBeInstanceOf(Date);await f.service.channel.complete(token,body);
  expect((await f.service.repository.session(job.id)).worker_closed_at).toEqual(acknowledged);expect(await pause()).toEqual({activeJobs:0});
  await expect(f.pool.query('UPDATE system_role_mcp_sessions SET worker_closed_at=NULL WHERE id=$1',[job.id])).rejects.toThrow('immutable');
 });

 it('rolls back the cleanup ACK together with closure if receipt settlement cannot commit',async()=>{
  await discover();const job=(await claim())!;
  const failure=new Error('Controlled cleanup settlement failure');
  f.setHook(async event=>{if(event.sql.startsWith("UPDATE system_role_mcp_calls SET state=CASE"))throw failure;});
  try { await expect(f.service.channel.complete(token,{jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}})).rejects.toBe(failure); }
  finally { f.setHook(); }
  expect(await f.service.repository.session(job.id)).toMatchObject({state:'open',worker_closed_at:null});
  expect(await pause()).toEqual({activeJobs:1});
  await f.service.channel.complete(token,{jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}});
  expect(await pause()).toEqual({activeJobs:0});
 });
});
