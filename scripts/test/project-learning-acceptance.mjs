import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {databaseProof} from './agents-gateway-databases.mjs';
import {pause,reservePorts,waitHttp,spawnLogged,stopChild,startModelFixture,startMcp} from './project-learning-acceptance.runtime.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
if(!args.includes('--execute')){
 console.log('Prepare only. No requests, processes, files or databases created.');
 console.log('After fresh service/MCP builds: LEARNING_QA_BUILDS_DONE=1 node scripts/test/project-learning-acceptance.mjs --execute');
 console.log('Optional LEARNING_QA_BROWSER_GATE=1 keeps the disposable stack alive until browser.release; LEARNING_QA_BROWSER_TIMEOUT_MS defaults15min, max1h.');
 console.log('LEARNING_QA_PG_URL must be localhost /postgres. LEARNING_QA_BASELINE is required: read-only receipt for the local24-database acceptance fixture.');
 console.log('All application services are real compiled Nest apps. Only the loopback LLM upstream is MOCK_LLM; no external inference.');
 process.exit(0);
}
assert.deepEqual(args,['--execute']);assert.equal(process.env.LEARNING_QA_BUILDS_DONE,'1','Root must finish builds before this standalone acceptance run.');
assert.ok(process.env.LEARNING_QA_BASELINE,'Set LEARNING_QA_BASELINE to the private read-only receipt listing the24 existing databases.');
const baselineFile=path.resolve(process.env.LEARNING_QA_BASELINE);await fs.access(baselineFile);
const browserTimeout=Number(process.env.LEARNING_QA_BROWSER_TIMEOUT_MS||900000);
assert.ok(Number.isSafeInteger(browserTimeout)&&browserTimeout>=1000&&browserTimeout<=3600000,'Browser gate timeout must be between1s and1h.');
const pgUrl=new URL(process.env.LEARNING_QA_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(pgUrl.hostname));assert.equal(pgUrl.pathname,'/postgres');
assert.ok(Number(process.versions.node.split('.')[0])>=24,'Use the project Node24 runtime.');
process.umask(0o077);
const runId=randomUUID().replaceAll('-','').slice(0,12),database='nc_learning_qa_'+runId;
const output=path.join(repo,'.run/learning-qa',runId),temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-learning-qa-')));
await fs.mkdir(output,{recursive:true,mode:0o700});
const home=path.join(temporary,'home'),projects=path.join(temporary,'projects'),project=path.join(projects,'learning-'+runId),cwd=path.join(temporary,'services');
for(const folder of [home,project,cwd,path.join(temporary,'private')])await fs.mkdir(folder,{recursive:true,mode:0o700});
const node=process.execPath,runtime=path.join(repo,'mcp/neurocenter-asset-sync'),hash=value=>createHash('sha256').update(value).digest('hex');
const require=createRequire(path.join(repo,'services/catalog-service/package.json')),{Pool}=require('pg');
const dbUrl=new URL(pgUrl);dbUrl.pathname='/'+database;
const admin=new Pool({connectionString:pgUrl.href,max:1,statement_timeout:15000,connectionTimeoutMillis:5000});
const own=new Pool({connectionString:dbUrl.href,max:2,statement_timeout:15000,connectionTimeoutMillis:5000});
const report={runId,startedAt:new Date().toISOString(),cases:[],http:[],cleanup:[],resources:{database},modelFixture:{mock:true,externalRequests:0,requests:[]}};
const children=[],reservations=await reservePorts(['catalog','oauth','gateway','flags','frontend','model','unavailable']);
const urls=Object.fromEntries(Object.entries(reservations).map(([name,value])=>[name,'http://127.0.0.1:'+value.port]));
const secret=randomBytes(32).toString('hex'),email='learning-qa-'+runId+'@localhost';let session='',projectId,deviceId,deviceToken,binding,proof,before,dbOid,mcp,worker,modelFixture,fatal;
const interrupted=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>interrupted.abort(Error('Acceptance interrupted; cleaning only its own resources.')));
const env={PATH:process.env.PATH,LANG:'C.UTF-8',HOME:home,USERPROFILE:home,TMPDIR:temporary,
 XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),
 NODE_ENV:'development',BIND_HOST:'127.0.0.1',CATALOG_PG_URL:dbUrl.href,RAG_PG_URL:dbUrl.href,RAG_PROVISION_PG_URL:dbUrl.href,
 SSO_DISABLE:'true',DEV_USER_EMAIL:email,NEUROCENTER_INTERNAL_TOKEN:secret,AUTH_SERVICE_URL:urls.oauth,OAUTH2_BRIDGE_URL:urls.oauth,
 CATALOG_SERVICE_URL:urls.catalog,API_GATEWAY_URL:urls.gateway,FEATURE_FLAGS_SERVICE_URL:urls.flags,PANEL_URL:urls.frontend,
 SKILLS_SERVICE_URL:urls.unavailable,RAG_SERVICE_URL:urls.unavailable,OLLAMA_URL:urls.unavailable,
 PROJECTS_ROOT:projects,BACKUP_DIR:path.join(temporary,'backups'),MODEL_STORAGE_PATH:path.join(temporary,'models'),
 SNAPSHOT_STORAGE_DIR:path.join(temporary,'snapshots'),RUNTIME_ARTIFACT_DIR:path.join(temporary,'artifacts'),
 NEUROCENTER_URL:urls.frontend,NEUROCENTER_BRIDGE_HOME:path.join(temporary,'private'),
 OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',
 ...(process.env.OPENCODE_AGENT_TEST_ENGINE?{OPENCODE_AGENT_TEST_ENGINE:process.env.OPENCODE_AGENT_TEST_ENGINE}:{}),
 ...(process.env.OPENCODE_AGENT_TEST_ENGINE_SHA256?{OPENCODE_AGENT_TEST_ENGINE_SHA256:process.env.OPENCODE_AGENT_TEST_ENGINE_SHA256}:{})};
