import {randomUUID} from 'node:crypto';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {approvedRuntimeArtifact} from '../src/devices/runtime-job-artifact';
import {ForbiddenException} from '@nestjs/common';
import {statfs} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {ownedTestPostgresAdmin} from '../../../scripts/test/owned-postgres.fixture.mjs';
import {migrateCatalog} from '../src/database/migrations';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {assertCurrentCatalogSchema} from '../src/database/current-schema-verification';
import {PluginAutoUpdateRepository} from '../src/plugin-auto-updates/auto-update.repository';
import {deviceJobRequestHash} from '../src/devices/device-job-requests';
import {enqueueDeviceJob} from '../src/devices/device-enqueue';
import type {JobInput} from '../src/devices/device-job.model';
import type {IAccessClaims} from '../src/access/access.model';
import {AccessDb} from '../src/access/access-db';
import {DeviceStore} from '../src/devices/device-store';
import {DeviceInstallations} from '../src/devices/device-installations';
import {InstallPlans} from '../src/devices/install-plans';
import {DeviceJobs} from '../src/devices/device-jobs';
import {completeDeviceJob} from '../src/devices/device-completion';
import {PluginRepository} from '../src/publication/plugin-repository';
import {ProjectAssetRepository} from '../src/catalog/project-asset-repository';
import {checkedProjectPackage} from '../src/catalog/project-asset-pins';
import {PluginAutoUpdateService} from '../src/plugin-auto-updates/auto-update.service';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
vi.mock('../src/devices/device-operations',async original=>({...await original<typeof import('../src/devices/device-operations')>(),notifyDeviceOperations:vi.fn(async()=>undefined)}));
const url=process.env.PLUGIN_AUTO_UPDATE_TEST_ADMIN_URL,actor={email:'auto-policy@fixture.test',activeRole:'Разработчик'};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};

