import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {AgentRepository} from '../src/agents/agent.repository';
import {ProjectAgentRepository} from '../src/agents/project-agent.repository';
import {DeviceJobs} from '../src/devices/device-jobs';
import {completeDeviceJob} from '../src/devices/device-completion';
import {compileAgentJob} from '../src/agents/agent-job-compiler';
import {AccessDb} from '../src/access/access-db';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';
import type {ProjectEmbeddingService} from '../src/models/project-embedding.service';
import {PROJECT_AGENTS_JOB,PROJECT_AGENTS_NOTE,type ProjectAgentsPayload} from '../../shared/project-agents.cjs';
import {connection,database,reset,main,admin,developer,definition} from './agent-postgres.fixture';
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
const report=()=>({protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','project-agents-v2'],bindings:[{projectId:'prj-agents',bindingId,instanceId,valid:true}]});
const receipt=(payload:ProjectAgentsPayload)=>({schemaVersion:2,projectId:payload.projectId,bindingId:payload.bindingId,instanceId:payload.instanceId,revision:payload.revision,manifestSha256:payload.manifestSha256,compiledManifestSha256:payload.compilation!.manifestSha256,agents:payload.compilation!.agents,changed:true,readiness:'configured',checkedAt:new Date().toISOString(),note:PROJECT_AGENTS_NOTE});

describe.skipIf(!connection)('Agent delivery — actual durable queue and PostgreSQL',()=>{
 let fixture:Awaited<ReturnType<typeof database>>,pool:Pool,cards:AgentRepository,projects:ProjectAgentRepository,jobs:DeviceJobs,access:AccessDb,device:Device;
 beforeAll(async()=>{fixture=await database();pool=fixture.pool;cards=new AgentRepository(pool);projects=new ProjectAgentRepository(pool);access=new AccessDb();Object.defineProperty(access,'pool',{value:pool});});
 afterAll(async()=>fixture?.close());afterEach(()=>vi.unstubAllGlobals());
 beforeEach(async()=>{
  await reset(pool);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
  device={id:'device-agents',email:admin.email,role:admin.activeRole,name:'Fixture',fingerprint:'fixture',last_seen:null,report:report(),revoked:false};
  await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7)',[device.id,device.email,device.role,device.name,device.fingerprint,'fixture-token',device.report]);
  const store={pool,access,owned:async(actor:{email:string},id:string)=>{if(actor.email!==device.email||id!==device.id)throw Error('not owned');return device;}} as unknown as DeviceStore;
  jobs=new DeviceJobs(store,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans,{} as ProjectEmbeddingService);
  const claim=jobs.claim.bind(jobs);vi.spyOn(jobs,'claim').mockImplementation(async target=>{const job=await claim(target);if(job&&!(job.payload.modelRequirements as unknown[])?.length){job.payload.compilation=await jobs.compileAgents(target,{jobId:job.id,lease:job.lease,payloadManifest:job.payload.manifestSha256,mappings:[]});}return job;});
 });
 const setup=async()=>{const card=await cards.create(main,{requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition});await projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:0,agentId:card.id,version:1,manifest:card.manifest});return card;};
 const enqueue=(revision=1,extra={})=>jobs.create(admin,{kind:PROJECT_AGENTS_JOB,projectId:'prj-agents',deviceId:device.id,requestKey:randomUUID(),expectedAgentsRevision:revision,expectedBindingId:bindingId,expectedInstanceId:instanceId,...extra});
 it('creates exact server snapshot, preserves lost enqueue ACK and audits once without exposing prompt bytes',async()=>{
  await setup();const requestKey=randomUUID(),first=await enqueue(1,{requestKey});expect(await enqueue(1,{requestKey})).toMatchObject({id:first.id});
  const row=(await pool.query('SELECT payload FROM bridge_jobs WHERE id=$1',[first.id])).rows[0];expect(row.payload).toMatchObject({schemaVersion:2,projectId:'prj-agents',bindingId,instanceId,revision:1,agents:[{enabled:false,prompt:definition.prompt}]});
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
 const compiledModelJob=async()=>{
  const card=await setup(),modelId='model-compile-'+randomUUID(),semantic='d'.repeat(64);
  await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3)',[modelId,modelId,{description:'QA',runtime:'remote-openai',model:'upstream-chat',modelVersion:'v1',capability:'chat',dimension:null,source:'custom',manifestSha256:null,verificationSha256:semantic}]);
  await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',['prj-agents',modelId,admin.email]);
  await pool.query("INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,options,semantic_sha,verified_at) VALUES($1,1,$2,false,'none',$3,$4,now())",[modelId,'https://provider.example.test/v1',{contextWindow:128000,temperature:0},semantic]);
  await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true,overrides:{model:'neurocenter/'+modelId}});
  await enqueue(2);const job=(await jobs.claim(device))!,requirement=(job.payload.modelRequirements as Array<Record<string,unknown>>)[0];
  const mapping={agentId:card.id,provider:'team',configKey:'alias',runtime:'remote-openai',model:'upstream-chat',baseUrl:'https://provider.example.test/v1',options:{contextWindow:128000,temperature:0},capability:'chat'};
  const input={jobId:job.id,lease:job.lease,payloadManifest:job.payload.manifestSha256,mappings:[mapping]};return {job,card,modelId,mapping,input,requirement};
 };
 it('privately compiles a project-admin model without shared auto-sync, stores exact native bytes and preserves the original request identity',async()=>{
  const f=await compiledModelJob(),before=(await pool.query('SELECT request_key,request_hash,payload FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0];
  const first=await jobs.compileAgents(device,f.input),again=await jobs.compileAgents(device,f.input);expect(again).toEqual(first);
  const after=(await pool.query('SELECT request_key,request_hash,payload FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0];
  expect(after.request_key).toBe(before.request_key);expect(after.request_hash).toBe(before.request_hash);expect(after.payload.manifestSha256).toBe(before.payload.manifestSha256);
  expect(after.payload.agents[0].model).toBe('neurocenter/'+f.modelId);expect(first.mappings[0]).toMatchObject({provider:'team',configKey:'alias'});expect(first.agents[0].sha256).not.toBe(createHash('sha256').update('neurocenter/'+f.modelId).digest('hex'));
  expect(JSON.stringify(first)).not.toContain(definition.prompt);expect((await pool.query('SELECT 1 FROM opencode_model_sources WHERE model_id=$1',[f.modelId])).rowCount).toBe(0);
  f.job.payload.compilation=first;await completeDeviceJob(pool,device.id,f.job.id,{lease:f.job.lease,state:'succeeded',message:'',result:receipt(f.job.payload as unknown as ProjectAgentsPayload)});
 });
 it('an approved mapping is immutable: another valid alias, forged options and credential fields cannot replace it',async()=>{
  const f=await compiledModelJob();await jobs.compileAgents(device,f.input);
  for(const patch of [{configKey:'different-alias'},{options:{contextWindow:4096}},{apiKey:'PRIVATE'}])await expect(jobs.compileAgents(device,{...f.input,mappings:[{...f.mapping,...patch}]})).rejects.toHaveProperty('status',409);
  const stored=(await pool.query('SELECT payload FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0].payload;expect(stored.compilation.mappings[0]).toEqual(f.mapping);
 });
 it.each(['pin','assignment','binding','role'])('fresh %s revocation blocks compile and final success',async issue=>{
  const f=await compiledModelJob();f.job.payload.compilation=await jobs.compileAgents(device,f.input);
  if(issue==='pin')await pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{model}',to_jsonb('changed'::text)) WHERE id=$1",[f.modelId]);
  if(issue==='assignment')await pool.query('DELETE FROM project_models WHERE model_id=$1',[f.modelId]);
  if(issue==='binding'){device.report={...device.report,bindings:[{projectId:'prj-agents',bindingId:'b'.repeat(64),instanceId}]};await pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[device.id,device.report]);}
  if(issue==='role')await pool.query('DELETE FROM project_members WHERE principal_name=$1',[admin.email]);
  await expect(jobs.compileAgents(device,f.input)).rejects.toHaveProperty('status');
  await expect(completeDeviceJob(pool,device.id,f.job.id,{lease:f.job.lease,state:'succeeded',message:'',result:receipt(f.job.payload as unknown as ProjectAgentsPayload)})).rejects.toHaveProperty('status');
  expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0].state).toBe('running');
 });
 it('missing/foreign/unverified catalogue models fail with public setup guidance before enqueue',async()=>{
  const card=await setup();await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true,overrides:{model:'neurocenter/model-absent'}});
  await expect(enqueue(2)).rejects.toMatchObject({response:{code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId:card.id,modelId:'model-absent',action:'sync-opencode-models'}});
  expect((await pool.query('SELECT * FROM bridge_jobs')).rowCount).toBe(0);
 });
 it.each(['lease','device','role'])('revoking %s after initial authorization prevents compilation without changing the desired revision',async issue=>{
  const f=await compiledModelJob(),before=(await pool.query('SELECT payload FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0].payload;
  let checks=0;const authorize=async(id:string,lease:string)=>{
   await jobs.authorize(device,id,lease);if(++checks!==1)return;
   if(issue==='lease')await pool.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
   if(issue==='device')await pool.query('UPDATE bridge_devices SET revoked=true WHERE id=$1',[device.id]);
   if(issue==='role')await pool.query('DELETE FROM project_members WHERE principal_name=$1',[admin.email]);
  };
  await expect(compileAgentJob({pool} as DeviceStore,device,f.input,authorize)).rejects.toHaveProperty('status');
  expect((await pool.query('SELECT payload FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0].payload).toEqual(before);
  expect(await projects.currentRevision('prj-agents')).toBe(2);expect((await projects.deliveries('prj-agents',admin.email))[0].result).toBeNull();
 });
 it('a wrong source manifest never writes compilation, while malformed input never reaches authorization',async()=>{
  const f=await compiledModelJob(),authorize=vi.fn((id:string,lease:string)=>jobs.authorize(device,id,lease));
  await expect(compileAgentJob({pool} as DeviceStore,device,{...f.input,payloadManifest:'f'.repeat(64)},authorize)).rejects.toMatchObject({status:409});
  expect((await pool.query('SELECT payload FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0].payload.compilation).toBeUndefined();
  authorize.mockClear();for(const patch of [{jobId:'not-a-uuid'},{lease:null},{mappings:{}},{unexpected:'PRIVATE_PROMPT'}])await expect(compileAgentJob({pool} as DeviceStore,device,{...f.input,...patch},authorize)).rejects.toMatchObject({status:400});
  expect(authorize).not.toHaveBeenCalled();expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0].state).toBe('running');
 });
 it('setup-required failure is a safe historical receipt; a new explicit retry remains unconfirmed',async()=>{
  const f=await compiledModelJob(),result={code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId:f.card.id,modelId:f.modelId,action:'sync-opencode-models'};
  await completeDeviceJob(pool,device.id,f.job.id,{lease:f.job.lease,state:'failed',message:'PRIVATE_PROVIDER_URL /private/path API_KEY',result});
  const failure=(await projects.deliveries('prj-agents',admin.email))[0];expect(failure).toMatchObject({state:'failed',revision:2,result});expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_PROVIDER_URL|private\/path|API_KEY/);
  const retry=await enqueue(2),claimed=(await jobs.claim(device))!;expect(claimed.id).toBe(retry.id);expect(claimed.id).not.toBe(f.job.id);
  expect((await pool.query('SELECT state,result FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0]).toMatchObject({state:'failed',result});
  expect((await projects.deliveries('prj-agents',admin.email))[0]).toMatchObject({state:'running',revision:2,result:null});expect(await projects.currentRevision('prj-agents')).toBe(2);
 });
 it.each([{agentId:'agent-foreign'},{modelId:'model-foreign'},{action:'execute-shell'},{code:'UNTRUSTED_PROVIDER_FAILURE'},{privatePath:'/private/key'}])('rejects forged setup guidance without completing the running job %#',async patch=>{
  const f=await compiledModelJob(),result={code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId:f.card.id,modelId:f.modelId,action:'sync-opencode-models',...patch};
  await expect(completeDeviceJob(pool,device.id,f.job.id,{lease:f.job.lease,state:'failed',message:'private error',result})).rejects.toMatchObject({status:409});
  expect((await pool.query('SELECT state,result FROM bridge_jobs WHERE id=$1',[f.job.id])).rows[0]).toMatchObject({state:'running',result:null});
 });

});
