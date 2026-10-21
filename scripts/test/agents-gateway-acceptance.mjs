import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyBridgeBuild} from '../bridge-build-integrity.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
if(!args.includes('--execute')){
 console.log('Prepare only: no HTTP requests, files or server resources were created.');
 console.log('After activation: node scripts/test/agents-gateway-acceptance.mjs --execute');
 console.log('Optional env: AGENT_ACCEPTANCE_URL=http://localhost:5173, AGENT_ACCEPTANCE_ARCHIVE=<0.9.15.tgz>, BRIDGE_EXPECTED_BUILD_ID=<verified SHA>, AGENT_ACCEPTANCE_REPORT=<report.json>.');
 console.log('Requires localhost Gateway, a dev login creating its own main-admin session, migrations0..7 and compiled runtime0.9.15 with pinned OpenCode1.14.48.');
 process.exit(0);
}
assert.deepEqual(args,['--execute']);
const url=new URL(process.env.AGENT_ACCEPTANCE_URL||'http://localhost:5173');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&['http:','https:'].includes(url.protocol));
assert.equal(url.pathname,'/');assert.equal(url.username+url.password+url.search+url.hash,'');
const base=url.origin,runId=randomUUID().replaceAll('-','').slice(0,12),prefix='QA агенты '+runId;
const target=process.platform+'-'+process.arch,archive=path.resolve(process.env.AGENT_ACCEPTANCE_ARCHIVE||path.join(repo,'bridge-dist/runtime',`neurocenter-asset-sync-${target}-0.9.15.tgz`));
const reportFile=path.resolve(process.env.AGENT_ACCEPTANCE_REPORT||path.join(repo,'.run/agent-acceptance',runId+'.json'));
const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-gateway-agents-'))),home=path.join(temporary,'home'),content=path.join(temporary,'runtime'),root=path.join(temporary,'projects'),project=path.join(root,'qa-'+runId);
for(const folder of [home,content,project])await fs.mkdir(folder,{recursive:true,mode:0o700});
const execute=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex'),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const record={runId,base,startedAt:new Date().toISOString(),cases:[],http:[],native:[],cleanup:[],resources:{},temporaryProfileRemoved:false,realProfileChanged:false,ragRequests:0};
const env={PATH:process.env.PATH,LANG:'C.UTF-8',TMPDIR:temporary,HOME:home,USERPROFILE:home,
 XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),
 NEUROCENTER_URL:base,NEUROCENTER_BRIDGE_HOME:path.join(temporary,'private'),OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true'};
