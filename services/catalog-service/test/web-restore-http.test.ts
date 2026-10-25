import 'reflect-metadata';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {NestFactory} from '@nestjs/core';
import type {INestApplication} from '@nestjs/common';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {RestoreController,RestoreRunnerController} from '../src/restore/restore.controller';
import {RestoreService} from '../src/restore/restore.service';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {RestoreRepository} from '../src/restore/restore.repository';
import {digest,type RestorePreview} from '../../shared/web-restore.cjs';
import {callerOwnedPostgresAdmin} from './caller-owned-postgres.fixture';
const token='c'.repeat(64),actor='restore@example.test',other='other@example.test',checkpointId='checkpoint-one',sha='a'.repeat(64),configDigest='b'.repeat(64);
const denied=new Set<string>();let app:INestApplication,base:string,admin:Pool,pool:Pool,repository:RestoreRepository;
const schema='nc_restore_test_'+randomUUID().replaceAll('-',''),runnerId=randomUUID();
const headers=(email=actor,role='Главный админ')=>({'content-type':'application/json','x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole:role}))});
async function call(route:string,body?:unknown,options:{email?:string;role?:string;runner?:boolean;token?:string}={}){
 return fetch(base+route,{method:body===undefined?'GET':'POST',headers:options.runner?{'content-type':'application/json','x-neurocenter-restore':options.token??token}:headers(options.email,options.role),...body===undefined?{}:{body:JSON.stringify(body)}});
}
const post=(path:string,body:unknown)=>call('/internal/maintenance/restore/'+path,body,{runner:true});
const report=(overrides={})=>post('report',{runnerId,configDigest,targetPrefix:'nc-restore',checkpoints:[{id:checkpointId,label:'Полная копия',sha256:sha,createdAt:new Date().toISOString()}],...overrides});
const input=()=>({requestKey:randomUUID(),checkpointId,checkpointSha256:sha,targetProject:'nc-restore-'+randomUUID().slice(0,8)});
const previewResult=(request:ReturnType<typeof input>):RestorePreview=>{const body={checkpointId,checkpointSha256:sha,targetProject:request.targetProject,configDigest,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),impact:{databases:['catalog','rag'],volumes:['skills','projects','backups','runtime-artifacts'],files:3,bytes:100,applicationsStarted:false as const,currentStackChanged:false as const}};return {...body,digest:digest(body)};};
async function ready(){
 const request=input(),response=await call('/api/maintenance/restore/previews',request),job=await response.json();expect(response.status).toBe(202);
 const {job:claimed}=await (await post('claim',{runnerId})).json(),preview=previewResult(request);expect(claimed.id).toBe(job.id);
 expect((await post(`jobs/${job.id}/complete`,{runnerId,leaseId:claimed.lease_id,state:'ready',preview})).status).toBe(201);
 return {job,preview,confirmation:{requestKey:randomUUID(),previewId:job.id,digest:preview.digest,confirmation:'RESTORE '+request.targetProject}};
}
beforeAll(async()=>{
 vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);vi.stubEnv('RESTORE_RUNNER_TOKEN',token);
 const target=callerOwnedPostgresAdmin();admin=new Pool({connectionString:target.href,max:1});await admin.query('CREATE DATABASE '+schema);target.pathname='/'+schema;pool=new Pool({connectionString:target.href,max:8});await ensureCatalogSchema(pool);repository=new RestoreRepository(pool);
 const access={claims:async(email:string)=>({email,userRoles:denied.has(email)?[]:['Главный админ']})};
 const service=Object.assign(Object.create(RestoreService.prototype),{access,pool,repository,initialized:Promise.resolve()});
 Reflect.defineMetadata('design:paramtypes',[RestoreService],RestoreController);Reflect.defineMetadata('design:paramtypes',[RestoreService],RestoreRunnerController);
 class FixtureModule{}
 app=await NestFactory.create({module:FixtureModule,controllers:[RestoreController,RestoreRunnerController],providers:[{provide:RestoreService,useValue:service}]},{logger:false});
 await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
beforeEach(async()=>{denied.clear();await pool.query('TRUNCATE web_restore_jobs,web_restore_runner,web_restore_cancelled_requests,security_events CASCADE');await report();});
afterAll(async()=>{try{if(app)await app.close();else await pool?.end();}finally{await admin?.query('DROP DATABASE '+schema);await admin?.end();vi.unstubAllEnvs();}});
describe('Web restore — real PostgreSQL and Nest HTTP; no executor in request path',()=>{
 it('Rejects missing internal identity and a non-main role before creating any intent',async()=>{
  expect((await fetch(base+'/api/maintenance/restore',{headers:{'x-bridge-actor':headers()['x-bridge-actor']}})).status).toBe(403);
  expect((await call('/api/maintenance/restore/previews',input(),{role:'Разработчик'})).status).toBe(403);
  expect(Number((await pool.query('SELECT count(*) FROM web_restore_jobs')).rows[0].count)).toBe(0);
 });
 it.each([{source:'/etc/passwd'},{checkpointId:'../escape'},{checkpointSha256:'wrong'},{targetProject:'neurocenter-production'},{requestKey:'not-uuid'}])('Rejects unsupported/unsafe input before queue: %j',async changed=>{
  const response=await call('/api/maintenance/restore/previews',{...input(),...changed});expect([400,409]).toContain(response.status);expect((await pool.query('SELECT id FROM web_restore_jobs')).rows).toHaveLength(0);
 });
 it('Request-key cancellation tombstone prevents a delayed POST after404 and is idempotent',async()=>{
  const request=input();expect((await call('/api/maintenance/restore/requests/'+request.requestKey)).status).toBe(404);
  expect((await call('/api/maintenance/restore/requests/'+request.requestKey+'/cancel',{})).status).toBe(201);
  expect((await call('/api/maintenance/restore/requests/'+request.requestKey+'/cancel',{})).status).toBe(201);
  expect((await call('/api/maintenance/restore/previews',request)).status).toBe(409);expect((await pool.query('SELECT id FROM web_restore_jobs')).rows).toHaveLength(0);
  expect((await pool.query("SELECT action FROM security_events WHERE action='maintenance.restore.request.cancelled'")).rows).toHaveLength(1);
 });
 it('Cancellation races safely with create: either the late request is rejected or the queued job is cancelled',async()=>{
  const request=input();await Promise.all([call('/api/maintenance/restore/previews',request),call('/api/maintenance/restore/requests/'+request.requestKey+'/cancel',{})]);
  const jobs=(await pool.query('SELECT state FROM web_restore_jobs WHERE request_key=$1',[request.requestKey])).rows;expect(jobs.every(row=>row.state==='cancelled')).toBe(true);expect((await (await post('claim',{runnerId})).json()).job).toBeNull();
 });
 it('Reports disconnected runner and never accepts a new preview while unavailable',async()=>{
  await pool.query("UPDATE web_restore_runner SET seen_at=now()-interval '1 minute'");
  const status=await (await call('/api/maintenance/restore')).json();expect(status.runner.available).toBe(false);expect(status.checkpoints).toEqual([]);
  expect((await call('/api/maintenance/restore/previews',input())).status).toBe(503);
 });
 it('Uses a separate runner secret; browser identity cannot claim or publish success',async()=>{
  expect((await call('/internal/maintenance/restore/claim',{runnerId})).status).toBe(403);
  expect((await call('/internal/maintenance/restore/report',{}, {runner:true,token:'wrong'})).status).toBe(403);
  expect((await post('report',{runnerId,configDigest,targetPrefix:'nc-restore',checkpoints:[{id:checkpointId,label:'bad',sha256:sha,createdAt:'not-time',source:'/outside'}]})).status).toBe(400);
 });
 it('Persists exact preview requestKey: parallel/lost ACK retries return one job; different content conflicts',async()=>{
  const request=input(),responses=await Promise.all(Array.from({length:4},()=>call('/api/maintenance/restore/previews',request)));expect(responses.map(r=>r.status)).toEqual([202,202,202,202]);
  const jobs=await Promise.all(responses.map(r=>r.json()));expect(new Set(jobs.map(j=>j.id)).size).toBe(1);expect(jobs[0].state).toBe('queued');
  expect((await call('/api/maintenance/restore/previews',{...request,targetProject:request.targetProject+'x'})).status).toBe(409);
  expect((await (await call('/api/maintenance/restore/requests/'+request.requestKey)).json()).id).toBe(jobs[0].id);
  expect((await call('/api/maintenance/restore/requests/'+request.requestKey,undefined,{email:other})).status).toBe(404);
  expect((await pool.query('SELECT id FROM web_restore_jobs')).rows).toHaveLength(1);
 });
 it('Requires exact digest and typed confirmation; same preview cannot create two restores',async()=>{
  const {job,confirmation}=await ready();
  for(const changed of [{digest:'f'.repeat(64)},{confirmation:'yes'},{previewId:randomUUID()}])expect((await call('/api/maintenance/restore',{...confirmation,...changed})).status).toBe(409);
  const first=await call('/api/maintenance/restore',confirmation);expect(first.status).toBe(202);const saved=await first.json();expect(saved.state).toBe('queued');
  const repeated=await call('/api/maintenance/restore',confirmation);expect((await repeated.json()).id).toBe(saved.id);
  expect((await call('/api/maintenance/restore',{...confirmation,requestKey:randomUUID()})).status).toBe(409);
  expect((await pool.query("SELECT count(*) FROM web_restore_jobs WHERE kind='restore'")).rows[0].count).toBe('1');expect(job.kind).toBe('preview');
 });
 it('Rejects an expired preview or changed server configuration instead of silently refreshing approval',async()=>{
  const {job,confirmation,preview}=await ready();await pool.query('UPDATE web_restore_jobs SET preview=$2 WHERE id=$1',[job.id,JSON.stringify({...preview,expiresAt:new Date(Date.now()-1).toISOString()})]);
  expect((await call('/api/maintenance/restore',confirmation)).status).toBeGreaterThanOrEqual(400);
  await pool.query('UPDATE web_restore_jobs SET preview=$2 WHERE id=$1',[job.id,JSON.stringify(preview)]);await report({configDigest:'d'.repeat(64)});
  expect((await call('/api/maintenance/restore',confirmation)).status).toBe(409);
 });
 it('Serializes claims and checks current main-admin permission at claim/pulse',async()=>{
  const request=input();await call('/api/maintenance/restore/previews',request);
  const claims=await Promise.all([post('claim',{runnerId}),post('claim',{runnerId})]);const jobs=await Promise.all(claims.map(async r=>(await r.json()).job));expect(jobs.filter(Boolean)).toHaveLength(1);
  const current=jobs.find(Boolean);denied.add(actor);
  expect((await post(`jobs/${current.id}/pulse`,{runnerId,leaseId:current.lease_id,message:'Проверяем копию.'})).status).toBe(403);
  denied.clear();expect((await post(`jobs/${current.id}/pulse`,{runnerId,leaseId:randomUUID(),message:'Проверяем копию.'})).status).toBe(403);
 });
 it('Cancels only queued work and revokes queued requests before execution',async()=>{
  const first=await (await call('/api/maintenance/restore/previews',input())).json();expect((await call(`/api/maintenance/restore/jobs/${first.id}/cancel`,{})).status).toBe(201);expect((await (await post('claim',{runnerId})).json()).job).toBeNull();
  const next=await (await call('/api/maintenance/restore/previews',input())).json();denied.add(actor);expect((await (await post('claim',{runnerId})).json()).job).toBeNull();
  expect((await pool.query('SELECT state,error_code FROM web_restore_jobs WHERE id=$1',[next.id])).rows[0]).toMatchObject({state:'failed',error_code:'AUTHORIZATION_OR_PREVIEW_CHANGED'});
 });
 it('Does not turn a lost runner into success or automatically run the old job again',async()=>{
  const {confirmation,preview}=await ready(),job=await (await call('/api/maintenance/restore',confirmation)).json(),claim=(await (await post('claim',{runnerId})).json()).job;
  await pool.query("UPDATE web_restore_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);
  expect((await (await call('/api/maintenance/restore/jobs/'+job.id)).json()).state).toBe('interrupted');expect((await (await post('claim',{runnerId})).json()).job).toBeNull();
  expect((await post(`jobs/${job.id}/complete`,{runnerId,leaseId:claim.lease_id,state:'succeeded'})).status).toBe(400);
  const receipt={ok:true,projectName:preview.targetProject,sha256:sha,restoredAt:new Date().toISOString(),databases:2,durationMs:100,applicationsStarted:false};
  expect((await post(`jobs/${job.id}/complete`,{runnerId,leaseId:claim.lease_id,state:'succeeded',receipt:{...receipt,applicationsStarted:true}})).status).toBe(400);
  const completion={runnerId,leaseId:claim.lease_id,state:'succeeded',receipt};expect((await post(`jobs/${job.id}/complete`,completion)).status).toBe(201);expect((await post(`jobs/${job.id}/complete`,completion)).status).toBe(201);
  expect((await post(`jobs/${job.id}/complete`,{runnerId,leaseId:claim.lease_id,state:'failed'})).status).toBe(409);
  expect((await (await call('/api/maintenance/restore/jobs/'+job.id)).json()).message).toMatch(/Приложения остановлены/);
  expect((await pool.query("SELECT action FROM security_events WHERE action='maintenance.restore.succeeded'")).rows).toHaveLength(1);
 });
 it.skipIf(process.env.WEB_RESTORE_COMPOSE_ACCEPTANCE!=='1')('Actual HTTP → durable PostgreSQL → host runner → real isolated Compose pg_restore, and destructive negatives',async()=>{
  const {webRestoreComposeFixture}=await import('../../../scripts/test/web-restore-compose.fixture.mjs');
  const {restoreRunnerApi,restoreRunnerConfiguration}=await import('../../../scripts/production/web-restore-runner.mjs');
  const {executeWebRestoreJob}=await import('../../../scripts/production/web-restore-job.mjs');
  const {containers,composeClient,docker}=await import('../../../scripts/production/compose-client.mjs');
  const fs=await import('node:fs/promises'),path=await import('node:path');
  const fixture=await webRestoreComposeFixture();let evidence:Record<string,unknown>|undefined;
  try{
   const options={directory:fixture.directory,backupRoot:fixture.backupRoot,registry:fixture.registry,files:fixture.files,targetPrefix:'nc-restore'};
   const configuration=()=>restoreRunnerConfiguration(options),current=await configuration(),api=restoreRunnerApi(base,token);
   expect((await post('report',{runnerId,configDigest:current.configDigest,targetPrefix:'nc-restore',checkpoints:current.checkpoints.map(({source,...publicInfo}:any)=>publicInfo)})).status).toBe(201);
   const request={requestKey:randomUUID(),checkpointId:'real-compose-checkpoint',checkpointSha256:fixture.sha256,targetProject:fixture.targetProject};
   const checkedResponse=await call('/api/maintenance/restore/previews',request);expect(checkedResponse.status).toBe(202);const checkJob=await checkedResponse.json();
   const claimed=(await api('claim',{runnerId})).job;expect(claimed.id).toBe(checkJob.id);
   const runOptions={...options,configuration,checkpoints:current.checkpoints,api,stateDirectory:path.join(fixture.root,'runner-state')};
   const preview=await executeWebRestoreJob(claimed,runOptions);expect(preview.state).toBe('ready');
   const approval={requestKey:randomUUID(),previewId:checkJob.id,digest:preview.preview.digest,confirmation:'RESTORE '+fixture.targetProject};
   const accepted=await call('/api/maintenance/restore',approval);expect(accepted.status).toBe(202);const restore=await accepted.json();expect(restore.state).toBe('queued');
   const executor=(await api('claim',{runnerId})).job;expect(executor.id).toBe(restore.id);const result=await executeWebRestoreJob(executor,runOptions);expect(result.state).toBe('succeeded');
   const stored=await (await call('/api/maintenance/restore/requests/'+approval.requestKey)).json();expect(stored.state).toBe('succeeded');expect(stored.receipt.applicationsStarted).toBe(false);
   const readback=await fixture.verify();expect(readback).toMatchObject({sqlRows:true,vectors:true,oldPairsCleared:true,devicesOffline:true,applicationsStarted:false,sourceUnchanged:true,databases:3});
   expect((await (await call('/api/maintenance/restore',approval)).json()).id).toBe(restore.id);
   const occupied=await (await call('/api/maintenance/restore/previews',{...request,requestKey:randomUUID()})).json();const occupiedClaim=(await api('claim',{runnerId})).job;expect(occupiedClaim.id).toBe(occupied.id);expect(await executeWebRestoreJob(occupiedClaim,runOptions)).toMatchObject({state:'failed',errorCode:'TARGET_EXISTS'});await fixture.verify();
   const dump=path.join(fixture.source,'databases/rag.dump'),original=await fs.readFile(dump),corrupt=Buffer.from(original);corrupt[0]^=1;await fs.writeFile(dump,corrupt);
   const badTarget=fixture.targetProject+'-bad',bad=await (await call('/api/maintenance/restore/previews',{...request,requestKey:randomUUID(),targetProject:badTarget})).json(),badClaim=(await api('claim',{runnerId})).job;
   expect(badClaim.id).toBe(bad.id);expect(await executeWebRestoreJob(badClaim,runOptions)).toMatchObject({state:'failed',errorCode:'CHECKPOINT_INVALID'});expect(await containers(composeClient({directory:fixture.directory,projectName:badTarget,files:fixture.files}))).toEqual([]);
   expect((await docker(['volume','ls','--format','{{.Name}}'])).split('\n').some((name:string)=>name.startsWith(badTarget+'_'))).toBe(false);await fs.writeFile(dump,original);await fixture.verify();
   evidence={pipeline:'actual Nest HTTP → isolated PostgreSQL request/receipt → separate host runner → Docker Compose PG16 restore',sourceProject:fixture.sourceProject,targetProject:fixture.targetProject,checkpointSha256:fixture.sha256,receipt:stored.receipt,checks:{...readback,exactRequestKeyReplay:true,occupiedTargetRejected:true,corruptedDumpRejectedBeforeContainerOrVolume:true,cleanupOwnFixturesOnly:true}};
  }finally{await fixture.dispose();}
  if(evidence){const {fileURLToPath}=await import('node:url');const output=fileURLToPath(new URL('../../../output/browser-feedback/web-restore-compose-live.json',import.meta.url));await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify({...evidence,cleanupComplete:true},null,2)+'\n');}
 },120000);

});
