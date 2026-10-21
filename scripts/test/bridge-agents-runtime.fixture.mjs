import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// This fixture runs with the extracted runtime's own Node, compiled files and native OpenCode only.
const content=process.cwd(),directory=path.resolve(process.argv[2]);
assert.ok(directory.startsWith((await fs.realpath(os.tmpdir()))+path.sep),'Native runtime fixture must use an OS temporary directory.');
await fs.mkdir(directory,{recursive:true});
const project=path.join(directory,'проекты','мой проект');await fs.mkdir(project,{recursive:true});
const load=relative=>import(pathToFileURL(path.join(content,'dist',relative)).href);
const contract=await load('features/project-agents/contract.js'),protocol=await load('bridge/protocol.js');
assert.equal(contract.PROJECT_AGENTS_JOB,'configure-project-agents');assert.ok(protocol.BRIDGE_CAPABILITIES.includes('project-agents-v2'));
const metadata=JSON.parse(await fs.readFile(path.join(content,'runtime.json'),'utf8')),engine=path.join(content,metadata.probeEngine.file);
assert.equal(createHash('sha256').update(await fs.readFile(engine)).digest('hex'),metadata.probeEngine.sha256);
const nativeHome=path.join(directory,'native-home');await fs.mkdir(nativeHome);
const nativeEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:OPENCODE_|XDG_|HOME$)|(?:_API_KEY|_ACCESS_TOKEN|_SECRET)$/.test(key)));
Object.assign(nativeEnv,{HOME:nativeHome,XDG_CONFIG_HOME:path.join(nativeHome,'config'),XDG_DATA_HOME:path.join(nativeHome,'data'),XDG_CACHE_HOME:path.join(nativeHome,'cache'),XDG_STATE_HOME:path.join(nativeHome,'state'),
 OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_REGISTRY:'http://127.0.0.1:9'});