let panelOrigin=base,session='',worker,node,entry,engine,contract,metadata,card,projectId,deviceId,deviceToken,binding,revision=0,workerLog='';
const ownedJobs=new Set();
async function request(route,{method='GET',body,channel=false,token,expectStatus}={}){
 assert.ok(!route.startsWith('/api/rag'));const headers={'content-type':'application/json','x-neurocenter-request':'1',origin:panelOrigin};
 if(!channel&&session)headers.cookie=session;if(token)headers.authorization='Bearer '+token;
 const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(30000)});
 const raw=await response.text();let result;try{result=raw?JSON.parse(raw):null;}catch{result=null;}
 record.http.push({method,route,status:response.status,at:new Date().toISOString()});
 if(expectStatus!==undefined)assert.equal(response.status,expectStatus,method+' '+route);else if(!response.ok)throw Object.assign(new Error(method+' '+route+' returned '+response.status+': '+String(result?.message||result?.error||'').slice(0,300)),{status:response.status});
 return result;
}
const post=(route,body,extra={})=>request(route,{method:'POST',body,...extra});
const channel=(route,body={},token=deviceToken)=>post('/api/device-channel/'+route,body,{channel:true,token});
async function check(name,work){await work();record.cases.push({name,at:new Date().toISOString()});console.log('OK '+name);}
async function helper(mode,input={}){
 const child=spawn(node,[path.join(repo,'scripts/test/agents-gateway-bridge.fixture.mjs'),mode,content],{cwd:content,env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdin.end(JSON.stringify(input));
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(exit,0,stderr.slice(-3000));return JSON.parse(stdout);
}
function startWorker(){
 assert.ok(!worker);worker=spawn(node,[entry,'--worker'],{cwd:content,env,stdio:['ignore','ignore','pipe']});worker.stderr.on('data',chunk=>{workerLog=(workerLog+chunk).slice(-32000);});
}
async function stopWorker(){
 if(!worker)return;const current=worker;worker=undefined;if(current.exitCode!==null)return;
 const exited=new Promise(resolve=>current.once('exit',resolve));current.kill('SIGTERM');let timer;
 await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{current.kill('SIGKILL');resolve();},5000);})]);clearTimeout(timer);await exited;
}
async function waitJob(id){
 ownedJobs.add(id);const deadline=Date.now()+90000;
 while(Date.now()<deadline){const job=(await request('/api/device-jobs')).find(item=>item.id===id);if(job&&['succeeded','failed','cancelled'].includes(job.state)){assert.equal(job.state,'succeeded',JSON.stringify({id,state:job.state,message:job.message}));return job;}
  if(worker?.exitCode!==null&&worker?.exitCode!==undefined)throw Error('Isolated worker exited: '+workerLog.slice(-2000));await pause(250);}
 throw Error('Timed out waiting for own QA job '+id);
}
async function view(){const result=await request('/api/agents?projectId='+projectId);revision=result.revision;return result;}
async function patch(body,expectedRevision=revision){const result=await request(`/api/projects/${projectId}/agents/${card.id}`,{method:'PATCH',body:{requestKey:randomUUID(),expectedRevision,...body}});revision=result.revision;return result;}
async function assign(){const result=await post(`/api/projects/${projectId}/agents`,{requestKey:randomUUID(),expectedRevision:revision,agentId:card.id,version:card.version,manifest:card.manifest});revision=result.revision;return result;}
async function remove(){const result=await request(`/api/projects/${projectId}/agents/${card.id}`,{method:'DELETE',body:{requestKey:randomUUID(),expectedRevision:revision}});revision=result.revision;return result;}
function connectBody(requestKey=randomUUID()){return {requestKey,expectedRevision:revision,deviceId,expectedBindingId:binding.bindingId,expectedInstanceId:binding.instanceId};}
async function connect(body=connectBody()){const job=await post(`/api/projects/${projectId}/agents/connect`,body);ownedJobs.add(job.id);return job;}
async function applied(body){const job=await connect(body);await waitJob(job.id);const current=await view(),delivery=current.deliveries.find(item=>item.deviceId===deviceId&&item.bindingId===binding.bindingId&&item.instanceId===binding.instanceId);
 assert.equal(delivery.jobId,job.id);assert.equal(delivery.revision,current.revision);assert.equal(delivery.state,'succeeded');assert.equal(delivery.result.revision,current.revision);assert.equal(delivery.result.manifestSha256,delivery.manifestSha256);assert.equal(delivery.result.bindingId,binding.bindingId);assert.equal(delivery.result.instanceId,binding.instanceId);assert.equal(delivery.result.readiness,'configured');return {job,view:current};}