async function request(route,{method='GET',body,channel=false,token=deviceToken,status}={}){
 const headers={'content-type':'application/json','x-neurocenter-request':'1',origin:urls.frontend};
 if(!channel&&session)headers.cookie=session;if(channel&&token)headers.authorization='Bearer '+token;
 const response=await fetch(urls.frontend+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.any([interrupted.signal,AbortSignal.timeout(30000)])});
 const raw=await response.text();let value;try{value=raw?JSON.parse(raw):null;}catch{value=null;}
 report.http.push({method,route,status:response.status});
 if(status!==undefined)assert.equal(response.status,status,method+' '+route+': '+raw.slice(0,500));
 else assert.ok(response.ok,method+' '+route+' '+response.status+': '+raw.slice(0,1000));return value;
}
const post=(route,body,extra={})=>request(route,{method:'POST',body,...extra});
const channel=(route,body={},extra={})=>post('/api/device-channel/'+route,body,{channel:true,...extra});
async function check(name,work){interrupted.signal.throwIfAborted();await work();interrupted.signal.throwIfAborted();report.cases.push(name);console.log('OK '+name);}
async function helper(mode,input={}){
 const child=spawn(node,[path.join(repo,'scripts/test/project-learning-acceptance.fixture.mjs'),mode,runtime],{cwd:project,env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdin.end(JSON.stringify(input));
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(exit,0,stderr.slice(-5000));return JSON.parse(stdout);
}
async function launch(name,entry,extra={}){
 await reservations[name].release();const log=path.join(output,name+'.log'),child=spawnLogged(node,[entry],{...env,PORT:String(reservations[name].port),...extra},cwd,log);children.push(child);
 await waitHttp(urls[name]+'/',child,log,90000,interrupted.signal);return child;
}
async function waitJob(id){
 const deadline=Date.now()+90000;while(Date.now()<deadline){interrupted.signal.throwIfAborted();const item=(await request('/api/device-jobs')).find(row=>row.id===id);
  if(item&&['succeeded','failed','cancelled'].includes(item.state)){assert.equal(item.state,'succeeded',JSON.stringify(item));return item;}await pause(200);}
 throw Error('Own device job timed out '+id);
}
const learning=()=>'/api/projects/'+projectId+'/learning';
const overview=()=>request(learning());
async function mutation(route,body){const current=await overview();return post(learning()+route,{requestKey:randomUUID(),expectedRevision:current.revision,...body});}
try{
 await check('Read-only proof of24 working databases before disposable setup',async()=>{
  proof=await databaseProof(baselineFile,pgUrl.href);
  before=await proof.compare();assert.deepEqual(before.missing,[]);report.databasesBefore=before;
 });
 await check('Own uniquely named disposable PostgreSQL database, real schema migrations',async()=>{
  assert.match(database,/^nc_learning_qa_[a-f0-9]{12}$/);assert.ok(!proof.baseline.includes(database));
  await admin.query('CREATE DATABASE "'+database+'"');dbOid=(await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid;
  const log=path.join(output,'migrations.log'),child=spawnLogged(node,[path.join(repo,'services/catalog-service/dist/database/migrate.cli.js'),'migrate'],env,cwd,log);children.push(child);
  const code=await new Promise(resolve=>child.once('exit',resolve));await child.finishLog();assert.equal(code,0,await fs.readFile(log,'utf8'));
  assert.equal(Number((await own.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_name LIKE 'project_learning_%' AND table_schema='public'")).rows[0].n),9);
 });
 await check('Separate real compiled Catalog, OAuth, Gateway, feature flags and Vite processes',async()=>{
  for(const [name,service]of [['catalog','catalog-service'],['oauth','oauth2-bridge'],['flags','feature-flags-service'],['gateway','api-gateway']])await launch(name,path.join(repo,'services',service,'dist/main.js'));
  await reservations.frontend.release();const log=path.join(output,'frontend.log');
  const child=spawnLogged(node,[path.join(repo,'frontend/node_modules/vite/bin/vite.js'),path.join(repo,'frontend'),'--config',path.join(repo,'frontend/vite.config.ts'),'--host','127.0.0.1','--port',String(reservations.frontend.port),'--strictPort'],
   {...env,VITE_AUTH_PROXY_TARGET:urls.oauth,VITE_API_PROXY_TARGET:urls.gateway},cwd,log);children.push(child);await waitHttp(urls.frontend+'/',child,log,90000,interrupted.signal);
  await reservations.model.release();modelFixture=await startModelFixture(reservations.model.port,report.modelFixture.requests);await reservations.unavailable.release();
  report.resources.urls=urls;
 });
 await check('Separate dev main-admin session and project through Gateway',async()=>{
  const login=await fetch(urls.frontend+'/auth/login?returnTo=/start',{redirect:'manual'});await login.body?.cancel();assert.equal(login.status,302);
  assert.equal(new URL(login.headers.get('location')).origin,urls.frontend);session=login.headers.getSetCookie().find(value=>value.startsWith('bridge_session=')).split(';')[0];
  assert.equal((await request('/auth/me')).user.email,email);projectId=(await post('/api/projects',{name:'QA обучение '+runId})).id;report.resources.projectId=projectId;
  // Start before credentials exist: the real MCP index will not spawn an unowned detached worker.
  mcp=await startMcp(repo,node,env,project);const names=(await mcp.client.listTools()).tools.map(item=>item.name);
  for(const name of ['project_learning_context','project_learning_record','project_learning_propose_hypothesis'])assert.ok(names.includes(name));
  await mcp.call('project_learning_context',{},true);
 });
 await check('Real pairing, worker job and verified v2 project binding',async()=>{
  deviceToken=randomBytes(32).toString('hex');const pair=await channel('pair/start',{name:'QA обучение '+runId,fingerprint:hash(runId),credentialHash:hash(deviceToken)},{token:null});
  await post('/api/device-pairs/'+pair.userCode+'/approve',{});const connected=await channel('pair/poll',{deviceCode:pair.deviceCode},{token:null});assert.equal(connected.state,'connected');deviceId=connected.deviceId;
  await helper('bootstrap',{root:projects,credentials:{deviceId,token:deviceToken,email:connected.email}});
  const workerLog=path.join(output,'worker.log');worker=spawnLogged(node,[path.join(runtime,'dist/index.js'),'--worker'],env,project,workerLog);children.push(worker);
  const job=await post('/api/device-jobs',{deviceId,projectId,kind:'bind-project',requestKey:randomUUID(),folderName:path.basename(project),bindingMode:'new'});await waitJob(job.id);
  const observed=await helper('report');binding=observed.bindings.find(item=>item.projectId===projectId);assert.equal(binding.valid,true);assert.match(binding.bindingId,/^[a-f0-9]{64}$/);
  assert.equal(observed.version,JSON.parse(await fs.readFile(path.join(runtime,'package.json'),'utf8')).version);
  report.resources.bridgeRuntime={version:observed.version,buildId:observed.buildId};
  assert.equal(JSON.parse(await fs.readFile(path.join(project,'.opencode/neurocenter.json'),'utf8')).version,2);
 });
 let experience,hypothesis,candidate,emptyProject;
 await check('Real MCP records reported experience and proposes inactive hypothesis in PostgreSQL',async()=>{
  assert.deepEqual((await mcp.call('project_learning_context',{})).entries,[]);let current=await overview();
  const body={requestKey:randomUUID(),expectedRevision:current.revision,title:'QA: повтор наблюдения',summary:'Контролируемая проверка transport. Это сообщение устройства, не доказательство успешной задачи.',outcome:'unknown',evidence:[{kind:'observation',status:'unknown',summary:'Начат изолированный smoke.'}]};
  const result=await mcp.call('project_learning_record',body);experience=result.result.experience;assert.equal(experience.origin,'device');assert.equal(experience.device.deviceId,deviceId);
  assert.deepEqual((await mcp.call('project_learning_record',body)).result.experience,experience);
  await mcp.call('project_learning_record',{...body,title:'Изменённый повтор'},true);
  await mcp.call('project_learning_record',{...body,requestKey:randomUUID()},true);
  hypothesis=(await mcp.call('project_learning_propose_hypothesis',{requestKey:randomUUID(),expectedRevision:result.revision,subject:'project',title:'QA: идемпотентность',statement:'Повтор одного UUID может сохранять один опыт.',rationale:'Нужна настоящая проверка после потери ACK.',verificationPlan:'Повторить тот же payload после COMMIT и сверить PostgreSQL.',experienceIds:[experience.id]})).result.hypothesis;
  assert.equal(hypothesis.status,'open');assert.deepEqual((await mcp.call('project_learning_context',{})).entries,[]);
  assert.equal(Number((await own.query('SELECT count(*) AS n FROM project_learning_experiences WHERE project_id=$1',[projectId])).rows[0].n),1);
 });
 await check('Wrong binding, wrong instance, device approval and ordinary device writes denied',async()=>{
  const envelope={projectId,bindingId:binding.bindingId,instanceId:binding.instanceId};
  await channel('learning/context',{...envelope,bindingId:'f'.repeat(64)},{status:409});
  await channel('learning/context',{...envelope,instanceId:randomUUID()},{status:409});
  await channel('learning/approve',{...envelope,input:{}},{status:404});
  await request(learning()+'/experiences',{method:'POST',channel:true,body:{},status:403});
 });
 await check('Human review and candidate approval alone promote context; revoke removes it',async()=>{
  const checked=await mutation('/hypotheses/'+hypothesis.id+'/checks',{method:'human_review',result:'passed',summary:'QA: проверены происхождение и запись опыта. Это проверка transport, не качества реального проекта.',experienceIds:[experience.id]});
  candidate=(await mutation('/candidates',{hypothesisId:hypothesis.id,checkId:checked.result.check.id,key:'qa-transport-lesson',kind:'lesson',title:'QA: повторять тот же запрос',content:'После потери подтверждения повторять неизменный запрос с тем же UUID.'})).result.candidate;
  assert.deepEqual((await mcp.call('project_learning_context',{})).entries,[]);
  await mutation('/candidates/'+candidate.id+'/approve',{reason:'Одобрение в изолированном smoke.'});
  assert.equal((await mcp.call('project_learning_context',{})).entries[0].id,candidate.id);
  await mutation('/candidates/'+candidate.id+'/revoke',{reason:'Проверка отзыва.'});assert.deepEqual((await mcp.call('project_learning_context',{})).entries,[]);
 });
 await check('Managed collector delivered by real agent connect and classified by private proof',async()=>{
  const card=await post('/api/agents',{requestKey:randomUUID(),slug:'nc-qa-learning-'+runId,name:'QA сборщик опыта',definition:{description:'Изолированный QA агент',prompt:'Перед задачей прочитай project_learning_context. После задачи сообщи только наблюдаемые результаты.',mode:'subagent',permission:{read:'allow',edit:'deny',bash:'deny'}}});
  let view=await request('/api/agents?projectId='+projectId);
  await post('/api/projects/'+projectId+'/agents',{requestKey:randomUUID(),expectedRevision:view.revision,agentId:card.id,version:card.version,manifest:card.manifest});
  view=await request('/api/agents?projectId='+projectId);
  await request('/api/projects/'+projectId+'/agents/'+card.id,{method:'PATCH',body:{requestKey:randomUUID(),expectedRevision:view.revision,enabled:true}});
  view=await request('/api/agents?projectId='+projectId);
  const job=await post('/api/projects/'+projectId+'/agents/connect',{requestKey:randomUUID(),expectedRevision:view.revision,deviceId,expectedBindingId:binding.bindingId,expectedInstanceId:binding.instanceId});await waitJob(job.id);
  const file=path.join(project,'.opencode/plugins/neurocenter-learning.js'),source=await fs.readFile(file,'utf8');
  let inventory=await helper('inventory',{projectId});assert.equal(inventory.entries.find(item=>item.path==='.opencode/plugins/neurocenter-learning.js').reason,'managed-project-learning');
  await fs.appendFile(file,'\n// QA manual modification\n');inventory=await helper('inventory',{projectId});assert.equal(inventory.entries.find(item=>item.path==='.opencode/plugins/neurocenter-learning.js').state,'unmanaged');
  await fs.writeFile(file,source);report.resources.collectorSha256=hash(source);
 });
 await check('Collector redaction, real observe COMMIT, lost ACK and exact replay retain one row',async()=>{
  await stopChild(worker);worker=undefined;
  const target={projectId,bindingId:binding.bindingId,instanceId:binding.instanceId},queued=await helper('collect',{project,target,sessionId:'qa-'+runId});
  const saved=await fs.readFile(queued.file);await helper('lost-ack',{target});assert.deepEqual(await fs.readFile(queued.file),saved);
  assert.equal(Number((await own.query("SELECT count(*) AS n FROM project_learning_requests WHERE request_key=$1",[queued.input.requestKey])).rows[0].n),1);
  await helper('flush',{target});await assert.rejects(fs.stat(queued.file),error=>error.code==='ENOENT');
  const receipt=(await own.query('SELECT result FROM project_learning_requests WHERE request_key=$1',[queued.input.requestKey])).rows[0].result;
  const actual=receipt.result.experience;assert.equal(actual.outcome,'unknown');assert.equal(actual.origin,'device');assert.equal(actual.evidence[0].status,'unknown');
  assert.equal(Number((await own.query('SELECT count(*) AS n FROM project_learning_experiences WHERE project_id=$1',[projectId])).rows[0].n),2);
 });
 await check('Real committed ACK never deletes substituted queue payload; changed replay conflicts',async()=>{
  const input={requestKey:randomUUID(),title:'QA queue substitution',summary:'Original stable payload before real COMMIT.',outcome:'unknown',evidence:[{kind:'observation',status:'unknown',summary:'Controlled local file substitution fixture.'}]};
  const result=await helper('substituted-ack',{target:{projectId,bindingId:binding.bindingId,instanceId:binding.instanceId},input});
  report.substitutedAck=result;
  const receipt=(await own.query('SELECT result FROM project_learning_requests WHERE request_key=$1',[input.requestKey])).rows;
  assert.equal(receipt.length,1);assert.equal(receipt[0].result.result.experience.summary,input.summary);
  assert.equal(Number((await own.query('SELECT count(*) AS n FROM project_learning_experiences WHERE project_id=$1',[projectId])).rows[0].n),3);
 });
 await check('Valid A queue item copied into verified B binding is rejected before network',async()=>{
  emptyProject=await post('/api/projects',{name:'QA обучение: пустой проект '+runId});const folder='empty-'+runId;await fs.mkdir(path.join(projects,folder),{mode:0o700});await helper('report');
  worker=spawnLogged(node,[path.join(runtime,'dist/index.js'),'--worker'],env,project,path.join(output,'worker-binding-b.log'));children.push(worker);
  const job=await post('/api/device-jobs',{deviceId,projectId:emptyProject.id,kind:'bind-project',requestKey:randomUUID(),folderName:folder,bindingMode:'new'});await waitJob(job.id);
  const other=(await helper('report')).bindings.find(item=>item.projectId===emptyProject.id);assert.equal(other.valid,true);await stopChild(worker);worker=undefined;
  const input={requestKey:randomUUID(),title:'QA copied queue',summary:'Experience A must stay in A.',outcome:'unknown',evidence:[{kind:'observation',status:'unknown',summary:'Controlled cross-binding queue copy.'}]};
  report.copiedQueue=await helper('copied-binding',{source:{projectId,bindingId:binding.bindingId,instanceId:binding.instanceId},target:{projectId:emptyProject.id,bindingId:other.bindingId,instanceId:other.instanceId},input});
  assert.equal(Number((await own.query('SELECT count(*) AS n FROM project_learning_experiences WHERE project_id=$1',[emptyProject.id])).rows[0].n),0);
  const receipt=(await own.query('SELECT result FROM project_learning_requests WHERE request_key=$1',[input.requestKey])).rows[0].result;assert.equal(receipt.result.experience.projectId,projectId);
 });
 await check('Real observer and developer sessions/device pairs enforce project rights',async()=>{
  const member=await post('/api/projects/'+projectId+'/members',{principalName:email,role:'Наблюдатель',displayName:'QA роли проекта'});
  const envelope={projectId,bindingId:binding.bindingId,instanceId:binding.instanceId},workspace=await helper('report');
  for(const role of ['Наблюдатель','Разработчик']){
   if(role==='Разработчик')await request('/api/projects/'+projectId+'/members/'+encodeURIComponent(member.userId),{method:'PATCH',body:{role,expectedRole:'Наблюдатель'}});
   await post('/auth/switch-role',{role});const rights=(await overview()).capabilities;assert.equal(rights.approve,false);assert.equal(rights.record,role==='Разработчик');
   const token=randomBytes(32).toString('hex'),pair=await channel('pair/start',{name:'QA '+role+' '+runId,fingerprint:hash(runId+role),credentialHash:hash(token)},{token:null});
   await post('/api/device-pairs/'+pair.userCode+'/approve',{});const connected=await channel('pair/poll',{deviceCode:pair.deviceCode},{token:null});assert.equal(connected.state,'connected');
   // Same temporary computer reports its actual verified folder under a separately paired role.
   await channel('heartbeat',workspace,{token});await channel('learning/context',envelope,{token});
   const body={requestKey:randomUUID(),expectedRevision:(await overview()).revision,title:'QA права '+role,summary:'Reported role acceptance observation.',outcome:'unknown',evidence:[{kind:'observation',status:'unknown',summary:'No independent task success claim.'}]};
   if(role==='Наблюдатель'){
    await channel('learning/record',{...envelope,input:body},{token,status:403});
    await post(learning()+'/experiences',body,{status:403});
   }else{
    assert.equal((await channel('learning/record',{...envelope,input:body},{token})).result.experience.origin,'device');
    await post(learning()+'/candidates/'+candidate.id+'/activate',{requestKey:randomUUID(),expectedRevision:(await overview()).revision},{status:403});
   }
   await post('/auth/switch-role',{role:'Главный админ'});await request('/api/devices/'+connected.deviceId,{method:'DELETE'});
  }
  await request('/api/projects/'+projectId+'/members/'+encodeURIComponent(member.userId),{method:'PATCH',body:{role:'Наблюдатель',expectedRole:'Разработчик'}});
 });
 await check('Device expiring behind real project transaction lock cannot append experience',async()=>{
  const expiry=(await own.query('SELECT expires_at FROM bridge_devices WHERE id=$1',[deviceId])).rows[0].expires_at;
  const gate=await own.connect(),key=randomUUID();let response;
  try{
   await own.query("UPDATE bridge_devices SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",[deviceId]);
   await gate.query('BEGIN');await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:project-lifecycle:'||$1,0))",[projectId]);
   const pending=channel('learning/observe',{projectId,bindingId:binding.bindingId,instanceId:binding.instanceId,input:{requestKey:key,title:'QA expired',summary:'Must not commit after expiry.',outcome:'unknown',evidence:[{kind:'observation',status:'unknown',summary:'Expired device race fixture.'}]}},{status:401}).then(result=>({result}),error=>({error}));
   const deadline=Date.now()+2500;let waiting=false;
   while(Date.now()<deadline){waiting=(await own.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='neurocenter:learning' AND wait_event='advisory'")).rowCount>0;if(waiting)break;await pause(20);}
   assert.ok(waiting,'Real Catalog learning transaction must be waiting before credential expiry.');
   const expires=Date.now()+6000;let expired=false;
   while(Date.now()<expires){expired=(await own.query('SELECT expires_at<=clock_timestamp() AS expired FROM bridge_devices WHERE id=$1',[deviceId])).rows[0].expired;if(expired)break;await pause(25);}
   assert.ok(expired,'PostgreSQL clock must cross the own fixture credential expiry.');
   await gate.query('COMMIT');const settled=await pending;if(settled.error)throw settled.error;response=settled.result;
   assert.equal(Number((await own.query('SELECT count(*) AS n FROM project_learning_requests WHERE request_key=$1',[key])).rows[0].n),0);
  }finally{await gate.query('ROLLBACK').catch(()=>undefined);gate.release();await own.query('UPDATE bridge_devices SET expires_at=$2 WHERE id=$1',[deviceId,expiry]);}
  assert.ok(response);
 });
 let model,failureModel;
 await check('MOCK_LLM upstream connected and verified through real model APIs and assigned to project',async()=>{
  async function createModel(name,identifier){
   let card=await post('/api/models',{requestKey:randomUUID(),name,description:'Управляемый loopback fixture, не внешняя AI-модель.',capability:'chat',model:identifier,modelVersion:'fixture-v1',runtime:'remote-openai'});
   await request('/api/models/'+card.id+'/connection',{method:'PUT',body:{expectedRevision:0,expectedModelRevision:card.revision,baseUrl:urls.model+'/v1',requestDimensions:false,credential:'none'}});
   card=await request('/api/models/'+card.id);await post('/api/models/'+card.id+'/hosting',{action:'check',expectedRevision:card.revision});
   const deadline=Date.now()+30000;while(Date.now()<deadline){const status=await request('/api/models/'+card.id+'/hosting');if(status.state==='ready')break;if(status.state==='error')throw Error(JSON.stringify(status));await pause(200);}
   assert.equal((await request('/api/models/'+card.id+'/hosting')).state,'ready');await post('/api/projects/'+projectId+'/models',{modelId:card.id});return card;
  }
  model=await createModel('QA MOCK_LLM: гипотезы',modelFixture.model);failureModel=await createModel('QA MOCK_LLM: контролируемая ошибка',modelFixture.failureModel);
  report.resources.modelId=model.id;report.resources.failureModelId=failureModel.id;
 });
 await check('Real analysis jobs complete or fail without activating model-generated knowledge',async()=>{
  for(const [card,expected]of [[model,'completed'],[failureModel,'failed']]){
   const input={requestKey:randomUUID(),expectedRevision:(await overview()).revision,experienceIds:[experience.id],modelId:card.id};
   const job=await post(learning()+'/analyses',input);assert.equal((await post(learning()+'/analyses',input)).id,job.id);
   const deadline=Date.now()+30000;let state=job;while(Date.now()<deadline){state=await request(learning()+'/analyses/'+job.id);if(['completed','failed','unknown'].includes(state.state))break;await pause(100);}
   assert.equal(state.state,expected,JSON.stringify(state));assert.equal((await request(learning()+'/analyses/requests/'+input.requestKey)).id,job.id);
   if(expected==='completed'){assert.equal(state.hypothesisIds.length,1);const created=await request(learning()+'/hypotheses/'+state.hypothesisIds[0]);assert.equal(created.origin,'llm');assert.equal(created.status,'open');}
   else assert.equal(state.error.code,'MODEL_FAILED');
   assert.deepEqual((await mcp.call('project_learning_context',{})).entries,[]);
  }
  await post('/api/projects/'+emptyProject.id+'/members',{principalName:email,role:'Наблюдатель'});
  const empty=await request('/api/projects/'+emptyProject.id+'/learning');assert.deepEqual(empty.experiences,[]);assert.equal(empty.revision,0);
 });
 if(process.env.LEARNING_QA_BROWSER_GATE==='1'){
  const release=path.join(output,'browser.release'),context={runId,base:urls.frontend,gateway:urls.gateway,projectId,projectName:'QA обучение '+runId,
   learningUrl:urls.frontend+'/projects/'+projectId+'?tab=learning',loginUrl:urls.frontend+'/auth/login?returnTo='+encodeURIComponent('/projects/'+projectId+'?tab=learning'),
   actor:{email,role:'Главный админ',roles:['Главный админ','Наблюдатель']},modelId:model.id,modelName:model.name,modelIsMock:true,experienceId:experience.id,hypothesisId:hypothesis.id,candidateId:candidate.id,
   failureModelId:failureModel.id,failureModelName:failureModel.name,emptyProjectId:emptyProject.id,
   output,release,expiresAt:new Date(Date.now()+browserTimeout).toISOString()};
  await fs.writeFile(path.join(output,'browser.context.json'),JSON.stringify(context,null,2)+'\n',{mode:0o600});console.log('BROWSER_GATE '+JSON.stringify(context));report.browserGate=context;
  const deadline=Date.now()+browserTimeout;while(Date.now()<deadline){interrupted.signal.throwIfAborted();if(await fs.stat(release).catch(()=>undefined))break;await pause(300);}
  assert.ok(await fs.stat(release).catch(()=>undefined),'Browser QA timed out; cleanup will run.');
 }
}catch(error){fatal=error instanceof Error?error.stack:String(error);console.error(fatal);process.exitCode=1;}
finally{
 const clean=async(name,action)=>{try{await action();report.cleanup.push({name,ok:true});}catch(error){report.cleanup.push({name,ok:false,error:String(error.message||error)});process.exitCode=1;}};
 await clean('Close real MCP transport',async()=>{await mcp?.close();});
 for(const child of children.reverse())await clean('Stop only owned QA process '+child.pid,()=>stopChild(child));
 await clean('Stop MOCK_LLM upstream',async()=>{await modelFixture?.close();});
 for(const reservation of Object.values(reservations))await reservation.release().catch(()=>undefined);
 await clean('Close own DB clients',()=>own.end());
 if(dbOid)await clean('Drop only own disposable database after exact OID check',async()=>{
  const current=(await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1',[database])).rows[0];assert.equal(current?.oid,dbOid);
  const rows=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[database])).rows;for(const {pid}of rows)await admin.query('SELECT pg_terminate_backend($1)',[pid]);
  await admin.query('DROP DATABASE "'+database+'"');assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0);
 });
 await clean('Close own PostgreSQL administration client',()=>admin.end());
 if(proof)await clean('Verify24 original database OIDs and registries preserved',async()=>{
  const after=await proof.compare();report.databasesAfter=after;assert.deepEqual(after.missing,[]);assert.deepEqual(after.originalDatabaseOids,before.originalDatabaseOids);assert.deepEqual(after.oldState,before.oldState);
 });
 await proof?.close();await clean('Remove only temporary HOME and bridge profile',()=>fs.rm(temporary,{recursive:true,force:true}));
 report.finishedAt=new Date().toISOString();report.success=!fatal&&report.cleanup.every(item=>item.ok);report.error=fatal;
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log('REPORT '+path.join(output,'report.json'));
}
