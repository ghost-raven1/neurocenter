import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {AgentRepository} from '../src/agents/agent.repository';
import {ProjectAgentRepository} from '../src/agents/project-agent.repository';
import {DeviceJobs} from '../src/devices/device-jobs';
import {completeDeviceJob} from '../src/devices/device-completion';
import {AccessDb} from '../src/access/access-db';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';
import type {ProjectEmbeddingService} from '../src/models/project-embedding.service';
import {PROJECT_AGENTS_JOB,PROJECT_AGENTS_NOTE,renderProjectAgent,type ProjectAgentsPayload} from '../../shared/project-agents.cjs';
import {connection,database,reset,main,admin,developer,definition} from './agent-postgres.fixture';
const bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
const report=()=>({protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','project-agents-v1'],bindings:[{projectId:'prj-agents',bindingId,instanceId,valid:true}]});
const receipt=(payload:ProjectAgentsPayload)=>({...payload,agents:payload.agents.map(agent=>({id:agent.id,slug:agent.slug,version:agent.version,enabled:agent.enabled,sha256:createHash('sha256').update(renderProjectAgent(agent)).digest('hex')})),changed:true,readiness:'configured',checkedAt:new Date().toISOString(),note:PROJECT_AGENTS_NOTE});

describe.skipIf(!connection)('Agent delivery — actual durable queue and PostgreSQL',()=>{
 let fixture:Awaited<ReturnType<typeof database>>,pool:Pool,cards:AgentRepository,projects:ProjectAgentRepository,jobs:DeviceJobs,access:AccessDb,device:Device;
 beforeAll(async()=>{fixture=await database();pool=fixture.pool;cards=new AgentRepository(pool);projects=new ProjectAgentRepository(pool);access=new AccessDb();Object.defineProperty(access,'pool',{value:pool});});
 afterAll(async()=>fixture?.close());afterEach(()=>vi.unstubAllGlobals());
 beforeEach(async()=>{
  await reset(pool);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
  device={id:'device-agents',email:admin.email,role:admin.activeRole,name:'Fixture',fingerprint:'fixture',last_seen:null,report:report(),revoked:false};
  await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7)',[device.id,device.email,device.role,device.name,device.fingerprint,'fixture-token',device.report]);
  const store={pool,access,owned:async(actor:{email:string},id:string)=>{if(actor.email!==device.email||id!==device.id)throw Error('not owned');return device;}} as DeviceStore;
  jobs=new DeviceJobs(store,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans,{} as ProjectEmbeddingService);
 });
 const setup=async()=>{const card=await cards.create(main,{requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition});await projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:0,agentId:card.id,version:1,manifest:card.manifest});return card;};
 const enqueue=(revision=1,extra={})=>jobs.create(admin,{kind:PROJECT_AGENTS_JOB,projectId:'prj-agents',deviceId:device.id,requestKey:randomUUID(),expectedAgentsRevision:revision,expectedBindingId:bindingId,expectedInstanceId:instanceId,...extra});
 it('creates exact server snapshot, preserves lost enqueue ACK and audits once without exposing prompt bytes',async()=>{
  await setup();const requestKey=randomUUID(),first=await enqueue(1,{requestKey});expect(await enqueue(1,{requestKey})).toMatchObject({id:first.id});
  const row=(await pool.query('SELECT payload FROM bridge_jobs WHERE id=$1',[first.id])).rows[0];expect(row.payload).toMatchObject({schemaVersion:1,projectId:'prj-agents',bindingId,instanceId,revision:1,agents:[{enabled:false,prompt:definition.prompt}]});
  const audit=(await pool.query("SELECT after_state FROM security_events WHERE action='project.agents.connect'")).rows;expect(audit).toHaveLength(1);expect(audit[0].after_state).toMatchObject({jobId:first.id,revision:1,deviceId:device.id});expect(JSON.stringify(audit)).not.toContain(definition.prompt);
  await expect(enqueue(2,{requestKey})).rejects.toMatchObject({status:409});
 });
 it('does not confirm configuration before delivery, then accepts a compact exact receipt and lost completion ACK',async()=>{
  await setup();const queued=await enqueue();expect((await projects.deliveries('prj-agents',admin.email))[0]).toMatchObject({state:'queued',result:null});
  const job=await jobs.claim(device);expect(job?.id).toBe(queued.id);await jobs.authorize(device,job!.id,job!.lease);
  const input={lease:job!.lease,state:'succeeded' as const,message:'untrusted local message',result:receipt(job!.payload as unknown as ProjectAgentsPayload)};
  expect(await completeDeviceJob(pool,device.id,job!.id,input)).toEqual({ok:true,repeated:false});expect(await completeDeviceJob(pool,device.id,job!.id,input)).toEqual({ok:true,repeated:true});
  const delivery=(await projects.deliveries('prj-agents',admin.email))[0];expect(delivery).toMatchObject({state:'succeeded',revision:1,bindingId,instanceId,message:PROJECT_AGENTS_NOTE,result:{readiness:'configured'}});expect((await pool.query('SELECT state FROM operations WHERE operation_id=$1',['bridge-'+job!.id])).rows[0].state).toBe('SUCCEEDED');
 });
 it('editing desired state invalidates an old queued snapshot before claim',async()=>{
  const card=await setup(),queued=await enqueue();await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true});expect(await jobs.claim(device)).toBeNull();expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[queued.id])).rows[0].state).toBe('failed');
  const next=await enqueue(2);expect((await jobs.claim(device))?.id).toBe(next.id);
 });
 it('editing desired state invalidates authorization, while a real prior commit receipt remains only historical',async()=>{
  const card=await setup();await enqueue();const job=(await jobs.claim(device))!;await jobs.authorize(device,job.id,job.lease);
  await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,overrides:{prompt:'Revision two'}});await expect(jobs.authorize(device,job.id,job.lease)).rejects.toMatchObject({status:409});
  await completeDeviceJob(pool,device.id,job.id,{lease:job.lease,state:'succeeded',message:'',result:receipt(job.payload as unknown as ProjectAgentsPayload)});
  const view=await projects.view('prj-agents',admin.email);expect(view.revision).toBe(2);expect(view.deliveries[0]).toMatchObject({revision:1,state:'succeeded'});expect(view.assignments[0].effective.prompt).toBe('Revision two');
 });
 it('reconciles an expired lease after a server restart without a second local apply',async()=>{
  await setup();await enqueue();const job=(await jobs.claim(device))!;await pool.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  expect(await jobs.claim(device)).toBeNull();expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[job.id])).rows[0].state).toBe('reconciling');
  expect(await completeDeviceJob(pool,device.id,job.id,{lease:job.lease,state:'succeeded',message:'',result:receipt(job.payload as unknown as ProjectAgentsPayload)})).toEqual({ok:true,repeated:false});
 });
 it.each(['binding','instance','revision','manifest','prompt','rolledBack'])('rejects a forged %s receipt without changing durable state',async field=>{
  await setup();await enqueue();const job=(await jobs.claim(device))!,result=receipt(job.payload as unknown as ProjectAgentsPayload) as Record<string,unknown>;
  if(field==='binding')result.bindingId='b'.repeat(64);if(field==='instance')result.instanceId=randomUUID();if(field==='revision')result.revision=2;if(field==='manifest')result.manifestSha256='b'.repeat(64);if(field==='prompt')result.agents=[{...(result.agents as object[])[0],sha256:'b'.repeat(64)}];if(field==='rolledBack')result.rolledBack=true;
  await expect(completeDeviceJob(pool,device.id,job.id,{lease:job.lease,state:'succeeded',message:'',result})).rejects.toMatchObject({status:409});expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[job.id])).rows[0].state).toBe('running');
 });
 it('failed delivery retains safe status and accepts no local prompt, path or secret metadata',async()=>{
  await setup();await enqueue();const job=(await jobs.claim(device))!;await expect(completeDeviceJob(pool,device.id,job.id,{lease:job.lease,state:'failed',message:'private path',result:{path:'/private'}})).rejects.toMatchObject({status:409});
  await completeDeviceJob(pool,device.id,job.id,{lease:job.lease,state:'failed',message:'private path',result:{}});expect((await projects.deliveries('prj-agents',admin.email))[0]).toMatchObject({state:'failed',message:expect.not.stringContaining('private path'),result:{}});
 });
 it.each(['capability','binding','instance','role'])('rejects an outdated %s target before queuing',async field=>{
  await setup();if(field==='capability')device.report.capabilities=[];if(field==='binding')(device.report.bindings as Array<{bindingId:string}>)[0].bindingId='b'.repeat(64);if(field==='instance')(device.report.bindings as Array<{instanceId:string}>)[0].instanceId=randomUUID();if(field==='role'){device.role=developer.activeRole;await pool.query('UPDATE project_members SET role=$2 WHERE principal_name=$1',[admin.email,developer.activeRole]);}
  await expect(enqueue()).rejects.toMatchObject({status:field==='role'?403:409});expect((await pool.query('SELECT * FROM bridge_jobs')).rowCount).toBe(0);
 });
 it('permission revocation is rechecked before claim and local commit',async()=>{
  await setup();await enqueue();await pool.query('DELETE FROM project_members WHERE principal_name=$1',[admin.email]);expect(await jobs.claim(device)).toBeNull();expect((await projects.deliveries('prj-agents',admin.email))[0].state).toBe('failed');
 });
 it('disable/re-enable and last remove produce distinct exact revisions; another target remains unconfirmed',async()=>{
  const card=await setup();await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true});await enqueue(2);const first=(await jobs.claim(device))!;expect((first.payload.agents as Array<{enabled:boolean}>)[0].enabled).toBe(true);await completeDeviceJob(pool,device.id,first.id,{lease:first.lease,state:'succeeded',message:'',result:receipt(first.payload as unknown as ProjectAgentsPayload)});
  await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:2,enabled:false});await enqueue(3);const disabled=(await jobs.claim(device))!;expect((disabled.payload.agents as Array<{enabled:boolean}>)[0].enabled).toBe(false);await completeDeviceJob(pool,device.id,disabled.id,{lease:disabled.lease,state:'succeeded',message:'',result:receipt(disabled.payload as unknown as ProjectAgentsPayload)});
  await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:3,enabled:true});await projects.remove(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:4});await enqueue(5);const removed=(await jobs.claim(device))!;expect(removed.payload.agents).toEqual([]);expect((await projects.deliveries('prj-agents',admin.email))).toHaveLength(1);expect((await projects.deliveries('prj-agents',main.email))).toEqual([]);
 });
});