async function native(enabled,prompt){
 const list=(await execute(engine,['agent','list'],{cwd:project,env,timeout:30000,maxBuffer:2*1024*1024})).stdout;
 assert.equal(list.includes(card.slug+' (subagent)'),enabled);assert.ok(list.includes('manual (subagent)'));
 const config=JSON.parse((await execute(engine,['debug','config'],{cwd:project,env,timeout:30000,maxBuffer:2*1024*1024})).stdout);
 if(prompt===null){assert.equal(config.agent[card.slug],undefined);await assert.rejects(fs.stat(path.join(project,'.opencode/agents',card.slug+'.md')),error=>error.code==='ENOENT');}
 else{assert.equal(config.agent[card.slug].prompt,prompt);assert.equal(config.agent[card.slug].disable,!enabled);}
 record.native.push({revision,enabled,promptSha256:prompt===null?null:hash(prompt),list,at:new Date().toISOString()});
}
async function archiveCard(){
 const current=await request('/api/agents/'+card.id);assert.equal(current.slug,'nc-qa-'+runId);if(current.archivedAt)return;
 const impact=await post('/api/asset-management/impact',{kind:'agent',id:card.id});const operation=await post('/api/asset-management/archive',{impactId:impact.impactId,expectedDigest:impact.digest,mode:'catalog-only'});assert.equal(operation.state,'SUCCEEDED');
}
let fatal;
try{
 await check('Verified compiled bridge0.9.15 and pinned native engine, isolated profiles',async()=>{
  const archiveMetadata=JSON.parse(await fs.readFile(archive+'.json','utf8'));assert.equal(archiveMetadata.version,'0.9.15');assert.equal(hash(await fs.readFile(archive)),archiveMetadata.sha256);
  await execute('tar',['-xzf',archive,'-C',content]);metadata=JSON.parse(await fs.readFile(path.join(content,'runtime.json'),'utf8'));assert.equal(metadata.version,'0.9.15');
  const verified=await verifyBridgeBuild(path.join(content,'dist'),'0.9.15');assert.equal(verified.buildId,archiveMetadata.buildId);if(process.env.BRIDGE_EXPECTED_BUILD_ID)assert.equal(verified.buildId,process.env.BRIDGE_EXPECTED_BUILD_ID);
  node=path.join(content,'bin',process.platform==='win32'?'node.exe':'node');entry=path.join(content,'dist/index.js');engine=path.join(content,metadata.probeEngine.file);assert.equal(hash(await fs.readFile(engine)),metadata.probeEngine.sha256);
  assert.equal((await execute(engine,['--version'],{env,timeout:30000})).stdout.trim(),'1.14.48');contract=await import(pathToFileURL(path.join(content,'dist/features/project-agents/contract.js')).href);
  record.runtime={version:metadata.version,buildId:verified.buildId,engineVersion:metadata.probeEngine.version,engineSha256:metadata.probeEngine.sha256};
 });
 await check('Real Gateway access policy allows main-admin agent reads with a separate session',async()=>{
  const response=await fetch(base+'/auth/login?returnTo=/start',{redirect:'manual',signal:AbortSignal.timeout(15000)});const location=new URL(response.headers.get('location')||base,base);assert.ok(['localhost','127.0.0.1','[::1]'].includes(location.hostname));panelOrigin=location.origin;await response.body?.cancel();const cookie=response.headers.getSetCookie().find(item=>item.startsWith('bridge_session='));assert.ok(cookie,'Requires SSO-disabled localhost dev login; refusing to reuse or alter the user session.');session=cookie.split(';')[0];
  const user=await request('/auth/me');assert.equal(user.user.activeRole,'Главный админ');record.actor={email:user.user.email,role:user.user.activeRole};
  await request('/api/agents');await request('/api/agents',{method:'HEAD'});await request('/api/agents/agent-qa%2funknown',{expectStatus:403});
 });
 await check('Gateway common create/read/edit CAS keeps immutable project pins',async()=>{
  const created=await post('/api/projects',{name:prefix});projectId=created.id;assert.match(projectId,/^prj-/);record.resources.projectId=projectId;
  card=await post('/api/agents',{requestKey:randomUUID(),slug:'nc-qa-'+runId,name:prefix,definition:{description:'Isolated Gateway acceptance agent',prompt:'QA original template '+runId,mode:'subagent',permission:{read:'allow',edit:'deny',bash:'ask'}}});record.resources.agentId=card.id;
  assert.equal((await request('/api/agents/'+card.id)).manifest,card.manifest);await request('/api/agents/'+card.id,{method:'HEAD'});
  card=await request('/api/agents/'+card.id,{method:'PATCH',body:{requestKey:randomUUID(),expectedVersion:card.version,name:prefix+' updated'}});assert.equal(card.version,2);
  await request('/api/agents/'+card.id,{method:'PATCH',expectStatus:409,body:{requestKey:randomUUID(),expectedVersion:1,name:'Stale QA editor'}});
  await assign();assert.equal((await view()).assignments[0].enabled,false);
 });
 await check('Own temporary computer pairs and binds through real Gateway jobs',async()=>{
  deviceToken=randomBytes(32).toString('hex');const pair=await channel('pair/start',{name:prefix,fingerprint:hash(runId),credentialHash:hash(deviceToken)},null);
  const info=await request('/api/device-pairs/'+pair.userCode);assert.equal(info.fingerprint,hash(runId));await post('/api/device-pairs/'+pair.userCode+'/approve',{});
  const connected=await channel('pair/poll',{deviceCode:pair.deviceCode},null);assert.equal(connected.state,'connected');deviceId=connected.deviceId;record.resources.deviceId=deviceId;
  await helper('bootstrap',{root,credentials:{token:deviceToken,deviceId,email:connected.email}});startWorker();
  const job=await post('/api/device-jobs',{deviceId,projectId,kind:'bind-project',requestKey:randomUUID(),folderName:path.basename(project),bindingMode:'new'});await waitJob(job.id);
  const report=await helper('report');binding=report.bindings.find(item=>item.projectId===projectId);assert.equal(binding.valid,true);assert.match(binding.bindingId,/^[a-f0-9]{64}$/);assert.match(binding.instanceId,/^[a-f0-9-]{36}$/);assert.ok(report.capabilities.includes('project-agents-v1'));record.resources.binding={...binding};
  await fs.mkdir(path.join(project,'.opencode/agents'),{recursive:true});await fs.writeFile(path.join(project,'.opencode/agents/manual.md'),'---\ndescription: User-owned QA agent\nmode: subagent\n---\nPreserve this manual agent.\n');
 });
 await check('Offline queue is not confirmed; restarted compiled worker applies exact override and ACK',async()=>{
  await stopWorker();await patch({enabled:true,overrides:{prompt:'QA project override '+runId}});const body=connectBody(),job=await connect(body),offline=await view();
  assert.equal(offline.deliveries.find(item=>item.jobId===job.id).state,'queued');await assert.rejects(fs.stat(path.join(project,'.opencode/agents',card.slug+'.md')),error=>error.code==='ENOENT');
  await request(`/api/projects/${projectId}/agents/${card.id}`,{method:'PATCH',expectStatus:409,body:{requestKey:randomUUID(),expectedRevision:0,enabled:false}});
  startWorker();await waitJob(job.id);const current=await view(),delivery=current.deliveries.find(item=>item.jobId===job.id);assert.equal(delivery.state,'succeeded');assert.equal(delivery.revision,revision);contract.validateProjectAgentsResult(delivery.result,contract.createProjectAgentsPayload({schemaVersion:1,projectId,bindingId:binding.bindingId,instanceId:binding.instanceId,revision,agents:current.assignments.filter(item=>!item.removed).map(item=>({id:item.agentId,slug:item.card.slug,version:item.version,enabled:item.enabled,...item.effective}))}));
  assert.equal((await connect(body)).id,job.id);await native(true,'QA project override '+runId);
 });
 await check('Reset, disable and re-enable are native OpenCode states after exact target delivery',async()=>{
  await patch({overrides:{}});await applied();await native(true,'QA original template '+runId);
  await patch({enabled:false});await applied();await native(false,'QA original template '+runId);
  await patch({enabled:true});await applied();await native(true,'QA original template '+runId);
 });
 await check('Global prompt update leaves project pin unchanged until explicit repin',async()=>{
  const previous=card.version;card=await request('/api/agents/'+card.id,{method:'PATCH',body:{requestKey:randomUUID(),expectedVersion:card.version,definition:{...card.definition,prompt:'QA new global template '+runId}}});const current=await view();assert.equal(current.assignments[0].version,previous);assert.equal(current.assignments[0].effective.prompt,'QA original template '+runId);
  await patch({version:card.version,manifest:card.manifest});await applied();await native(true,'QA new global template '+runId);
 });
 await check('Project removal deletes only managed file; re-add preserves overrides disabled until explicit enable',async()=>{
  await patch({overrides:{prompt:'QA retained override '+runId}});await applied();await remove();await applied();await native(false,null);
  const saved=await assign();assert.equal(saved.assignment.enabled,false);assert.equal(saved.assignment.effective.prompt,'QA retained override '+runId);await applied();await native(false,'QA retained override '+runId);
  await patch({enabled:true});await applied();await native(true,'QA retained override '+runId);
 });
 await check('Main-admin catalog-only archive preserves the exact project configuration',async()=>{
  await archiveCard();assert.ok((await request('/api/agents/'+card.id)).archivedAt);const current=await view();assert.equal(current.assignments[0].removed,false);assert.equal(current.assignments[0].version,card.version);assert.equal(current.assignments[0].effective.prompt,'QA retained override '+runId);
  await remove();await applied();await native(false,null);await assert.rejects(fs.stat(path.join(project,'.opencode/rag_db')),error=>error.code==='ENOENT');
 });
}catch(error){fatal=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{
 // Cleanup uses only resources created in this run; durable history and archived immutable QA versions intentionally remain.
 const clean=async(name,work)=>{try{await work();record.cleanup.push({name,ok:true});}catch(error){record.cleanup.push({name,ok:false,error:String(error.message||error)});process.exitCode=1;}};
 if(projectId&&card&&binding&&deviceId)await clean('Deliver removal of own QA agent files',async()=>{await view();const assignment=(await view()).assignments.find(item=>item.agentId===card.id);if(assignment&&!assignment.removed)await remove();if(!worker)startWorker();await applied();await native(false,null);});
 if(deviceId)await clean('Cancel only own queued QA jobs',async()=>{const rows=await request('/api/device-jobs');for(const job of rows.filter(item=>item.deviceId===deviceId&&item.projectId===projectId&&item.state==='queued'))await request('/api/device-jobs/'+job.id,{method:'DELETE'});});
 await stopWorker();
 if(deviceId)await clean('Revoke own temporary QA device',async()=>{await request('/api/devices/'+deviceId,{method:'DELETE'});await request('/api/device-channel/identity',{method:'POST',channel:true,token:deviceToken,body:{},expectStatus:401});});
 if(card)await clean('Archive only own QA catalog card',archiveCard);
 if(projectId)await clean('Retire only own QA project without leaving pending RAG data',async()=>{const own=await request('/api/projects/'+projectId);assert.equal(own.name,prefix);await request('/api/projects/'+projectId,{method:'DELETE'});await request('/api/projects/'+projectId,{expectStatus:404});});
 if(session)await clean('Close only the separate acceptance session',async()=>{await fetch(base+'/auth/logout',{headers:{cookie:session,'x-neurocenter-request':'1',origin:panelOrigin},redirect:'manual',signal:AbortSignal.timeout(15000)});});
 record.fatal=fatal||null;record.finishedAt=new Date().toISOString();record.workerLog=workerLog;
 if(record.cleanup.every(item=>item.ok)){await fs.rm(temporary,{recursive:true,force:true});record.temporaryProfileRemoved=true;}else record.retainedRecoveryDirectory=temporary;
 await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(record,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({reportFile,cases:record.cases.length,passed:!fatal&&record.cleanup.every(item=>item.ok),cleanup:record.cleanup,temporaryProfileRemoved:record.temporaryProfileRemoved}));
}
