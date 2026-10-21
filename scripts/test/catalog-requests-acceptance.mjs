import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startCatalogRequestsFixture} from './catalog-requests.fixture.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
if(!args.includes('--execute')){
 console.log('Prepare only. No HTTP servers, files or PostgreSQL resources were created.');
 console.log('Run: node scripts/test/catalog-requests-acceptance.mjs --execute [--browser]');
 console.log('Requires REQUESTS_QA_CONNECTION pointing to mode600 JSON {adminUrl} for the separate disposable PostgreSQL container; port5432 is rejected.');
 process.exit(0);
}
assert.ok(args.every(arg=>['--execute','--browser'].includes(arg)));
const connectionFile=process.env.REQUESTS_QA_CONNECTION||path.join(root,'.run/catalog-requests/qa-connection.json');
const {adminUrl}=JSON.parse(await fs.readFile(connectionFile,'utf8'));
const reportFile=process.env.REQUESTS_QA_REPORT||path.join(root,'.run/catalog-requests/acceptance.json');
const report={startedAt:new Date().toISOString(),cases:[],boundaries:{catalog:'Full actual Catalog AppModule and all providers',gateway:'Actual ProxyController, ProxyService and AuthGuardService',database:'Separate disposable PostgreSQL Docker instance; developer port5432 rejected',auth:'Loopback OAuth fixture with synthetic actors and fresh actual AccessDb claims',skills:'Loopback metadata fixture; no real skill files changed'},cleanup:false};
let fixture,interrupted=false;
const interrupt=()=>{interrupted=true;};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
const check=async(name,work)=>{await work();report.cases.push({name,passed:true});console.log('OK '+name);};
try{
 fixture=await startCatalogRequestsFixture({adminUrl,browser:args.includes('--browser')});
 const {request,pool,ids,actors,state}=fixture,base='/api/catalog-requests';
 report.database=fixture.database;
 const ref=type=>({type,id:ids[type]});
 const input=(overrides={})=>({requestKey:randomUUID(),kind:'add',assetType:'plugin',title:'QA request '+randomUUID().slice(0,6),description:'A concrete request from independent HTTP acceptance.',sourceUrl:fixture.sourceProbeUrl,projectId:ids.projectA,...overrides});
 const create=(actor,overrides={},status=201)=>request(actor,base,{method:'POST',body:input(overrides),status});
 const action=(actor,row,name,extra={},status=201)=>request(actor,base+'/'+row.id+'/actions',{method:'POST',body:{requestKey:randomUUID(),expectedRevision:row.revision,action:name,...extra},status});
 const edit=(actor,row,extra={},status=200)=>request(actor,base+'/'+row.id,{method:'PATCH',body:{requestKey:randomUUID(),expectedRevision:row.revision,title:row.title,description:row.description,sourceUrl:row.sourceUrl,...(row.target?{target:{type:row.target.type,id:row.target.id}}:{}),...extra},status});
 const get=(actor,row,status=200)=>request(actor,base+'/'+row.id,{status});
 let global,project,returned,completed;
 await check('Full Catalog boots with migrations0..8 and actual Gateway can authorize the new routes',async()=>{
  const versions=(await pool.query('SELECT version FROM catalog_schema_migrations ORDER BY version')).rows.map(row=>row.version);
  assert.deepEqual(versions,[0,1,2,3,4,5,6,7,8]);
  assert.equal((await fetch(fixture.catalogUrl+'/ready')).status,200);
  assert.deepEqual(await request('owner',base),{items:[],total:0,page:1,size:20});
 });
 await check('Anonymous, forged actor and real device Bearer cannot enter browser intake',async()=>{
  await request(null,base,{status:401});
  await request(null,base,{status:401,headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actors.main.email,activeRole:'Главный админ'}))}});
  await request(null,base,{status:403,headers:{authorization:'Bearer '+fixture.deviceToken}});
  assert.equal((await fetch(fixture.catalogUrl+base)).status,403);
 });
 await check('All four asset types accept add, update and issue requests with a real matching target',async()=>{
  for(const assetType of ['plugin','mcp','skill','model']){
   const targets=await request('owner',base+'/targets?assetType='+assetType+'&projectId='+ids.projectA);
   assert.ok(targets.items.some(item=>item.id===ids[assetType]&&item.type===assetType));
   const add=await create('owner',{assetType});assert.equal(add.status,'submitted');assert.equal(add.target,null);
   for(const kind of ['update','issue']){
    const row=await create('owner',{kind,assetType,target:ref(assetType)});
    assert.equal(row.target.id,ids[assetType]);assert.equal(row.target.available,true);assert.equal(row.history.length,1);
   }
  }
 });
 await check('Owner identity comes from actual authentication; submitted source URLs never trigger a fetch or build',async()=>{
  project=await request('owner',base,{method:'POST',status:201,body:input(),headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actors.main.email,activeRole:'Главный админ'})),'x-neurocenter-internal':'forged'}});
  assert.equal(project.createdBy,actors.owner.email);
  assert.equal(state.dependencyRequests.some(item=>item.path==='/never-download-source'),false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tool_build_jobs')).rows[0].n,0);
 });
 await check('Retry aliases create one row and one history event; conflicting key reuse is409',async()=>{
  const body=input(),rows=await Promise.all([request('owner',base,{method:'POST',body,status:201}),request('owner',base,{method:'POST',body,status:201})]);
  assert.equal(rows[0].id,rows[1].id);assert.equal((await get('owner',rows[0])).history.length,1);
  await request('owner',base,{method:'POST',body:{...body,title:'Changed same-key input'},status:409});
 });
 await check('Unknown input, unsafe URLs, missing targets and unsupported filters fail400; malformed routes stay denied',async()=>{
  for(const extra of [{kind:'delete'},{assetType:'agent'},{title:' '},{description:''},{sourceUrl:'javascript:alert(1)'},{sourceUrl:'https://user:secret@example.test/'},{requestKey:'not-uuid'},{createdBy:actors.main.email},{kind:'update'},{kind:'issue',target:ref('model')},{target:ref('plugin')},{projectId:'not-project'}])
   await create('owner',extra,400);
  await request('owner',base+'/not-uuid',{status:403});
  for(const query of ['scope=everything','size=0','page=-1','status=lost','kind=delete','assetType=agent','unexpected=1'])await request('owner',base+'?'+query,{status:400});
 });
 await check('Missing, archived, wrong-kind or foreign-project catalog cards cannot be referenced',async()=>{
  await create('owner',{kind:'update',target:{type:'plugin',id:'ai-plug-'+randomUUID()}},409);
  await create('owner',{kind:'update',target:{type:'plugin',id:ids.mcp}},409);
  await create('owner',{kind:'update',projectId:ids.projectB,target:ref('plugin')},403);
  await pool.query('UPDATE ai_plugins SET archived_at=now() WHERE id=$1',[ids.plugin]);
  try{await create('owner',{kind:'issue',target:ref('plugin')},409);}finally{await pool.query('UPDATE ai_plugins SET archived_at=NULL WHERE id=$1',[ids.plugin]);}
 });
 await check('Other developers cannot list or inspect a peer request, even inside the same project',async()=>{
  assert.equal((await request('other',base+'?scope=all')).total,0);
  await get('other',project,404);await edit('other',project,{},404);
 });
 await check('Global requests are visible only to their author and the currently active main administrator',async()=>{
  global=await create('owner',{projectId:null});
  await get('reviewer',global,404);await get('mainAsDeveloper',global,404);
  assert.equal((await get('main',global)).permissions.canReview,true);
  await action('owner',global,'start',{},403);
 });
 await check('A project membership cannot restore revoked platform administrator privileges',async()=>{
  await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actors.main.email]);
  await pool.query("UPDATE project_members SET role='Главный админ' WHERE project_id=$1 AND principal_name=$2",[ids.projectA,actors.main.email]);
  try{await get('main',global,401);await request('main',base+'?scope=all',{status:401});}
  finally{
   await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[actors.main.email]);
   await pool.query("UPDATE project_members SET role='Разработчик' WHERE project_id=$1 AND principal_name=$2",[ids.projectA,actors.main.email]);
  }
  assert.equal((await get('main',global)).permissions.canReview,true);
 });
 await check('Project review is limited by both the selected role and the current project grant',async()=>{
  assert.equal((await get('reviewer',project)).permissions.canReview,true);
  await get('foreign',project,404);
  const beta=await create('foreign',{projectId:ids.projectB});
  await get('reviewer',beta,404);
  await create('owner',{projectId:ids.projectB},403);
  const visible=await request('reviewer',base+'?scope=all');assert.ok(visible.items.every(item=>item.projectId===ids.projectA||item.createdBy===actors.reviewer.email));
 });
 await check('Observer can submit and follow an own request but cannot review it',async()=>{
  const row=await create('viewer');assert.equal(row.permissions.canEdit,true);assert.equal(row.permissions.canReview,false);
  await action('viewer',row,'start',{},403);
 });
 await check('Editing uses CAS, rejects immutable field changes and keeps prior history',async()=>{
  const before=await get('owner',project);
  project=await edit('owner',before,{title:'QA owner edited request'});assert.equal(project.revision,before.revision+1);
  await edit('owner',before,{title:'Stale overwrite'},409);
  await request('owner',base+'/'+project.id,{method:'PATCH',status:400,body:{requestKey:randomUUID(),expectedRevision:project.revision,title:'Forged scope',description:'x',projectId:null}});
  const saved=await get('owner',project);assert.equal(saved.title,project.title);assert.deepEqual(saved.history.map(item=>item.revision),[1,2]);
 });
 await check('Review requires comments, and an add request cannot complete without a matching existing card',async()=>{
  await action('reviewer',project,'needs_info',{},400);
  await action('reviewer',project,'reject',{},400);
  await action('reviewer',project,'complete',{comment:'Premature'},409);
  project=await action('reviewer',project,'start');
  await action('reviewer',project,'complete',{comment:'Missing result card'},400);
  await action('reviewer',project,'complete',{comment:'Wrong kind',target:ref('mcp')},400);
  await edit('owner',project,{title:'Cannot overwrite in progress'},403);
  completed=await action('reviewer',project,'complete',{comment:'Added the requested plugin.',target:ref('plugin')});assert.equal(completed.status,'completed');
  assert.equal(completed.target.id,ids.plugin);assert.equal(completed.permissions.canReview,false);
 });
 await check('Needs-info, owner edit and resubmission preserve a linear append-only history',async()=>{
  returned=await create('owner',{kind:'issue',assetType:'model',target:ref('model')});
  returned=await action('reviewer',returned,'needs_info',{comment:'Provide reproduction details.'});
  returned=await get('owner',returned);assert.equal(returned.permissions.canResubmit,true);
  returned=await edit('owner',returned,{description:'Reproduction details added.'});
  returned=await action('owner',returned,'resubmit');assert.equal(returned.status,'submitted');
  assert.deepEqual(returned.history.map(item=>item.action),['create','needs_info','edit','resubmit']);
  assert.deepEqual(returned.history.map(item=>item.revision),[1,2,3,4]);
  for(const event of returned.history){assert.match(event.at,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);assert.equal(new Date(event.at).toISOString(),event.at);}
  await request('owner',base+'/'+returned.id,{method:'PATCH',status:400,body:{requestKey:randomUUID(),expectedRevision:returned.revision,title:'x',description:'x',history:[]}});
 });
 await check('Two concurrent reviewers cannot both change the same revision',async()=>{
  const row=await create('owner');
  const statuses=await Promise.all(['reviewer','main'].map(async actor=>{
   const response=await fetch(fixture.gatewayUrl+base+'/'+row.id+'/actions',{method:'POST',headers:{cookie:fixture.cookie(actor),'content-type':'application/json','x-neurocenter-request':'1',origin:fixture.base},body:JSON.stringify({requestKey:randomUUID(),expectedRevision:row.revision,action:'start'})});
   await response.text();return response.status;
  }));assert.deepEqual(statuses.sort(),[201,409]);assert.equal((await get('owner',row)).history.length,2);
 });
 await check('Completed, rejected and cancelled requests cannot be edited or revived',async()=>{
  const rejected=await action('reviewer',await create('owner'),'reject',{comment:'Already covered by another tool.'});
  const cancelled=await action('owner',await create('owner'),'cancel');
  for(const row of [completed,rejected,cancelled]){
   await edit('owner',row,{title:'Revived'},403);await action('owner',row,'resubmit',{},403);await action('main',row,'start',{},403);
   assert.equal((await get('owner',row)).status,row.status);
  }
 });
 await check('Deleted target retains its historical name but cannot complete an in-progress request',async()=>{
  const id='ai-plug-'+randomUUID();await pool.query("INSERT INTO ai_plugins(id,name,kind) VALUES($1,'QA transient plugin','plugin')",[id]);
  await pool.query("INSERT INTO project_assets(project_id,asset_id,asset_kind) VALUES($1,$2,'plugin')",[ids.projectA,id]);
  let row=await create('owner',{kind:'issue',target:{type:'plugin',id}});row=await action('reviewer',row,'start');
  await pool.query('DELETE FROM ai_plugins WHERE id=$1',[id]);await action('reviewer',row,'complete',{comment:'Gone'},409);
  const saved=await get('owner',row);assert.equal(saved.target.available,false);assert.equal(saved.target.name,'QA transient plugin');assert.equal(saved.status,'in_progress');
 });
 await check('Removing a project assignment invalidates completion instead of silently using a global card',async()=>{
  let row=await create('owner',{kind:'issue',target:ref('plugin')});row=await action('reviewer',row,'start');
  await pool.query("DELETE FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind='plugin'",[ids.projectA,ids.plugin]);
  try{await action('reviewer',row,'complete',{comment:'Scope changed'},409);assert.equal((await get('owner',row)).target.available,false);}
  finally{await pool.query("INSERT INTO project_assets(project_id,asset_id,asset_kind) VALUES($1,$2,'plugin')",[ids.projectA,ids.plugin]);}
 });
 await check('A skill outage is visible as unknown availability; missing skills cannot complete',async()=>{
  let row=await create('owner',{kind:'issue',assetType:'skill',target:ref('skill')});row=await action('reviewer',row,'start');
  state.skillsAvailable=false;
  try{assert.equal((await get('owner',row)).target.available,null);await action('reviewer',row,'complete',{comment:'Dependency down'},503);}
  finally{state.skillsAvailable=true;}
  state.skillPresent=false;
  try{await action('reviewer',row,'complete',{comment:'Skill missing'},409);assert.equal((await get('owner',row)).target.available,false);}
  finally{state.skillPresent=true;}
 });
 await check('Revoked owner access and reviewer grants take effect without a new browser session',async()=>{
  await pool.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2',[ids.projectA,actors.owner.email]);
  try{await get('owner',returned,401);}finally{await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,'Разработчик')",[ids.projectA,actors.owner.email]);}
  await pool.query("UPDATE project_members SET role=CASE WHEN project_id=$1 THEN 'Разработчик' ELSE 'Админ проекта' END WHERE principal_name=$2",[ids.projectA,actors.reviewer.email]);
  try{await get('reviewer',returned,404);}finally{await pool.query("UPDATE project_members SET role=CASE WHEN project_id=$1 THEN 'Админ проекта' ELSE 'Разработчик' END WHERE principal_name=$2",[ids.projectA,actors.reviewer.email]);}
 });
 await check('Deleting a project never promotes its private requests into global scope',async()=>{
  const id='prj-qa-deleted-'+randomUUID();await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[id,'QA deleted '+id]);
  await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,'Разработчик')",[id,actors.owner.email]);
  const row=await create('owner',{projectId:id});await pool.query('DELETE FROM projects WHERE id=$1',[id]);
  assert.equal((await get('main',row)).projectId,id);await get('owner',row,404);await get('reviewer',row,404);
 });
 await check('Auth outage fails closed and recovery reads the fresh request state',async()=>{
  state.authAvailable=false;try{await get('owner',returned,503);}finally{state.authAvailable=true;}
  assert.equal((await get('owner',returned)).id,returned.id);
 });
 await check('Shared audit shows human-readable request decisions without private content',async()=>{
  let row=await create('owner',{title:'QA readable audit request',description:'PRIVATE_REQUEST_DESCRIPTION',sourceUrl:'https://example.test/PRIVATE_SOURCE_URL'});
  row=await action('main',row,'start');row=await action('main',row,'needs_info',{comment:'PRIVATE_REVIEW_COMMENT'});
  const audit=await request('main','/api/audit?page=1&size=100'),events=audit.items.filter(item=>item.resourceId===row.id);
  assert.ok(events.some(item=>item.action==='catalog_request.create'));
  const decision=events.find(item=>item.action==='catalog_request.needs_info');
  assert.equal(decision.details.after.title,row.title);assert.equal(decision.details.after.status,'needs_info');
  assert.equal(decision.details.after.assetType,'plugin');assert.equal(decision.details.after.revision,row.revision);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_REQUEST_DESCRIPTION|PRIVATE_SOURCE_URL|PRIVATE_REVIEW_COMMENT|"description"|"sourceUrl"|"comment"/);
 });
 if(args.includes('--browser')){
  const contextFile=path.join(root,'.run/catalog-requests/browser-context.json'),release=path.join(root,'.run/catalog-requests/browser.release');
  await fs.rm(release,{force:true});
  const context={base:fixture.base,gateway:fixture.gatewayUrl,catalog:fixture.catalogUrl,database:fixture.database,ids,
   login:Object.fromEntries(Object.keys(actors).map(actor=>[actor,fixture.loginUrl(actor)])),release,expiresAt:new Date(Date.now()+30*60000).toISOString()};
  await fs.mkdir(path.dirname(contextFile),{recursive:true});await fs.writeFile(contextFile,JSON.stringify(context,null,2)+'\n',{mode:0o600});
  console.log('BROWSER_READY '+JSON.stringify({contextFile,base:fixture.base}));
  const deadline=Date.now()+30*60000;let released=false;
  while(Date.now()<deadline&&!interrupted){try{await fs.stat(release);released=true;break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,250));}
  assert.ok(released,'Browser fixture timed out or was interrupted.');report.browserGateReleased=true;
 }
}catch(error){report.failure=error?.stack||String(error);report.startupCleanupFailed=error?.fixtureCleanupFailed===true;process.exitCode=1;console.error(error);}
finally{
 try{await fixture?.close();report.cleanup=!report.startupCleanupFailed;}catch(error){report.cleanupError=String(error);process.exitCode=1;}
 report.finishedAt=new Date().toISOString();await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({reportFile,passed:report.cases.length,failed:report.failure?1:0,cleanup:report.cleanup}));
 process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
}
