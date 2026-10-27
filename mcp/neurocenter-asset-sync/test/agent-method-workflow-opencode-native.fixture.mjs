import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parse} from 'jsonc-parser';
import {setRoot,bindProject,projectBindingId,projectInstanceId} from '../src/bridge/workspace.ts';
import {writeState} from '../src/bridge/state.ts';
import {runAgentMethodWorkflow} from '../src/features/agent-method-workflow/executor.ts';
import {methodDeliveryResult,recoverMethodCompletions,acknowledgeMethodReceipt} from '../src/features/agent-method-workflow/receipts.ts';

// Explicit native acceptance: all method/agent processes use an owned HOME and an HTTP model fixture.
const [engine,installedAdapter,openspec,ripgrep,verifySkill,output]=process.argv.slice(2).map(value=>path.resolve(value));
assert.ok(engine&&installedAdapter&&openspec&&ripgrep&&verifySkill&&output,'Provide pinned engine, installed adapter, OpenSpec CLI, rg, verify SKILL.md and evidence output.');
const diagnosticMode=process.env.NEUROCENTER_METHOD_DIAGNOSTIC_ONLY;
const diagnosticOnly=['1','run','http'].includes(diagnosticMode);
const execute=promisify(execFile),temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-method-native-')));
const home=path.join(temporary,'home'),project=path.join(temporary,'Проекты 日本 мой проект'),bin=path.join(temporary,'bin');
const provider='neurocenter-ollama-'+'a'.repeat(16),model='owned-method-fixture',projectId='prj-native-method',deviceId=randomUUID();
const change='native-method-file',taskFile='openspec/changes/'+change+'/tasks.md';
let round=0,registryRequests=0,fixtureError;const locked=[];const evidence={ok:false,realModelUsed:false,realProfileChanged:false,ownedProjectName:path.basename(project),engineVersion:'1.14.48',methodVersion:'1.15.0'};
const reply=message=>({model,created_at:new Date().toISOString(),done:true,done_reason:'stop',message:{role:'assistant',content:'',...message},prompt_eval_count:20,eval_count:10});
const server=http.createServer((req,res)=>{void(async()=>{
 if(req.url!=='/prefix/api/chat'){registryRequests++;res.writeHead(503);res.end();return;}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 assert.equal(body.model,model);assert.ok(body.tools.some(tool=>tool.function.name==='read'));assert.ok(body.tools.some(tool=>tool.function.name==='write'));
 res.writeHead(200,{'content-type':'application/x-ndjson'});
 if(round++===0){res.end(JSON.stringify(reply({tool_calls:[
  {id:'read-owned-code',function:{name:'read',arguments:{filePath:path.join(project,'app.js')}}},
  {id:'read-owned-tasks',function:{name:'read',arguments:{filePath:path.join(project,taskFile)}}},
 ]}))+'\n');return;}
 if(round===2){
  assert.ok(body.messages.some(message=>message.role==='tool'&&String(message.content).includes('OWNED_NATIVE_ORIGINAL')));
  res.end(JSON.stringify(reply({tool_calls:[
   {id:'write-owned-code',function:{name:'write',arguments:{filePath:path.join(project,'app.js'),content:'export const value = "OWNED_NATIVE_IMPLEMENTED";\n'}}},
   {id:'write-owned-tasks',function:{name:'write',arguments:{filePath:path.join(project,taskFile),content:'## Implementation\n\n- [x] Change the owned QA file.\n'}}},
  ]}))+'\n');return;
 }
 assert.equal(round,3,'The native fixture must not cause an unbounded agent loop.');
 assert.ok(body.messages.some(message=>message.role==='tool'&&/success|written|wrote/i.test(String(message.content))));
 res.end(JSON.stringify(reply({content:'The owned implementation and change task are complete. The bridge performs final independent checks.'}))+'\n');
})().catch(error=>{fixtureError=error;if(!res.headersSent)res.writeHead(500);res.end();});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
try{
 await fs.mkdir(home);await fs.mkdir(project);await fs.mkdir(bin);
 for(const [name,source]of [['opencode',engine],['openspec',openspec],['rg',ripgrep]])await fs.symlink(source,path.join(bin,name));
 const env={HOME:home,USERPROFILE:home,PATH:bin+path.delimiter+path.dirname(process.execPath)+path.delimiter+'/usr/bin:/bin',LANG:'C.UTF-8',TERM:'dumb',NO_COLOR:'1',
  XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),
  OPENCODE_MODELS_PATH:path.join(home,'models.json'),OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_TEST_MANAGED_CONFIG_DIR:path.join(temporary,'managed'),
  OPENSPEC_TELEMETRY:'0',OPENSPEC_NO_UPDATE_CHECK:'1',NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_REGISTRY:origin+'/registry',npm_config_registry:origin+'/registry'};
 await fs.writeFile(env.OPENCODE_MODELS_PATH,'{}');
 assert.equal((await execute(engine,['--version'],{env,cwd:project})).stdout.trim(),'1.14.48');
 assert.equal((await execute(openspec,['--version'],{env,cwd:project})).stdout.trim(),'1.15.0');
 await execute(openspec,['init',project,'--tools','opencode','--language','Russian','--no-animation','--no-copilot-cloud'],{env,cwd:project});
 // Core OpenSpec installation omits verify; this fixture explicitly adds the locally installed official verify workflow.
 const verifyDirectory=path.join(project,'.opencode/skills/openspec-verify-change');await fs.mkdir(verifyDirectory,{recursive:true});await fs.copyFile(verifySkill,path.join(verifyDirectory,'SKILL.md'));
 await execute(openspec,['new','change',change],{env,cwd:project});const changeDirectory=path.join(project,'openspec/changes',change);
 await fs.writeFile(path.join(changeDirectory,'proposal.md'),'## Why\n\nOwned native acceptance.\n\n## What Changes\n\nUpdate the owned QA file.\n\n## Capabilities\n\n### New Capabilities\n\n- `native-file`: An owned file can be changed.\n\n## Impact\n\nOnly the QA file.\n');
 await fs.writeFile(path.join(changeDirectory,'design.md'),'## Context\n\nOwned native acceptance.\n\n## Decisions\n\nChange the selected file.\n');
 await fs.writeFile(path.join(project,taskFile),'## Implementation\n\n- [ ] Change the owned QA file.\n');
 await fs.mkdir(path.join(changeDirectory,'specs/native-file'),{recursive:true});await fs.writeFile(path.join(changeDirectory,'specs/native-file/spec.md'),'## ADDED Requirements\n\n### Requirement: Owned native file\nThe application SHALL contain the requested QA implementation.\n\n#### Scenario: Read owned QA file\n- **WHEN** the local check reads the file\n- **THEN** its content matches the requested implementation\n');
 await fs.writeFile(path.join(project,'app.js'),'export const value = "OWNED_NATIVE_ORIGINAL";\n');
 await fs.writeFile(path.join(project,'check.cjs'),`if(!require('node:fs').readFileSync('app.js','utf8').includes('OWNED_NATIVE_IMPLEMENTED'))process.exit(7);`);
 await fs.writeFile(path.join(project,'.gitignore'),'.opencode/node_modules/\n');await execute('git',['init','--quiet'],{env,cwd:project});
 const config=path.join(home,'config/opencode');await fs.mkdir(config,{recursive:true});
 for(const directory of [config,path.join(project,'.opencode')]){
  const dependency={'@opencode-ai/plugin':'1.14.48'};await fs.mkdir(path.join(directory,'node_modules'),{recursive:true});
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({private:true,dependencies:dependency}));
  await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:dependency}}}));
 }
 await fs.writeFile(path.join(home,'.bunfig.toml'),'telemetry = false\nenv = false\n[install]\nauto = "disable"\n');
 await fs.writeFile(path.join(project,'bunfig.toml'),'telemetry = false\nenv = false\n[install]\nauto = "disable"\n');
 for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env,{NEUROCENTER_URL:'https://native-method.example.test',NEUROCENTER_BRIDGE_HOME:path.join(temporary,'bridge-private')});
 await setRoot(temporary);await bindProject(projectId,path.basename(project));await writeState('credentials',{deviceId,token:'OWNED_METHOD_FIXTURE',email:'owned@example.test'});
 const bindingId=await projectBindingId(projectId),instanceId=await projectInstanceId(projectId);
 const moduleUrl=pathToFileURL(installedAdapter),load=relative=>import(new URL(relative,moduleUrl).href);
 const {providerContext}=await load('./context.js'),{saveProvider}=await load('./engine.js');
 await fs.writeFile(path.join(config,'opencode.json'),JSON.stringify({$schema:'https://opencode.ai/config.json',mcp:{},plugin:[],enabled_providers:[provider],lsp:false,formatter:false,autoupdate:false,snapshot:false,share:'disabled',permission:{read:'allow',write:'allow',edit:'allow',bash:'allow',external_directory:'deny'}}));
 const context=await providerContext({schemaVersion:1,deviceId,projectId,bindingId,instanceId,providerId:provider,providerKind:'ollama',schemaDigest:'b'.repeat(64),connector:null,
  expectations:{catalogModelId:'model-native-method',modelPin:'c'.repeat(64),runtimeModel:model,capability:'chat',baseUrl:origin+'/prefix',options:{temperature:0,topP:1,maxOutputTokens:1024,contextWindow:65536}}},async()=>{});
 await saveProvider(context,undefined,null,async()=>{});
 const {projectAgentMappings}=await load('../project-agents/model-compiler.js'),{configureProjectAgents}=await load('../project-agents/index.js');
 const {createProjectAgentsPayload,compileProjectAgents}=await load('../project-agents/contract.js');
 const agent={id:'agent-native-method',slug:'nc-native-method',version:1,enabled:true,description:'Owned native method acceptance',prompt:'Implement the accepted owned task.',mode:'primary',permission:{read:'allow',edit:'allow',bash:'allow'},model:'neurocenter/model-native-method'};
 const agents=createProjectAgentsPayload({schemaVersion:2,projectId,bindingId,instanceId,revision:1,agents:[agent],modelRequirements:[{kind:'catalog',agentId:agent.id,catalogModelId:'model-native-method',modelPin:'c'.repeat(64),runtime:'remote-ollama',runtimeModel:model,baseUrl:origin+'/prefix',options:{temperature:0,topP:1,maxOutputTokens:1024,contextWindow:65536},capability:'chat'}]});
 const mappings=await projectAgentMappings(agents,project,async()=>{});await configureProjectAgents(agents,async()=>{},async()=>{},async value=>compileProjectAgents(agents,value));
 let projectConfigPath;for(const relative of ['opencode.json','opencode.jsonc','.opencode/opencode.json','.opencode/opencode.jsonc']){const candidate=path.join(project,relative);try{await fs.access(candidate);projectConfigPath=candidate;break;}catch{}}
 assert.ok(projectConfigPath,'Prepared provider configuration must exist in the owned project');
 const projectConfig=parse(await fs.readFile(projectConfigPath,'utf8'));
 assert.ok(mappings[0]?.configKey,'Owned fixture must have an explicitly compiled model mapping');
 projectConfig.$schema='https://opencode.ai/config.json';projectConfig.model=provider+'/'+mappings[0].configKey;await fs.writeFile(projectConfigPath,JSON.stringify(projectConfig));
 process.env.OPENCODE_CONFIG_CONTENT=JSON.stringify({...projectConfig,model:projectConfig.model});
 await fs.mkdir(path.join(project,'.opencode/neurocenter'),{recursive:true});
 for(const directory of [config,path.join(config,'node_modules'),path.join(project,'.opencode'),path.join(project,'.opencode/node_modules')]){await fs.chmod(directory,0o500);locked.push(directory);}
 if(diagnosticOnly){
  // Bun's debug command can exit before a large pipe write drains. A private regular file preserves complete JSON.
  const debugFile=path.join(temporary,'effective-config.json'),handle=await fs.open(debugFile,'wx',0o600);
  try{await new Promise((resolve,reject)=>{
   const child=spawn(engine,['debug','config'],{env:process.env,cwd:project,stdio:['ignore',handle.fd,'ignore']});
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Owned effective config timed out.'));},15000);
   child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Owned effective config failed.'));});
  });}finally{await handle.close();}
  const effective=JSON.parse(await fs.readFile(debugFile,'utf8'));
  evidence.diagnosticOnly=true;evidence.effective={model:effective.model,defaultAgent:effective.default_agent,
   providers:Object.entries(effective.provider??{}).map(([id,value])=>({id,npm:value.npm,models:Object.keys(value.models??{})}))};
  if(diagnosticMode==='run'){
   try{const pending=execute(engine,['run','--format','json','--dir',project,'--agent',agent.slug,'Read app.js and the accepted change tasks. Implement the owned QA task, then return DONE.'],{env:process.env,cwd:project,timeout:30000,killSignal:'SIGKILL',maxBuffer:1024*1024});pending.child.stdin.end();const result=await pending;
    evidence.directRun={code:0,stdout:result.stdout.slice(-24000).replaceAll(temporary,'[owned-temp]'),stderr:result.stderr.slice(-4000).replaceAll(temporary,'[owned-temp]')};
   }catch(error){evidence.directRun={code:error.code,signal:error.signal,stdout:String(error.stdout??'').slice(-24000).replaceAll(temporary,'[owned-temp]'),stderr:String(error.stderr??'').slice(-4000).replaceAll(temporary,'[owned-temp]')};}
  }
  if(diagnosticMode==='http'){
   const child=spawn(engine,['--print-logs','serve','--hostname','127.0.0.1','--port','0'],{env:process.env,cwd:project,stdio:['ignore','pipe','pipe']});
   let logs='';const exited=new Promise(resolve=>child.once('exit',resolve));
   try{
    const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned HTTP startup timed out.')),15000);
     const observe=data=>{logs=(logs+data).slice(-24000);const match=logs.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}};
     child.stdout.on('data',observe);child.stderr.on('data',observe);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Owned HTTP exited.'));});
    });
    const post=async(route,value)=>{const response=await fetch(url+route,{method:'POST',headers:{'content-type':'application/json','x-opencode-directory':project},body:JSON.stringify(value),signal:AbortSignal.timeout(30000)});return {status:response.status,body:await response.json()};};
    const session=await post('/session',{title:'Owned method diagnostic'});
    const result=await post('/session/'+session.body.id+'/message',{agent:agent.slug,parts:[{type:'text',text:'Read app.js and the accepted change tasks. Implement the owned QA task, then return DONE.'}]});
    evidence.http={status:result.status,error:result.status===200?undefined:JSON.stringify(result.body).slice(-4000).replaceAll(temporary,'[owned-temp]'),hasFinalText:JSON.stringify(result.body).includes('bridge performs final independent checks'),
     shape:{keys:Object.keys(result.body),info:{role:result.body.info?.role,finish:result.body.info?.finish,error:result.body.info?.error?.name,completed:typeof result.body.info?.time?.completed},
      parts:result.body.parts?.map(part=>({type:part.type,status:part.state?.status,reason:part.reason,completed:typeof part.time?.end}))}};
   }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);}
  }
 }else{
 const payload={protocol:'agent-method-workflow-v1',workflowId:randomUUID(),requestId:randomUUID(),projectId,bindingId,instanceId,method:'openspec',methodVersion:'1.15.0',stage:'full-cycle',instruction:'Continue native-method-file: update only app.js and finish its accepted task. Preserve proposal/design/specs. Do not archive in this fixture; the bridge validates task completion.',runtime:'opencode',deadlineAt:new Date(Date.now()+120000).toISOString(),checks:[{command:'node',args:['check.cjs']}]};
 const acceptedFiles=['proposal.md','design.md','specs/native-file/spec.md'];
 const acceptedBefore=await Promise.all(acceptedFiles.map(file=>fs.readFile(path.join(changeDirectory,file),'utf8'))),job={id:randomUUID(),lease:randomUUID(),project_id:projectId,payload};
 await runAgentMethodWorkflow(job,deviceId,async()=>{},async()=>{});
 const result=await methodDeliveryResult(job.id,deviceId,payload.workflowId);if(fixtureError)throw fixtureError;
 assert.equal(result.state,'succeeded',JSON.stringify(result));assert.equal(result.checks[0].state,'passed');assert.equal(result.checks[0].exitCode,0);
 assert.ok(result.changes.some(file=>file.path==='app.js'));assert.ok(result.changes.some(file=>file.path===taskFile));
 assert.deepEqual(await Promise.all(acceptedFiles.map(file=>fs.readFile(path.join(changeDirectory,file),'utf8'))),acceptedBefore);
 assert.equal(round,3);assert.equal(registryRequests,0);
 // A lost server ACK may replay this accepted job, but it cannot start the native agent twice.
 await runAgentMethodWorkflow({...job,lease:randomUUID()},deviceId,async()=>{},async()=>{});
 assert.equal(round,3);assert.deepEqual(await methodDeliveryResult(job.id,deviceId,payload.workflowId),result);
 const recovered=[];await recoverMethodCompletions(async value=>{recovered.push(value);});
 assert.equal(recovered.length,1);assert.equal(recovered[0].id,job.id);assert.equal(recovered[0].state,'succeeded');
 await acknowledgeMethodReceipt(job.id,payload.workflowId);const afterAck=[];await recoverMethodCompletions(async value=>{afterAck.push(value);});assert.deepEqual(afterAck,[]);
 Object.assign(evidence,{ok:true,modelRequests:round,registryRequests,realToolRead:true,realToolWrite:true,realMethodValidation:true,realCheck:true,acceptedRequirementsPreserved:true,durableReplay:true,completionAck:true,result});
 }
}catch(error){evidence.error=String(error.stack??error).replaceAll(temporary,'[owned-temp]');process.exitCode=1;}
finally{
 if(!evidence.ok){evidence.ownedLogs=[];for(const file of await fs.readdir(path.join(home,'data/opencode/log')).catch(()=>[]))if(file.endsWith('.log'))evidence.ownedLogs.push((await fs.readFile(path.join(home,'data/opencode/log',file),'utf8')).split('\n').slice(-30).join('\n').replaceAll(temporary,'[owned-temp]'));}
 for(const directory of locked)await fs.chmod(directory,0o700);
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(temporary,{recursive:true,force:true});evidence.temporaryProfileRemoved=true;await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({ok:evidence.ok,modelRequests:round,registryRequests,temporaryProfileRemoved:true}));
}
