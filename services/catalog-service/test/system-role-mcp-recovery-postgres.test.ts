import {ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {digest} from '../src/devices/device-store';
import {createMcpFixture,deferred,deviceId,gatewayUrl,owner,project,request,token,type McpFixture} from './system-role-mcp-postgres.fixture';

const availability=vi.hoisted(()=>({enabled:true,gate:undefined as undefined|(()=>Promise<void>)}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:async()=>{await availability.gate?.();if(!availability.enabled)throw new ForbiddenException('Fixture feature disabled');}}));
const connection=process.env.SYSTEM_ROLE_MCP_MAINTENANCE_TEST_ADMIN_URL;

/** Durable preclaim identity recovers only its old lease; token replacement cannot erase pending physical cleanup. */
describe.skipIf(!connection).sequential('private MCP preclaim recovery on caller-owned PostgreSQL',()=>{
 let f:McpFixture;
 beforeAll(async()=>{f=await createMcpFixture(connection);},60000);
 beforeEach(async()=>{
  availability.enabled=true;availability.gate=undefined;vi.stubEnv('CATALOG_PG_URL','postgresql://forbidden@127.0.0.1:1/forbidden');vi.stubEnv('API_GATEWAY_URL',gatewayUrl);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','native-fixture-internal');
  vi.stubGlobal('fetch',f.fetchBoundary);await f.reset();await f.pool.query('UPDATE bridge_devices SET paused_until=NULL,token_hash=$2 WHERE id=$1',[deviceId,digest(token)]);
 });
 afterEach(async()=>{if(f){await f.stop();expect(f.transportViolations).toEqual([]);}vi.unstubAllGlobals();vi.unstubAllEnvs();});
 afterAll(async()=>{await f?.close();});
 const discover=()=>f.service.discover(request(),{projectId:project,target:f.target('device'),requestId:randomUUID()});
 const claim=(requestId=randomUUID(),recoveryOnly=false,credential=token)=>f.service.channel.claim(credential,{requestId,recoveryOnly});
 const complete=(job:{id:string;lease:string})=>f.service.channel.complete(token,{jobId:job.id,lease:job.lease,result:{schemaVersion:1,sessionId:job.id,closed:true}});

 it('echoes the persisted preclaim identity and replays the same closed lease without starting another session',async()=>{
  await discover();const requestId=randomUUID(),job=(await claim(requestId))!;await discover();
  expect(job).toMatchObject({requestId});
  const recovered=await claim(requestId,true);expect(recovered).toMatchObject({id:job.id,lease:job.lease,requestId,recoveryOnly:true});
  expect(await f.service.repository.session(job.id)).toMatchObject({state:'closed',worker_closed_at:null});
  expect(await f.devices.pause(token)).toEqual({activeJobs:1});await complete(job);expect(await f.devices.pause(token)).toEqual({activeJobs:0});
  expect(Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_sessions WHERE claimed_at IS NOT NULL')).rows[0].count)).toBe(1);
 });

 it('does not allocate work for an unknown recovery nonce even when a new candidate is available',async()=>{
  await discover();expect(await claim(randomUUID(),true)).toBeNull();
  expect(Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_sessions WHERE claimed_at IS NOT NULL')).rows[0].count)).toBe(0);
 });

 it('retires an unknown recovery before a delayed original fresh request can allocate an orphan lease',async()=>{
  await discover();const requestId=randomUUID(),entered=deferred(),release=deferred();let gated=false;
  const watchdog=setTimeout(()=>{release.resolve();entered.reject(new Error('Fresh preflight barrier was not reached'));},5000);watchdog.unref();
  availability.gate=async()=>{if(gated)return;gated=true;entered.resolve();await release.promise;};
  let original:ReturnType<typeof claim>|undefined;
  try{
   original=claim(requestId);void original.catch(()=>undefined);await entered.promise;
   expect(await claim(requestId,true)).toBeNull();release.resolve();
   expect(await original).toBeNull();
   expect(Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_sessions WHERE claimed_at IS NOT NULL')).rows[0].count)).toBe(0);
  }finally{clearTimeout(watchdog);release.resolve();availability.gate=undefined;if(original)await Promise.allSettled([original]);}
 });

 it('leaves ordinary idle fresh polling without retired records',async()=>{
  const before=Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_retired_claims')).rows[0].count);
  for(let index=0;index<3;index++)expect(await claim()).toBeNull();
  expect(Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_retired_claims')).rows[0].count)).toBe(before);
 });

 it('keeps an acknowledged nonce retired after its session history is removed',async()=>{
  await discover();const requestId=randomUUID(),job=(await claim(requestId))!;await complete(job);
  await f.pool.query('DELETE FROM system_role_mcp_sessions WHERE id=$1',[job.id]);await discover();
  expect(await claim(requestId)).toBeNull();expect(await claim(requestId,true)).toBeNull();
  expect(Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_sessions WHERE claimed_at IS NOT NULL')).rows[0].count)).toBe(0);
 });

 it('treats a repeated fresh request as recovery and never executes the retained lease twice',async()=>{
  await discover();await discover();const requestId=randomUUID(),job=(await claim(requestId))!;
  expect(await claim(requestId)).toMatchObject({id:job.id,lease:job.lease,requestId,recoveryOnly:true});
  expect((await f.service.repository.session(job.id)).state).toBe('closed');
  expect(await f.service.channel.authorize(token,{jobId:job.id,lease:job.lease})).toEqual({closed:true});
 });

 it('serializes concurrent sends of one preclaim identity into one lease and a cleanup-only replay',async()=>{
  await discover();await discover();const requestId=randomUUID();
  const jobs=await Promise.all([claim(requestId),claim(requestId)]);
  expect(jobs.every(job=>job?.requestId===requestId)).toBe(true);expect(new Set(jobs.map(job=>job!.id)).size).toBe(1);
  expect(jobs.filter(job=>job&&'recoveryOnly' in job&&job.recoveryOnly)).toHaveLength(1);
  expect(Number((await f.pool.query('SELECT count(*) FROM system_role_mcp_sessions WHERE claimed_at IS NOT NULL')).rows[0].count)).toBe(1);
  expect((await f.service.repository.session(jobs[0]!.id)).state).toBe('closed');
 });

 it('recovers a matching cleanup receipt after revocation, expiry and flags OFF without fresh execution rights',async()=>{
  await discover();const requestId=randomUUID(),job=(await claim(requestId))!;
  await f.pool.query("UPDATE bridge_devices SET revoked=true,expires_at=now()-interval '1 day' WHERE id=$1",[deviceId]);availability.enabled=false;
  expect(await claim(requestId,true)).toMatchObject({id:job.id,lease:job.lease,recoveryOnly:true});
  await expect(claim(randomUUID())).rejects.toHaveProperty('status',401);
  await expect(claim(requestId,true,'b'.repeat(64))).rejects.toHaveProperty('status',401);
  await complete(job);expect(await f.devices.pause(token)).toEqual({activeJobs:0});
 });

 it('keeps the old credential and approved pair retryable until exact worker cleanup is acknowledged',async()=>{
  await discover();const job=(await claim())!,replacement='b'.repeat(64);
  const pair=await f.devices.start({name:'Recovered fixture',fingerprint:'d'.repeat(64),credentialHash:digest(replacement)},token);
  await f.devices.approve({email:owner,activeRole:'Админ проекта'} as never,pair.userCode);
  await expect(f.devices.poll(pair.deviceCode)).rejects.toHaveProperty('status',409);
  expect((await f.devices.identity(token)).id).toBe(deviceId);await expect(f.devices.identity(replacement)).rejects.toHaveProperty('status',401);
  expect((await f.pool.query('SELECT issued FROM bridge_pairs WHERE code_hash=$1',[digest(pair.deviceCode)])).rows[0].issued).toBe(false);
  await complete(job);expect(await f.devices.poll(pair.deviceCode)).toMatchObject({state:'connected',deviceId});
  expect((await f.devices.identity(replacement)).id).toBe(deviceId);await expect(f.devices.identity(token)).rejects.toHaveProperty('status',401);
 });

 it('preserves the old credential while an ordinary bridge job still has an unconfirmed physical outcome',async()=>{
  const replacement='b'.repeat(64),job=await f.job('install',{fixture:'never physically executed'},'running');
  const pair=await f.devices.start({name:'Ordinary fixture',fingerprint:'d'.repeat(64),credentialHash:digest(replacement)},token);
  await f.devices.approve({email:owner,activeRole:'Админ проекта'} as never,pair.userCode);
  await expect(f.devices.poll(pair.deviceCode)).rejects.toHaveProperty('status',409);expect((await f.devices.identity(token)).id).toBe(deviceId);
  await f.pool.query("UPDATE bridge_jobs SET state='succeeded' WHERE id=$1",[job]);
  expect(await f.devices.poll(pair.deviceCode)).toMatchObject({state:'connected',deviceId});
 });
});
