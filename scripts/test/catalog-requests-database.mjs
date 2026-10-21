import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'services/catalog-service/package.json'));
require('ts-node').register({transpileOnly:true,project:path.join(root,'services/catalog-service/tsconfig.json')});
const {Pool}=require('pg'),{migrateCatalog}=require('./src/database/migrations.ts'),{CATALOG_MIGRATIONS}=require('./src/database/catalog-migrations.ts');
const {assertCurrentCatalogSchema}=require('./src/database/current-schema-verification.ts');
const {CatalogRequestRepository}=require('./src/catalog-requests/request.repository.ts');
const {checkedTarget}=require('./src/catalog-requests/request.targets.ts'),{currentActor}=require('./src/catalog-requests/request.access.ts');
const {AccessDb}=require('./src/access/access-db.ts');
const connection=process.env.REQUESTS_QA_ADMIN_URL;
if(!connection)throw Error('REQUESTS_QA_ADMIN_URL must explicitly name the disposable QA PostgreSQL container.');
const baseUrl=new URL(connection);
assert.equal(baseUrl.hostname,'127.0.0.1');assert.ok(baseUrl.port);assert.notEqual(baseUrl.port,'5432');assert.equal(baseUrl.pathname,'/postgres');
const admin=new Pool({connectionString:connection}),name='nc_requests_domain_'+process.pid,cases=[];
const check=async(name,action)=>{await action();cases.push(name);};
let pool,created=false,skillsUnavailable=false,sourceFetches=0;
const skills=http.createServer((req,res)=>{
 if(req.url!=='/api/skills'){sourceFetches++;res.writeHead(404);res.end();return;}
 if(skillsUnavailable){res.writeHead(503);res.end();return;}
 assert.equal(req.headers['x-neurocenter-internal'],'requests-qa-only');
 res.setHeader('content-type','application/json');res.end(JSON.stringify([
  {path:'common/qa_skill',meta:{name:'QA skill',version:1}},
  {path:'project-alpha/private_skill',meta:{name:'Private skill',version:2}},
 ]));
});
const owner={email:'owner@example.test',activeRole:'Разработчик'},main={email:'main@example.test',activeRole:'Главный админ'},reviewer={email:'reviewer@example.test',activeRole:'Админ проекта'},stranger={email:'other@example.test',activeRole:'Разработчик'};
const input=(overrides={})=>({requestKey:randomUUID(),kind:'add',assetType:'mcp',title:'MCP intake',description:'Required for a project',...overrides});
const action=(row,action,extra={})=>({requestKey:randomUUID(),expectedRevision:row.revision,action,...extra});
const rejects=(promise,status)=>assert.rejects(promise,error=>error.getStatus?.()===status);
try{
 skills.listen(0,'127.0.0.1');await once(skills,'listening');
 process.env.SKILLS_SERVICE_URL='http://127.0.0.1:'+skills.address().port;process.env.NEUROCENTER_INTERNAL_TOKEN='requests-qa-only';
 await admin.query('CREATE DATABASE '+name);created=true;const url=new URL(connection);url.pathname='/'+name;pool=new Pool({connectionString:url.href,max:8});
 await migrateCatalog(pool,CATALOG_MIGRATIONS);await assertCurrentCatalogSchema(pool);
 await pool.query(`INSERT INTO platform_users(email,display_name,is_main_admin) VALUES('main@example.test','Main',true),('owner@example.test','Owner',false),('reviewer@example.test','Reviewer',false),('other@example.test','Other',false);
 INSERT INTO projects(id,name) VALUES('prj-alpha','alpha'),('prj-other','other');
 INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-alpha','owner','owner@example.test','Owner','Разработчик'),('prj-alpha','reviewer','reviewer@example.test','Reviewer','Админ проекта'),('prj-other','other','other@example.test','Other','Разработчик');
 INSERT INTO ai_plugins(id,name,kind) VALUES('mcp-qa','QA MCP','mcp'),('plugin-qa','QA Plugin','plugin');
 INSERT INTO model_catalog(id,name,descriptor) VALUES('model-qa','QA Model','{}');
 INSERT INTO project_assets(project_id,asset_id,asset_kind) VALUES('prj-alpha','mcp-qa','mcp'),('prj-alpha','plugin-qa','plugin'),('prj-alpha','common/qa_skill','skill');
 INSERT INTO project_models(project_id,model_id,added_by) VALUES('prj-alpha','model-qa','main@example.test');`);
 const repo=new CatalogRequestRepository(pool);
 await check('Migration8 is complete, repeatable and preserves all previously applied checksums',async()=>{
  const before=(await pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows;
  await Promise.all([migrateCatalog(pool,CATALOG_MIGRATIONS),migrateCatalog(pool,CATALOG_MIGRATIONS)]);
  assert.deepEqual((await pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows,before);
 });
 let projectRequest,globalRequest,globalPayload;
 await check('Concurrent duplicate creation has one durable request, history event and security event',async()=>{
  const payload=input({projectId:'prj-alpha',sourceUrl:process.env.SKILLS_SERVICE_URL+'/must-not-fetch-source'});
  const rows=await Promise.all([repo.create(owner,payload),repo.create(owner,payload),repo.create(owner,payload)]);
  assert.equal(new Set(rows.map(row=>row.id)).size,1);projectRequest=rows[0];assert.equal(projectRequest.revision,1);assert.equal(projectRequest.history.length,1);
  assert.match(projectRequest.history[0].at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(projectRequest.history[0].at).toISOString(),projectRequest.history[0].at);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1',[projectRequest.id])).rows[0].n,1);
  await rejects(repo.create(owner,{...payload,title:'Different payload'}),409);assert.equal(sourceFetches,0);
 });
 await check('Queue and detail isolation use current project scope; global requests never leak to project admins',async()=>{
  globalPayload=input();globalRequest=await repo.create(owner,globalPayload);
  assert.equal((await repo.list(reviewer,{scope:'all'})).items.length,1);
  assert.equal((await repo.list(stranger,{scope:'all'})).items.length,0);
  await rejects(repo.get(stranger,projectRequest.id),404);await rejects(repo.get(reviewer,globalRequest.id),404);
  assert.equal((await repo.list(main,{scope:'all'})).total,2);
  await rejects(repo.create(stranger,input({projectId:'prj-alpha'})),403);
 });
 await check('Actual access claims and request authorization never promote a project role to platform main admin',async()=>{
  const access=Object.create(AccessDb.prototype);Object.defineProperty(access,'pool',{value:pool});
  await pool.query("UPDATE project_members SET role='Главный админ' WHERE principal_name='owner@example.test'");
  try{
   assert.equal((await access.claims(owner.email)).userRoles.includes('Главный админ'),false);
   await rejects(repo.list({...owner,activeRole:'Главный админ'},{scope:'all'}),403);
   assert.equal((await access.claims(main.email)).userRoles.includes('Главный админ'),true);
  }finally{await pool.query("UPDATE project_members SET role='Разработчик' WHERE principal_name='owner@example.test'");}
 });
 await check('CAS prevents lost edits and duplicate retry never reverts a later edit',async()=>{
  const edit={requestKey:randomUUID(),expectedRevision:projectRequest.revision,title:'Edited',description:'Updated details'};
  projectRequest=await repo.edit(owner,projectRequest.id,edit);assert.equal(projectRequest.revision,2);
  assert.equal((await repo.edit(owner,projectRequest.id,edit)).revision,2);
  await rejects(repo.edit(owner,projectRequest.id,{...edit,requestKey:randomUUID()}),409);
  await rejects(repo.edit(stranger,projectRequest.id,{...edit,requestKey:randomUUID(),expectedRevision:2}),404);
 });
 await check('Reviewer clarification requires owner resubmission before work can start',async()=>{
  projectRequest=await repo.action(reviewer,projectRequest.id,action(projectRequest,'needs_info',{comment:'Specify the source'}));
  assert.equal(projectRequest.status,'needs_info');assert.equal((await repo.get(owner,projectRequest.id)).permissions.canResubmit,true);
  await rejects(repo.action(reviewer,projectRequest.id,action(projectRequest,'start')),409);
  projectRequest=await repo.action(owner,projectRequest.id,action(projectRequest,'resubmit'));
  projectRequest=await repo.action(reviewer,projectRequest.id,action(projectRequest,'start'));
  assert.equal(projectRequest.status,'in_progress');assert.equal(projectRequest.permissions.canEdit,false);
  await rejects(repo.edit(owner,projectRequest.id,{requestKey:randomUUID(),expectedRevision:projectRequest.revision,title:'Late',description:'Late'}),403);
 });
 await check('Completion rejects missing, wrong-kind or unassigned targets and invalid transitions without partial history',async()=>{
  const count=projectRequest.history.length;
  await rejects(repo.action(reviewer,projectRequest.id,action(projectRequest,'complete',{comment:'Done'})),400);
  await rejects(repo.action(reviewer,projectRequest.id,action(projectRequest,'complete',{comment:'Done',target:{type:'plugin',id:'plugin-qa'}})),400);
  await rejects(repo.action(reviewer,projectRequest.id,action(projectRequest,'complete',{comment:'Done',target:{type:'mcp',id:'absent'}})),409);
  assert.equal((await repo.get(owner,projectRequest.id)).history.length,count);
  projectRequest=await repo.action(reviewer,projectRequest.id,action(projectRequest,'complete',{comment:'Added and connected',target:{type:'mcp',id:'mcp-qa'}}));
  assert.equal(projectRequest.target.available,true);assert.equal(projectRequest.status,'completed');
  await rejects(repo.action(owner,projectRequest.id,action(projectRequest,'cancel')),403);
 });
 await check('Four kinds of catalog target, including underscore skills, complete through verified project scope',async()=>{
  for(const [type,id]of [['plugin','plugin-qa'],['skill','common/qa_skill'],['model','model-qa']]){
   let row=await repo.create(owner,input({projectId:'prj-alpha',assetType:type}));row=await repo.action(reviewer,row.id,action(row,'start'));
   row=await repo.action(reviewer,row.id,action(row,'complete',{comment:'Available in the project',target:{type,id}}));
   assert.equal(row.target.id,id);assert.equal(row.target.version,1);assert.equal(row.target.available,true);
  }
 });
 await check('Global discovery excludes project-native skills; current project native skills remain selectable',async()=>{
  assert.equal((await repo.targets(main,{assetType:'skill'})).items.some(row=>row.id==='project-alpha/private_skill'),false);
  assert.equal((await repo.targets(reviewer,{assetType:'skill',projectId:'prj-alpha'})).items.some(row=>row.id==='project-alpha/private_skill'),true);
  await rejects(repo.create(main,input({kind:'issue',assetType:'skill',target:{type:'skill',id:'project-alpha/private_skill'}})),409);
 });
 await check('Update and issue intake requires existing exact targets and explicit resolution',async()=>{
  for(const kind of ['update','issue']){
   let row=await repo.create(owner,input({kind,assetType:'model',projectId:'prj-alpha',target:{type:'model',id:'model-qa'}}));
   row=await repo.action(reviewer,row.id,action(row,'start'));row=await repo.action(reviewer,row.id,action(row,'complete',{comment:'Verified the requested change'}));assert.equal(row.status,'completed');
  }
 });
 await check('Target archive and project unassignment report unavailable without destroying historical card metadata',async()=>{
  await pool.query("UPDATE ai_plugins SET archived_at=now() WHERE id='mcp-qa'");
  const archived=await repo.get(owner,projectRequest.id);assert.equal(archived.target.available,false);assert.equal(archived.target.name,'QA MCP');
  await pool.query("UPDATE ai_plugins SET archived_at=NULL WHERE id='mcp-qa';DELETE FROM project_assets WHERE project_id='prj-alpha' AND asset_id='mcp-qa'");
  assert.equal((await repo.get(owner,projectRequest.id)).target.available,false);
 });
 await check('Skill outage is unknown for old history and fails completion without changing status or revision',async()=>{
  let row=await repo.create(owner,input({assetType:'skill',projectId:'prj-alpha'}));row=await repo.action(reviewer,row.id,action(row,'start'));
  const complete=action(row,'complete',{comment:'Done',target:{type:'skill',id:'common/qa_skill'}});
  skillsUnavailable=true;await rejects(repo.action(reviewer,row.id,complete),503);assert.equal((await repo.get(owner,row.id)).revision,row.revision);
  const existing=(await repo.list(main,{scope:'all',assetType:'skill'})).items.find(item=>item.target);assert.equal(existing.target.available,null);
  skillsUnavailable=false;
 });
 await check('Target validation locks the card and assignment until the same transaction commits',async()=>{
  const checking=await pool.connect(),competing=await pool.connect();
  try{
   await checking.query('BEGIN');await checkedTarget(checking,await currentActor(checking,reviewer),{type:'plugin',id:'plugin-qa'},'plugin','prj-alpha');
   for(const sql of ["UPDATE ai_plugins SET archived_at=now() WHERE id='plugin-qa'","DELETE FROM project_assets WHERE project_id='prj-alpha' AND asset_id='plugin-qa'"]){
    await competing.query('BEGIN');await competing.query("SET LOCAL lock_timeout='75ms'");await assert.rejects(competing.query(sql),error=>error.code==='55P03');await competing.query('ROLLBACK');
   }
  }finally{await checking.query('ROLLBACK');checking.release();competing.release();}
 });
 await check('Audit failure rolls back edited state, request history and idempotency receipt together',async()=>{
  const previous=await repo.get(owner,globalRequest.id),key=randomUUID();
  await pool.query(`CREATE FUNCTION qa_reject_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit outage'; END $$;
   CREATE TRIGGER qa_reject_request_audit BEFORE INSERT ON security_events FOR EACH ROW WHEN (NEW.action='catalog_request.edit') EXECUTE FUNCTION qa_reject_request_audit();`);
  try{
   await assert.rejects(repo.edit(owner,globalRequest.id,{requestKey:key,expectedRevision:previous.revision,title:'Must roll back',description:'Must roll back'}),/fixture audit outage/);
   assert.deepEqual(await repo.get(owner,globalRequest.id),previous);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_request_mutations WHERE request_key=$1',[key])).rows[0].n,0);
  }finally{await pool.query('DROP FUNCTION qa_reject_request_audit() CASCADE');}
 });
 await check('Concurrent review CAS applies one transition, and revoked project admins lose review immediately',async()=>{
  const row=await repo.create(owner,input({projectId:'prj-alpha'}));
  const results=await Promise.allSettled([repo.action(reviewer,row.id,action(row,'start')),repo.action(reviewer,row.id,action(row,'reject',{comment:'Not needed'}))]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.find(value=>value.status==='rejected').reason.getStatus(),409);
  await pool.query("UPDATE project_members SET role='Наблюдатель' WHERE principal_name='reviewer@example.test'");
  await rejects(repo.list(reviewer,{scope:'all'}),403);
  await pool.query("UPDATE project_members SET role='Админ проекта' WHERE principal_name='reviewer@example.test'");
 });
 await check('Revocation hides even owned project requests and deleted projects retain historical scope for main admin only',async()=>{
  await pool.query("DELETE FROM project_members WHERE principal_name='owner@example.test';INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-other','owner-other','owner@example.test','Owner','Разработчик')");
  await rejects(repo.get(owner,projectRequest.id),404);assert.equal((await repo.list(owner,{scope:'all'})).items.some(item=>item.projectId==='prj-alpha'),false);
  await pool.query("DELETE FROM project_assets WHERE project_id='prj-alpha';DELETE FROM project_models WHERE project_id='prj-alpha';DELETE FROM project_members WHERE project_id='prj-alpha';DELETE FROM projects WHERE id='prj-alpha'");
  const history=await repo.get(main,projectRequest.id);assert.equal(history.projectId,'prj-alpha');assert.equal(history.projectName,'alpha');assert.equal(history.target.available,false);
 });
 await check('Disabled accounts cannot use old idempotency receipts or read their own global intake',async()=>{
  await pool.query("UPDATE platform_users SET enabled=false WHERE email='owner@example.test'");await rejects(repo.get(owner,globalRequest.id),403);await rejects(repo.create(owner,globalPayload),403);
 });
 console.log(JSON.stringify({isolatedDatabase:name,passed:cases.length,cases}));
}finally{
 await pool?.end();if(created)await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();skills.closeAllConnections();await new Promise(resolve=>skills.close(resolve));
}