describe.skipIf(!url).sequential('Plugin update policy + ordinary queue on explicitly owned PostgreSQL16',()=>{
 let admin:Pool,pool:Pool,database:string,repository:PluginAutoUpdateRepository;
 const application='nc-auto-update-'+randomUUID(),binding='a'.repeat(64);
 let target:{deviceId:string;projectId:string;bindingId:string;assetId:string};
 beforeAll(async()=>{
  const disk=await statfs(process.cwd());if(disk.bavail*disk.bsize<4*1024**3)throw Error('Owned PostgreSQL fixture requires4GiB free.');
  const parsed=ownedTestPostgresAdmin(url);admin=new Pool({connectionString:parsed.href,max:1,connectionTimeoutMillis:3000});
  expect(Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)/10000)).toBe(16);
  database='nc_auto_update_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+database);parsed.pathname='/'+database;
  pool=new Pool({connectionString:parsed.href,max:8,statement_timeout:15000,application_name:application});
  await migrateCatalog(pool,CATALOG_MIGRATIONS);await assertCurrentCatalogSchema(pool);repository=new PluginAutoUpdateRepository(pool);
 },30000);
 beforeEach(async()=>{
  target={deviceId:randomUUID(),projectId:'prj-auto-'+randomUUID(),bindingId:binding,assetId:'fixture-plugin'};
  await pool.query('INSERT INTO projects(id,name) VALUES($1,$1)',[target.projectId]);
  await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,last_seen,report) VALUES($1,$2,$3,$1,$4,$5,now(),$6::jsonb)',
   [target.deviceId,actor.email,actor.activeRole,'b'.repeat(32),randomUUID(),JSON.stringify({bindings:[{projectId:target.projectId,bindingId:binding}]})]);
 });
 afterEach(async()=>{if(!pool)return;await pool.query('DELETE FROM plugin_auto_update_policies');await pool.query('DELETE FROM bridge_jobs');await pool.query('DELETE FROM bridge_devices');await pool.query('DELETE FROM projects');await pool.query('DELETE FROM platform_users');await pool.query('DELETE FROM ai_plugins');vi.unstubAllGlobals();});
 afterAll(async()=>{await pool?.end();if(admin){try{if(database)await admin.query('DROP DATABASE '+database);}finally{await admin.end();}}});
 const enable=()=>repository.save(actor,{...target,enabled:true,expectedRevision:0,requestKey:randomUUID()});
 const prepare=async()=>{
  await enable();const [claimed]=await repository.claim();
  const input:JobInput={deviceId:target.deviceId,projectId:target.projectId,kind:'install',requestKey:randomUUID(),assetId:target.assetId,assetKind:'plugin',version:2,
   expectedBindingId:binding,expectedManifest:'c'.repeat(64),planId:randomUUID(),planRevision:1};
  const row=await repository.prepare(claimed,input);if(!row)throw Error('Own claim lost');return{row,input};
 };
 const claims=():IAccessClaims=>({email:actor.email,userRoles:[actor.activeRole],projects:[{projectId:target.projectId,projectName:'Fixture',role:actor.activeRole}],pluginIds:[],skillPaths:[]});
 const queued=(input:JobInput)=>({id:randomUUID(),deviceId:target.deviceId,email:actor.email,role:actor.activeRole,projectId:target.projectId,kind:'install',requestKey:input.requestKey,
  requestHash:deviceJobRequestHash(actor.activeRole,input),payload:{assetId:target.assetId,assetKind:'plugin',bindingId:binding,planId:input.planId,planRevision:input.planRevision,package:{manifest:{sha256:'c'.repeat(64)}}}});
 const waitLocked=async()=>{
  const deadline=Date.now()+5000;
  while(!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[application])).rowCount){
   if(Date.now()>deadline)throw Error('Own expected lock not observed');await new Promise(done=>setTimeout(done,10));
  }
 };
 it('the full current ledger and all schema owners are ready',async()=>{
  expect((await pool.query('SELECT version FROM catalog_schema_migrations ORDER BY version')).rows.map(row=>row.version)).toEqual(CATALOG_MIGRATIONS.map(row=>row.version));
  await assertCurrentCatalogSchema(pool);
 });
 it('serializes opt-in CAS and exact retry without a second audit event',async()=>{
  const input={...target,enabled:true,expectedRevision:0,requestKey:randomUUID()},first=await repository.save(actor,input),replay=await repository.save(actor,input);
  expect(replay.id).toBe(first.id);expect(Number(replay.revision)).toBe(1);
  await expect(repository.save(actor,{...input,enabled:false})).rejects.toMatchObject({status:409});
  await expect(repository.save(actor,{...input,requestKey:randomUUID()})).rejects.toMatchObject({status:409});
  expect((await pool.query("SELECT count(*) FROM security_events WHERE action='plugin.auto-update.policy' AND resource_id=$1",[first.id])).rows[0].count).toBe('1');
 });
 it('rechecks authorization after waiting for a concurrent policy write',async()=>{
  const row=await enable(),locker=await pool.connect(),authorized=vi.fn(async()=>{throw new ForbiddenException('Fixture grant revoked');});
  let saving:ReturnType<PluginAutoUpdateRepository['save']>|undefined;
  try{
   await locker.query('BEGIN');await locker.query('SELECT id FROM plugin_auto_update_policies WHERE id=$1 FOR UPDATE',[row.id]);
   saving=repository.save(actor,{...target,enabled:true,expectedRevision:1,requestKey:randomUUID()},authorized);saving.catch(()=>undefined);
   await waitLocked();expect(authorized).not.toHaveBeenCalled();
  }finally{await locker.query('ROLLBACK');locker.release();}
  await expect(saving).rejects.toMatchObject({status:403});expect((await repository.read(actor,target))?.revision).toBe(1);
 });
 it.each(['text','runtime'] as const)('published %s catalog version waits for pin/approval, then scheduler uses exact DeviceJobs completion',async distribution=>{
  // The real owners share an explicitly injected owned pool; no default localhost database is constructed.
  const access=Object.assign(Object.create(AccessDb.prototype),{pool}) as AccessDb;
  const singleStorePool=new Pool({connectionString:pool.options.connectionString,max:1,connectionTimeoutMillis:1000,application_name:application});
  const store=Object.assign(Object.create(DeviceStore.prototype),{pool:singleStorePool,access}) as DeviceStore;
  const installations=new DeviceInstallations(store),plans=new InstallPlans(store,{} as never),jobs=new DeviceJobs(store,{} as never,installations,plans,{} as never);
  const service=new PluginAutoUpdateService(store,installations,plans,jobs),adminActor={email:'admin-policy@fixture.test',activeRole:'Админ проекта'};
  await pool.query('INSERT INTO platform_users(email) VALUES($1),($2)',[actor.email,adminActor.email]);
  await pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3),($1,$4,$4,$4,$5)',[target.projectId,actor.email,actor.activeRole,adminActor.email,adminActor.activeRole]);
  await pool.query("UPDATE bridge_devices SET report=report||$2::jsonb WHERE id=$1",[target.deviceId,JSON.stringify({protocolVersion:2,capabilities:['durable-completions','managed-installations','install-set-v1','package-v4','package-v5']})]);
  const flags=evaluateFeatureFlags(defaultFeatureFlags());
  vi.stubGlobal('fetch',vi.fn(async(raw:string)=>{if(!String(raw).endsWith('/internal/feature-flags/evaluated'))throw Error('Unexpected fixture egress');return new Response(JSON.stringify(flags));}));
  const catalog=new PluginRepository(pool),assignments=new ProjectAssetRepository(pool);
  const archives=[1,2].map(version=>artifactFixture([{path:'plugin.mjs',content:'export default '+version+';'},...(version===2?[{path:'README.md',content:'Updated runtime contents'}]:[])]));
  const delivery=(version:number)=>distribution==='runtime'?{config:{extra:{runtimeArtifacts:[archives[version-1].descriptor]}},files:[]}
   :{config:{entrypoint:'plugin.mjs'},files:[{path:'plugin.mjs',content:'export default '+version+';',size:0,digest:''}]};
  if(distribution==='runtime')for(const {descriptor} of archives)await pool.query('INSERT INTO bridge_runtime_artifacts(sha256,compressed_bytes,unpacked_bytes,files_count) VALUES($1,$2,$3,$4)',[descriptor.sha256,descriptor.compressedBytes,descriptor.unpackedBytes,descriptor.filesCount]);
  const first=await catalog.create({name:'Auto fixture '+randomUUID(),kind:'plugin',description:'Owned fixture',...delivery(1)},adminActor.email);
  target.assetId=first.id;await assignments.add(target.projectId,first.id,'plugin',adminActor.email);
  const initial=checkedProjectPackage((await pool.query('SELECT * FROM project_assets WHERE project_id=$1',[target.projectId])).rows[0]);
  await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,created_at)
   VALUES($1,$2,$3,$4,$5,'install',$6,$7,$8,'succeeded',now()-interval '1 minute')`,[randomUUID(),target.deviceId,actor.email,actor.activeRole,target.projectId,{package:initial,assetId:first.id,assetKind:'plugin',version:1,bindingId:binding},randomUUID(),'c'.repeat(64)]);
  const due=async()=>{await pool.query('UPDATE plugin_auto_update_policies SET next_check_at=clock_timestamp()');await service.tick();};
  try{
   await service.save(actor,{...target,enabled:true,expectedRevision:0,requestKey:randomUUID()});await service.wake();
   expect((await repository.read(actor,target))?.status).toBe('up-to-date');
   const second=await catalog.update(first.id,{expectedVersion:1,...delivery(2)},adminActor.email);expect(second?.version).toBe(2);
   await due();expect((await repository.read(actor,target))?.message).toContain('Админ проекта');
   expect((await pool.query("SELECT count(*) FROM bridge_jobs WHERE payload->>'version'='2'")).rows[0].count).toBe('0');
   await assignments.pin(target.projectId,first.id,'plugin',adminActor.email,{version:2,expectedVersion:1,expectedManifest:initial.manifest.sha256});
   await due();expect((await repository.read(actor,target))?.message).toContain('план ещё не одобрен');
   const plan=await plans.prepare(actor,{projectId:target.projectId,assetId:first.id,assetKind:'plugin',version:2});
   await plans.decide(adminActor,plan.id,{expectedManifest:plan.manifest,expectedRevision:plan.revision},'approved');
   await due();const queuedPolicy=await repository.read(actor,target);expect(queuedPolicy?.status).toBe('queued');
   const device=await store.owned(actor,target.deviceId),job=await jobs.claim(device);expect(job?.id).toBe(queuedPolicy?.job_id);expect(job?.payload.package.plugin.version).toBe(2);
   await jobs.authorize(device,job!.id,job!.lease!);
   if(distribution==='runtime'){
    expect(job!.payload.package.schemaVersion).toBe(5);expect(job!.payload.package.config?.extra?.runtimeArtifacts).toEqual([archives[1].descriptor]);
    expect(await approvedRuntimeArtifact(pool,target.deviceId,job!.id,job!.lease!,archives[1].descriptor.sha256)).toEqual(archives[1].descriptor);
    await expect(approvedRuntimeArtifact(pool,target.deviceId,job!.id,job!.lease!,archives[0].descriptor.sha256)).rejects.toThrow('не входит');
   }
   const installed=job!.payload.package as typeof initial;
   await completeDeviceJob(pool,target.deviceId,job!.id,{lease:job!.lease!,state:'succeeded',message:'Fixture ordinary bridge receipt',result:{projectId:target.projectId,assetId:first.id,version:2,manifest:installed.manifest.sha256,bindingId:binding,ok:true}});
   await due();expect((await service.read(actor,target)).policy).toMatchObject({status:'succeeded',job:{state:'succeeded'}});
   expect((await installations.workspacePackages(actor.email,target.deviceId,target.projectId,binding))[0].plugin.version).toBe(2);
   expect((await pool.query("SELECT count(*) FROM bridge_jobs WHERE payload->>'version'='2'")).rows[0].count).toBe('1');
  }finally{await service.onModuleDestroy();await singleStorePool.end();}
 });
 it('a policy is claimed once across two concurrent schedulers',async()=>{
  await enable();const [left,right]=await Promise.all([repository.claim(),repository.claim()]);expect([...left,...right]).toHaveLength(1);
 });
 it('keeps its owner/device/binding identity immutable in PostgreSQL',async()=>{
  const row=await enable();await expect(pool.query('UPDATE plugin_auto_update_policies SET binding_id=$2 WHERE id=$1',[row.id,'d'.repeat(64)])).rejects.toThrow('immutable');
  expect((await repository.read(actor,target))?.binding_id).toBe(binding);
 });
 it('a JSONB persisted input survives key reordering and a disabled policy is denied at actual queue admission',async()=>{
  const {row,input}=await prepare();const observer=await pool.connect();try{await observer.query('BEGIN');await repository.admit(observer,row,input);await observer.query('ROLLBACK');}finally{observer.release();}
  await repository.save(actor,{...target,enabled:false,expectedRevision:1,requestKey:randomUUID()});
  await expect(enqueueDeviceJob(pool,'id,state,message',queued(input),async db=>{await repository.admit(db,row,input);return claims();})).rejects.toMatchObject({status:409});
  expect((await pool.query('SELECT count(*) FROM bridge_jobs')).rows[0].count).toBe('0');
 });
 it('a disable waits for an already admitted ordinary queue transaction and leaves that receipt available',async()=>{
  const {row,input}=await prepare(),admitted=deferred(),release=deferred();
  const enqueuing=enqueueDeviceJob(pool,'id,state,message',queued(input),async db=>{await repository.admit(db,row,input);admitted.resolve();await release.promise;return claims();});
  enqueuing.catch(()=>undefined);
  let disabling:ReturnType<PluginAutoUpdateRepository['save']>|undefined;
  try{
   await Promise.race([admitted.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Own admission deadline')),6000))]);
   disabling=repository.save(actor,{...target,enabled:false,expectedRevision:1,requestKey:randomUUID()});disabling.catch(()=>undefined);
   await waitLocked();expect((await pool.query('SELECT enabled FROM plugin_auto_update_policies WHERE id=$1',[row.id])).rows[0].enabled).toBe(true);
  }finally{release.resolve();}
  const job=await enqueuing;await disabling;expect((await repository.read(actor,target))?.enabled).toBe(false);
  expect(await repository.receipt(row,input)).toMatchObject({id:job.id,state:'queued'});
 });
 it('a restarted owner finds the committed existing queue receipt after losing the create ACK',async()=>{
  const {row,input}=await prepare(),job=await enqueueDeviceJob(pool,'id,state,message',queued(input),async db=>{await repository.admit(db,row,input);return claims();});
  expect((await repository.read(actor,target))?.job_id).toBeNull();
  const restarted=new PluginAutoUpdateRepository(pool);expect(await restarted.receipt(row,input)).toMatchObject({id:job.id,state:'queued'});
  const rechecked=await restarted.save(actor,{...target,enabled:true,expectedRevision:1,requestKey:randomUUID()});expect(rechecked.pending_input?.requestKey).toBe(input.requestKey);
  expect((await pool.query('SELECT count(*) FROM bridge_jobs')).rows[0].count).toBe('1');
 });
 it('preserves an accepted request identity when the same owner disables and reenables under another role',async()=>{
  const {row,input}=await prepare(),job=await enqueueDeviceJob(pool,'id,state,message',queued(input),async db=>{await repository.admit(db,row,input);return claims();});
  const changedRole={...actor,activeRole:'Админ проекта'};
  await repository.save(changedRole,{...target,enabled:false,expectedRevision:1,requestKey:randomUUID()});
  const resumed=await repository.save(changedRole,{...target,enabled:true,expectedRevision:2,requestKey:randomUUID()});
  expect(resumed.actor_role).toBe(changedRole.activeRole);expect(resumed.pending_role).toBe(actor.activeRole);expect(resumed.pending_input?.requestKey).toBe(input.requestKey);expect(await repository.receipt(resumed,input)).toMatchObject({id:job.id,state:'queued'});
  expect((await pool.query('SELECT count(*) FROM bridge_jobs')).rows[0].count).toBe('1');
 });
 it('an explicit recheck confirms absence under the policy lock before replacing an unadmitted request key',async()=>{
  const {row,input}=await prepare();const rechecked=await repository.save(actor,{...target,enabled:true,expectedRevision:1,requestKey:randomUUID()});
  expect(rechecked.pending_input).toBeNull();expect((await repository.read(actor,target))?.revision).toBe(2);
  await expect(enqueueDeviceJob(pool,'id,state,message',queued(input),async db=>{await repository.admit(db,row,input);return claims();})).rejects.toMatchObject({status:409});
  expect((await pool.query('SELECT count(*) FROM bridge_jobs')).rows[0].count).toBe('0');
 });
 it('readiness rejects a missing policy guard instead of silently treating history as ready',async()=>{
  await pool.query('DROP TRIGGER plugin_auto_update_identity_guard ON plugin_auto_update_policies');
  try{await expect(assertCurrentCatalogSchema(pool)).rejects.toThrow('автообновления');}
  finally{await pool.query('CREATE TRIGGER plugin_auto_update_identity_guard BEFORE UPDATE ON plugin_auto_update_policies FOR EACH ROW EXECUTE FUNCTION plugin_auto_update_identity_guard()');}
  await assertCurrentCatalogSchema(pool);
 });
});
