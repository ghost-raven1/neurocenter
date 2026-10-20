import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url)),ts=require('typescript');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,file);
const source=file=>require(path.join(root,'services/catalog-service/src',file+'.ts'));
const {Pool}=require('pg'),{AccessDb}=source('access/access-db'),{DeviceStore}=source('devices/device-store'),{DeviceInstallations}=source('devices/device-installations'),{InstallPlans}=source('devices/install-plans');
const {setupModelsSchema,ModelsRepository}=source('models/models.repository'),{ProjectEmbeddingRepository}=source('models/project-embedding.repository'),{setupInstallPlans}=source('devices/install-plan-schema'),{setupProjectAssetPins}=source('catalog/project-asset-pins');
const {setupHostedRagGrantRevocations}=source('devices/hosted-rag-grant-schema'),{registerHostedRagGrant,completeHostedRagGrant,readHostedRagGrant}=source('devices/hosted-rag-grants');
const {HostedRagGrantService}=source('models/hosted-rag-grant.service'),{DeviceEmbeddingService}=source('models/device-embedding.service'),{saveModelVersion,modelFromRow}=source('models/model-history'),{projectEmbeddingPin}=source('models/project-embedding.validation'),{buildPackage}=source('catalog/bundle-package');
const adminUrl=process.env.REMOTE_MODEL_TEST_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres',admin=new Pool({connectionString:adminUrl,max:1}),database='nc_hosted_grants_'+randomUUID().replaceAll('-','');
const before=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate')).rows.map(row=>row.datname),originalPg=process.env.CATALOG_PG_URL,originalFetch=globalThis.fetch;
let created=false,pool,access,store,fatal;const checks=[];
const check=async(name,action)=>{try{await action();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});throw error;}};
try{
 await admin.query('CREATE DATABASE "'+database+'"');created=true;const url=new URL(adminUrl);url.pathname='/'+database;process.env.CATALOG_PG_URL=url.href;pool=new Pool({connectionString:url.href,max:8});
 await pool.query(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE project_members(project_id TEXT,user_id TEXT,principal_name TEXT,role TEXT,PRIMARY KEY(project_id,user_id)); CREATE TABLE project_assets(project_id TEXT,asset_id TEXT,asset_kind TEXT,added_by TEXT,added_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(project_id,asset_kind,asset_id));`);
 access=new AccessDb();await access.ready();store=new DeviceStore(access);await store.ready();await setupModelsSchema(pool);await new ProjectEmbeddingRepository(pool).setup();await setupProjectAssetPins(pool);await setupInstallPlans(pool);
 const projectId='prj-grants',email='grants@example.test',bindingId='a'.repeat(64),instanceId=randomUUID(),role='Разработчик';
 await pool.query('INSERT INTO projects VALUES($1,$2)',[projectId,'Grant fixture']);await pool.query('INSERT INTO platform_users(email) VALUES($1)',[email]);await pool.query('INSERT INTO project_members VALUES($1,$2,$3,$4)',[projectId,'user',email,role]);
 const report={capabilities:['workspace-instance-v1','opencode-rag-ui-v1','hosted-rag-model-v1','hosted-rag-grants-v1','package-v5'],bindings:[{projectId,bindingId,instanceId,valid:true}]};
 const device=async id=>{await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$1,$4,$5,$6)',[id,email,role,'a'.repeat(64),randomUUID(),JSON.stringify(report)]);return store.owned({email,activeRole:role},id);};
 const first=await device(randomUUID()),second=await device(randomUUID());
 const models=[];for(let n=1;n<=2;n++){
  const descriptor={description:'',capability:'embedding',runtime:'ollama',model:'fixture:v'+n,manifestSha256:String(n).repeat(64),dimension:3,source:'custom'};
  const row=(await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2) RETURNING *',['model-grant-'+n,JSON.stringify(descriptor)])).rows[0];await saveModelVersion(pool,row);models.push(modelFromRow(row));await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[projectId,row.id,email]);
 }
 const selections=models.map((model,index)=>({projectId,revision:index+1,model,modelPin:projectEmbeddingPin(model),profile:{provider:'openai',model:`neurocenter/${model.id}/sha256/${projectEmbeddingPin(model)}`,dimension:3},expectedDimension:3,activeGeneration:'initial-'+('a'.repeat(32)),activeSnapshot:null,dataRevision:0}));
 const select=async(index)=>pool.query(`INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation) VALUES($1,$2,$3,$4,3,$5,$6) ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,model_id=EXCLUDED.model_id,model_pin=EXCLUDED.model_pin,dimension=3`,[projectId,selections[index].revision,models[index].id,selections[index].modelPin,email,selections[index].activeGeneration]);await select(0);
 const packages=[];for(const kind of ['mcp','plugin']){
  const pkg=buildPackage({id:'rag-'+kind,name:'Fixture '+kind,kind,version:1},[{path:'opencode-rag.mjs',content:'export const fixture=1'}],new Date().toISOString(),{entrypoint:'opencode-rag.mjs',extra:{hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2},runtimeArtifacts:[{target:'darwin-arm64',sha256:'f'.repeat(64),compressedBytes:1,unpackedBytes:1,filesCount:1,entrypoint:'opencode-rag.mjs'}],localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']}}});
  const planId=randomUUID();await pool.query(`INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot) VALUES($1,$2,$3,$4,1,$5,'assigned',$6)`,[projectId,pkg.plugin.id,kind,email,pkg.manifest.sha256,JSON.stringify({card:{},package:pkg})]);
  await pool.query(`INSERT INTO device_install_plans(id,project_id,asset_kind,asset_id,version,manifest,package,status,revision,created_by) VALUES($1,$2,$3,$4,1,$5,$6,'approved',1,$7)`,[planId,projectId,kind,pkg.plugin.id,pkg.manifest.sha256,JSON.stringify(pkg),email]);packages.push({pkg,planId});
 }
 const job=async(dev,pkg,index,state='running',kind='connect-rag-model')=>{
  const id=randomUUID(),lease=randomUUID(),payload={assetId:pkg.pkg.plugin.id,assetKind:pkg.pkg.plugin.kind,version:1,package:pkg.pkg,bindingId,instanceId,embedding:selections[index],planId:pkg.planId,planRevision:1,approvalRoot:{kind:pkg.pkg.plugin.kind,id:pkg.pkg.plugin.id,version:1},approvalManifest:pkg.pkg.manifest.sha256};
  const row=(await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,lease,lease_until,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$1,$1,$8,$9,now()+interval '3 minutes',now()) RETURNING *`,[id,dev.id,email,role,projectId,kind,JSON.stringify(payload),state,lease])).rows[0];return row;
 };
 for(const dev of [first,second])for(const pkg of packages)await job(dev,pkg,0,'succeeded','install');
 const installations=new DeviceInstallations(store),plans=new InstallPlans(store,{}),selection={ready:async()=>{}};
 const grants=new HostedRagGrantService(store,installations,plans,selection);await grants.ready();
 const input=(pkg,index)=>({projectId,bindingId,instanceId,expectedRevision:selections[index].revision,expectedModelPin:selections[index].modelPin,installation:{kind:pkg.pkg.plugin.kind,id:pkg.pkg.plugin.id,version:1,manifest:pkg.pkg.manifest.sha256},model:selections[index].profile.model,input:['fixture']});
 const validate=async(dev,record)=>{await source('devices/rag-ui-jobs').assertRagUiJob(installations,plans,dev,{kind:'open-rag-ui',project_id:projectId,payload:record.payload});};
 const authorize=async(dev,pkg,index)=>{const record=await job(dev,pkg,index);await registerHostedRagGrant(pool,dev,record,record.lease,()=>validate(dev,record));return record;};
 const flags=Object.fromEntries(require(path.join(root,'services/shared/feature-flags.cjs')).FEATURE_FLAGS.map(flag=>[flag.key,true]));globalThis.fetch=async()=>Response.json({flags});
 let inferences=0,hold,onInference;const broker=new DeviceEmbeddingService(store,{infer:async(model)=>{inferences++;onInference?.();if(hold)await hold;return {embeddings:[[model.id===models[0].id?1:2,1,3]]};}},grants);
 const can=async(dev,pkg,index)=>broker.embed(dev,input(pkg,index));
 let oldA,oldB;
 await check('Pre-execution cancellation has no grant; authorize creates exact grants before completion',async()=>{
  const cancelled=await job(first,packages[0],0,'cancelled');await assert.rejects(registerHostedRagGrant(pool,first,cancelled,cancelled.lease,async()=>{}));
  await assert.rejects(can(first,packages[0],0));assert.equal(inferences,0);oldA=await authorize(first,packages[0],0);oldB=await authorize(second,packages[0],0);await authorize(first,packages[1],0);
  assert.equal((await can(first,packages[0],0)).data[0].embedding[0],1);
 });
 await check('Global promotion preserves exact historical model on other devices and other installed packages',async()=>{
  await select(1);assert.equal((await can(first,packages[0],0)).data[0].embedding[0],1);assert.equal((await can(second,packages[0],0)).data[0].embedding[0],1);await assert.rejects(can(first,packages[0],1));
  const candidate=await authorize(first,packages[0],1);assert.equal((await can(first,packages[0],1)).data[0].embedding[0],2);await pool.query("UPDATE bridge_jobs SET state='failed' WHERE id=$1",[candidate.id]);assert.equal((await can(first,packages[0],0)).data[0].embedding[0],1);
  const success=await authorize(first,packages[0],1);await completeHostedRagGrant(pool,success.id);await assert.rejects(can(first,packages[0],0));assert.equal((await can(second,packages[0],0)).data[0].embedding[0],1);assert.equal((await can(first,packages[1],0)).data[0].embedding[0],1);
 });
 await check('Exact installation identity and explicit grant are required even when the current pin matches',async()=>{
  for(const patch of [{installation:undefined},{installation:{...input(packages[0],1).installation,manifest:'e'.repeat(64)}},{installation:{...input(packages[0],1).installation,version:2}},{expectedRevision:1}])await assert.rejects(broker.embed(first,{...input(packages[0],1),...patch}));
 });
 await check('Model assignment remove/readd produces a new UUID epoch and cannot revive an old grant',async()=>{
  await pool.query('DELETE FROM project_models WHERE project_id=$1 AND model_id=$2',[projectId,models[1].id]);await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[projectId,models[1].id,email]);await assert.rejects(can(first,packages[0],1));await authorize(first,packages[0],1);await can(first,packages[0],1);
 });
 await check('Approval revoke/reapprove and uninstall/reinstall do not revive an old authorization',async()=>{
  await pool.query("UPDATE device_install_plans SET status='revoked' WHERE id=$1",[packages[0].planId]);await pool.query("UPDATE device_install_plans SET status='approved' WHERE id=$1",[packages[0].planId]);await assert.rejects(can(first,packages[0],1));await authorize(first,packages[0],1);
  const uninstall=await job(first,packages[0],1,'running','uninstall');await pool.query("UPDATE bridge_jobs SET state='succeeded' WHERE id=$1",[uninstall.id]);await job(first,packages[0],1,'succeeded','install');await assert.rejects(can(first,packages[0],1));await authorize(first,packages[0],1);
 });
 await check('Transient device report/offline/paused state preserves grants; verified identity changes revoke them',async()=>{
  await pool.query("UPDATE bridge_devices SET last_seen=NULL,paused_until=now()+interval '1 minute',report='{}' WHERE id=$1",[first.id]);await pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[first.id,JSON.stringify(report)]);await can(first,packages[0],1);
  const changed={...report,bindings:[{projectId,bindingId,instanceId:randomUUID(),valid:true}]};await pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[first.id,JSON.stringify(changed)]);await pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[first.id,JSON.stringify(report)]);await assert.rejects(can(first,packages[0],1));await authorize(first,packages[0],1);
 });
 await check('Rights withdrawal during inference discards late vectors; restoring rights requires a new intent',async()=>{
  let release,entered;hold=new Promise(resolve=>release=resolve);const arrived=new Promise(resolve=>entered=resolve);onInference=entered;const pending=can(first,packages[0],1);await arrived;onInference=undefined;
  await pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1",[projectId]);release();await assert.rejects(pending);hold=undefined;await pool.query("UPDATE project_members SET role='Разработчик' WHERE project_id=$1",[projectId]);await assert.rejects(can(first,packages[0],1));await authorize(first,packages[0],1);
 });
 await check('Concurrent authorization is idempotent; uninstall wins a blocked authorization without leaking a new grant',async()=>{
  const record=await job(first,packages[0],1);
  await Promise.all([1,2].map(()=>registerHostedRagGrant(pool,first,record,record.lease,()=>validate(first,record))));assert.equal((await pool.query('SELECT count(*)::int AS n FROM bridge_hosted_rag_grants WHERE job_id=$1',[record.id])).rows[0].n,1);
  const uninstall=await job(first,packages[0],1,'running','uninstall'),candidate=await job(first,packages[0],1),lock=await pool.connect();
  let rejected;
  try{
   await lock.query('BEGIN');await lock.query('SELECT id FROM bridge_devices WHERE id=$1 FOR UPDATE',[first.id]);
   const pending=registerHostedRagGrant(pool,first,candidate,candidate.lease,()=>validate(first,candidate));pending.catch(()=>{});
   const deadline=Date.now()+3000;let blocked=false;
   while(Date.now()<deadline){const result=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM bridge_devices%' AND query LIKE '%FOR SHARE'");if(result.rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
   assert.equal(blocked,true);await lock.query("UPDATE bridge_jobs SET state='succeeded' WHERE id=$1",[uninstall.id]);await lock.query('COMMIT');
   try{await pending;}catch(error){rejected=error;}assert.ok(rejected);assert.equal((await pool.query('SELECT count(*)::int AS n FROM bridge_hosted_rag_grants WHERE job_id=$1',[candidate.id])).rows[0].n,0);
  }finally{await lock.query('ROLLBACK');lock.release();}
  await job(first,packages[0],1,'succeeded','install');await authorize(first,packages[0],1);await can(first,packages[0],1);
 });
 await check('Role revocation waits for authorization locks and permanently revokes the just-issued grant',async()=>{
  const candidate=await job(first,packages[0],1);let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const pending=registerHostedRagGrant(pool,first,candidate,candidate.lease,async()=>{await validate(first,candidate);entered();await gate;});await inside;
  const revoking=pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1",[projectId]);let revoked=false;void revoking.then(()=>revoked=true);
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(revoked,false);release();await pending;await revoking;
  assert.notEqual((await pool.query('SELECT revoked_at FROM bridge_hosted_rag_grants WHERE job_id=$1',[candidate.id])).rows[0].revoked_at,null);
  await pool.query("UPDATE project_members SET role='Разработчик' WHERE project_id=$1",[projectId]);await assert.rejects(can(first,packages[0],1));await authorize(first,packages[0],1);
 });
 await check('Project package assignment remove/readd never revives a grant for the same current pin',async()=>{
  const pkg=packages[0].pkg;
  const previous=(await pool.query('SELECT * FROM project_assets WHERE project_id=$1 AND asset_kind=$2 AND asset_id=$3',[projectId,pkg.plugin.kind,pkg.plugin.id])).rows[0];
  await pool.query('DELETE FROM project_assets WHERE project_id=$1 AND asset_kind=$2 AND asset_id=$3',[projectId,pkg.plugin.kind,pkg.plugin.id]);
  await pool.query('INSERT INTO project_assets(project_id,asset_kind,asset_id,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[projectId,pkg.plugin.kind,pkg.plugin.id,email,previous.asset_version,previous.asset_manifest,previous.pin_origin,previous.pin_snapshot]);
  await assert.rejects(can(first,packages[0],1));await authorize(first,packages[0],1);await can(first,packages[0],1);
 });
 await check('Revoked private configuration permanently revokes historical remote grants without touching other models',async()=>{
  const descriptor={description:'',capability:'embedding',runtime:'remote-openai',model:'remote-fixture',modelVersion:'v1',manifestSha256:null,verificationSha256:'e'.repeat(64),dimension:3,source:'custom'};
  const row=(await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2) RETURNING *',['model-private-grant',JSON.stringify(descriptor)])).rows[0];await saveModelVersion(pool,row);const model=modelFromRow(row);models.push(model);
  await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[projectId,model.id,email]);
  await pool.query("INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,semantic_sha,verified_at) VALUES($1,1,'http://127.0.0.1:1',false,'none',$2,now())",[model.id,model.verificationSha256]);
  const profile={provider:'openai',model:`neurocenter/${model.id}/sha256/${projectEmbeddingPin(model)}`,dimension:3};selections.push({...selections[1],revision:3,model,modelPin:projectEmbeddingPin(model),profile});
  await select(2);await authorize(first,packages[0],2);await select(1);await can(first,packages[0],2);
  await pool.query('UPDATE model_remote_connections SET revoked_at=now() WHERE model_id=$1',[model.id]);await assert.rejects(can(first,packages[0],2));await can(first,packages[0],1);
  await pool.query('UPDATE model_remote_connections SET revoked_at=NULL WHERE model_id=$1',[model.id]);await assert.rejects(can(first,packages[0],2));
 });
 await check('Explicit selection disable revokes every historical grant; reselect alone grants nothing',async()=>{
  await pool.query('UPDATE project_embedding_settings SET model_id=NULL,model_pin=NULL,dimension=NULL,revision=revision+1 WHERE project_id=$1',[projectId]);await select(1);await assert.rejects(can(first,packages[0],1));await assert.rejects(can(second,packages[0],0));
 });
 await check('One-off migration accepts only validated succeeded connections and never revives later revoked grants',async()=>{
  const trusted=await job(second,packages[1],1,'succeeded'),bad=await job(first,packages[1],1,'succeeded');
  const result={status:'connected',revision:2,modelPin:selections[1].modelPin,profile:selections[1].profile,requiresRestart:true};
  await pool.query('UPDATE bridge_jobs SET result=$2 WHERE id=$1',[trusted.id,JSON.stringify(result)]);await pool.query('UPDATE bridge_jobs SET result=$2 WHERE id=$1',[bad.id,JSON.stringify({...result,modelPin:'e'.repeat(64)})]);
  await pool.query("DELETE FROM bridge_hosted_grant_migrations WHERE name='trusted-succeeded-connections-v1'");
  await setupHostedRagGrantRevocations(pool,(record,db)=>grants.validateMigration(record,db));
  assert.equal((await readHostedRagGrant(pool,second,input(packages[1],1))).job_id,trusted.id);
  assert.equal((await pool.query('SELECT 1 FROM bridge_hosted_rag_grants WHERE job_id=$1',[bad.id])).rows.length,0);
  await pool.query('UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE job_id=$1',[trusted.id]);
  await setupHostedRagGrantRevocations(pool,async()=>{});await assert.rejects(readHostedRagGrant(pool,second,input(packages[1],1)));assert.ok(oldA.id&&oldB.id);
 });
}catch(error){fatal=error;}
finally{
 globalThis.fetch=originalFetch;if(store)await store.onModuleDestroy();if(access)await access.onModuleDestroy();if(pool)await pool.end();if(created)await admin.query('DROP DATABASE "'+database+'"');if(originalPg===undefined)delete process.env.CATALOG_PG_URL;else process.env.CATALOG_PG_URL=originalPg;
 const after=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate')).rows.map(row=>row.datname);await admin.end();const report={checks,ownDatabaseDropped:created,existingDatabasesPreserved:before.every(name=>after.includes(name)),fatal:fatal?.stack};await mkdir(path.join(root,'output/remote-models'),{recursive:true});await writeFile(path.join(root,'output/remote-models/hosted-grants-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(fatal)process.exitCode=1;
}