const execute=promisify(execFile),native=async(...args)=>{
 const config=path.join(nativeHome,'config/opencode'),projectConfig=path.join(project,'.opencode');
 const dependencies={'@opencode-ai/plugin':'1.14.48'};
 for(const dir of [config,projectConfig]){
  await fs.mkdir(dir,{recursive:true});await fs.chmod(dir,0o700);
  await fs.mkdir(path.join(dir,'node_modules'),{recursive:true});
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({private:true,dependencies}));
  await fs.writeFile(path.join(dir,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies}}}));
  await fs.chmod(path.join(dir,'node_modules'),0o500);
 }
 await fs.writeFile(path.join(config,'opencode.json'),JSON.stringify({mcp:{},plugin:[],enabled_providers:[],provider:{},lsp:false,formatter:false,autoupdate:false,snapshot:false,share:'disabled',permission:{'*':'deny'}}));
 for(const dir of [config,projectConfig])await fs.chmod(dir,0o500);
 try{return(await execute(engine,args,{cwd:project,env:nativeEnv,timeout:30000,maxBuffer:2*1024*1024})).stdout;}
 finally{for(const dir of [config,projectConfig])await fs.chmod(dir,0o700);}
};
assert.equal((await native('--version')).trim(),metadata.probeEngine.version);
let child,stderr='',finish,fail,queue=[],current,requests=0,ackAttempts=0,nativeChecks=0;const seen=new Map();
const completed=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
const server=http.createServer(async(req,res)=>{
 try{
  if(!req.url.startsWith('/api/device-channel/')){res.writeHead(404);res.end('{}');return;}
  const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.headers.authorization,'Bearer isolated-fixture');const route=req.url.slice('/api/device-channel/'.length);requests++;
  let result={};
  if(route==='jobs/claim'){current=queue.shift();result=current??null;}
  else if(route==='agents/compile'){result=contract.compileProjectAgents(current.payload,input.mappings);current.payload.compilation=result;}
  else if(route.endsWith('/authorize')||route.endsWith('/progress')){assert.ok(current);assert.equal(input.lease,current.lease);}
  else if(route.endsWith('/complete')){
   assert.ok(current);assert.equal(route,`jobs/${current.id}/complete`);assert.equal(input.lease,current.lease);ackAttempts++;
   if(seen.has(current.id))assert.deepEqual(input,seen.get(current.id));
   else{
    if(current.badInstance){assert.equal(input.state,'failed');assert.deepEqual(input.result,{});}
    else{
     assert.equal(input.state,'succeeded');contract.validateProjectAgentsResult(input.result,current.payload);
     const revision=current.payload.revision,filename=path.join(project,'.opencode/agents/nc-runtime-review.md');
     if(revision<5)assert.equal(await fs.readFile(filename,'utf8'),contract.renderProjectAgent(current.payload.agents[0]));
     else await assert.rejects(fs.stat(filename),error=>error.code==='ENOENT');
     if([1,3,4,5].includes(revision)){
      const list=await native('agent','list');nativeChecks++;
      assert.equal(list.includes('nc-runtime-review (all)'),revision===1||revision===4);assert.ok(list.includes('manual (subagent)'));
     }
     if(revision===2){const config=JSON.parse(await native('debug','config'));assert.equal(config.agent['nc-runtime-review'].prompt,'Edited project prompt');assert.equal(config.agent['nc-runtime-review'].permission.bash,'ask');}
    }
    seen.set(current.id,input);
    if(current.payload.revision===2){res.writeHead(503,{'content-type':'application/json'});res.end('{"message":"lost ACK"}');return;}
   }
   if(seen.size===6)finish();
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(error){fail(error);res.writeHead(500,{'content-type':'application/json'});res.end('{"message":"fixture assertion failed"}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 process.env.NEUROCENTER_URL='http://127.0.0.1:'+server.address().port;process.env.NEUROCENTER_BRIDGE_HOME=path.join(directory,'private');
 const workspace=await load('bridge/workspace.js'),state=await load('bridge/state.js');
 await workspace.setRoot(path.dirname(project));await workspace.bindProject('runtime-agents',path.basename(project));
 await state.writeState('credentials',{deviceId:randomUUID(),token:'isolated-fixture',email:'fixture@example.test'});
 const bindingId=await workspace.projectBindingId('runtime-agents'),instanceId=await workspace.projectInstanceId('runtime-agents');
 await fs.mkdir(path.join(project,'.opencode/agents'));await fs.writeFile(path.join(project,'.opencode/agents/manual.md'),'---\ndescription: User agent\nmode: subagent\n---\nManual instructions.\n');
 const agent={id:'agent-runtime-review',slug:'nc-runtime-review',version:1,enabled:true,description:'Runtime reviewer',prompt:'Original project prompt',mode:'all',permission:{edit:'deny',bash:'ask'},temperature:0.2,topP:0.9,steps:7};
 queue=Array.from({length:6},(_,index)=>{
  const revision=index+1,agents=revision>=5?[]:[{...agent,prompt:revision>=2?'Edited project prompt':agent.prompt,enabled:revision!==3}];
  return {id:randomUUID(),lease:randomUUID(),kind:contract.PROJECT_AGENTS_JOB,project_id:'runtime-agents',badInstance:revision===6,
   payload:contract.createProjectAgentsPayload({schemaVersion:2,projectId:'runtime-agents',bindingId,instanceId:revision===6?randomUUID():instanceId,revision,agents})};
 });
 const code=`const{runWorker}=await import(${JSON.stringify(pathToFileURL(path.join(content,'dist/bridge/worker.js')).href)});await runWorker();`;
 child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:content,env:{...process.env,HOME:nativeHome,XDG_CONFIG_HOME:nativeEnv.XDG_CONFIG_HOME,XDG_DATA_HOME:nativeEnv.XDG_DATA_HOME},stdio:['ignore','ignore','pipe']});child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',fail);
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 const timeout=setTimeout(()=>fail(new Error('Compiled agent worker acceptance timed out')),120000);
 try{await completed;}finally{clearTimeout(timeout);}
 child.kill('SIGTERM');const exit=await exited;assert.equal(exit.code,0,stderr);assert.equal(seen.size,6);assert.equal(ackAttempts,7);
 console.log(JSON.stringify({capability:true,jobKind:true,httpJobs:6,lostAckPreserved:true,staleInstanceRejected:true,manualAgentPreserved:true,nativeChecks,engineVersion:metadata.probeEngine.version,engineSha256:metadata.probeEngine.sha256,buildId:metadata.buildId,requests}));
}finally{
 if(child&&child.exitCode===null)child.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));
}
