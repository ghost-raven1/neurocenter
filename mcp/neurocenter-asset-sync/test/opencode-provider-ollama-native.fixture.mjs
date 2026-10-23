import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

// Explicit acceptance only: pinned native OpenCode and a compiled bridge adapter, never a real provider/account.
const [engine,adapter,output,ripgrep]=process.argv.slice(2).map(value=>path.resolve(value));
assert.ok(engine&&adapter&&output&&ripgrep,'Provide engine, compiled adapter, proof output and an existing native ripgrep binary.');
const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-ollama-native-'))),home=path.join(temporary,'home'),project=path.join(temporary,'project');
const provider='neurocenter-ollama-'+'a'.repeat(16),model='qwen3:8b',marker='OWNED_OLLAMA_FILE_READ',key='PRIVATE_FIXTURE_OLLAMA_KEY';
const evidence={ok:false,realProfileChanged:false,engineVersion:'1.14.48',registryRequests:0,scenarios:[]};
let keyed=false,round=0,assertion,nativeRequests=0;
const reply=(message,done=true)=>({model,created_at:'2026-10-24T00:00:00Z',done,done_reason:'stop',message:{role:'assistant',content:'',...message},prompt_eval_count:12,eval_count:4});
const server=http.createServer((req,res)=>{void(async()=>{
    if(req.url!=='/prefix/api/chat'){evidence.registryRequests++;res.writeHead(503);res.end();return;}
    const chunks=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));nativeRequests++;
    assert.equal(req.headers.authorization,keyed?'Bearer '+key:undefined);assert.equal(body.model,model);assert.equal(body.stream,true);
    assert.deepEqual(body.options,{temperature:0,top_p:0.4,num_predict:128,num_ctx:8192});
    assert.ok(body.tools.some(tool=>tool.function.name==='read'),'OpenCode must expose its real read tool.');
    res.writeHead(200,{'Content-Type':'application/x-ndjson'});
    if(round++===0){res.end(JSON.stringify(reply({tool_calls:[{id:'owned-read',function:{name:'read',arguments:{filePath:path.join(project,'owned.txt')}}}]}))+'\n');return;}
    assert.ok(body.messages.some(message=>message.role==='tool'&&String(message.content).includes(marker)),'The model continuation must contain the actual file tool result.');
    assert.equal(round,2,'No unbounded agent loop.');res.end(JSON.stringify(reply({content:'OLLAMA_NATIVE_OK'},false))+'\n'+JSON.stringify(reply({}))+'\n');
})().catch(error=>{assertion=error;if(!res.headersSent)res.writeHead(500);res.end();});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port,execute=promisify(execFile);
async function nativeServer(env){
    const child=spawn(engine,['--print-logs','--log-level','DEBUG','serve','--hostname','127.0.0.1','--port','0'],{cwd:project,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    const close=async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');let timeout;const result=await Promise.race([exited,new Promise(resolve=>timeout=setTimeout(()=>resolve(null),5000))]);clearTimeout(timeout);if(!result){child.kill('SIGKILL');await exited;}return {stdout,stderr};};
    try{
        const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned OpenCode HTTP startup timed out.')),15000),observe=()=>{const match=(stdout+'\n'+stderr).match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}};
            child.stdout.on('data',data=>{stdout=(stdout+data).slice(-16000);observe();});child.stderr.on('data',data=>{stderr=(stderr+data).slice(-24000);observe();});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned OpenCode HTTP exited during startup. '+stderr));});});
        const post=async(route,value)=>{const res=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','x-opencode-directory':project},body:JSON.stringify(value),signal:AbortSignal.timeout(45000)});const text=await res.text();assert.ok(res.ok,'Owned OpenCode API '+route+': '+res.status+' '+text.slice(0,2000));return JSON.parse(text);};
        return {post,close};
    }catch(error){await close();throw Object.assign(error,{stdout,stderr});}
}
try{
    await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'owned.txt'),marker);await fs.mkdir(home);
    const bin=path.join(temporary,'bin');await fs.mkdir(bin);await fs.copyFile(ripgrep,path.join(bin,process.platform==='win32'?'rg.exe':'rg'));await fs.chmod(path.join(bin,process.platform==='win32'?'rg.exe':'rg'),0o755);
    const config=path.join(home,'config/opencode');await fs.mkdir(config,{recursive:true});
    const dependency={'@opencode-ai/plugin':'1.14.48'};
    for(const directory of [config,path.join(project,'.opencode')]){
        await fs.mkdir(directory,{recursive:true});await fs.mkdir(path.join(directory,'node_modules'));
        await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({private:true,dependencies:dependency}));
        await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:dependency}}}));
    }
    const bunfig='telemetry = false\nenv = false\n[install]\nauto = "disable"\n';
    await fs.writeFile(path.join(home,'.bunfig.toml'),bunfig);await fs.writeFile(path.join(project,'bunfig.toml'),bunfig);
    const modelsFile=path.join(home,'models.json');await fs.writeFile(modelsFile,'{}');
    const env={HOME:home,USERPROFILE:home,PATH:bin+path.delimiter+'/usr/bin'+path.delimiter+'/bin',TERM:'dumb',NO_COLOR:'1',XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),
        OPENCODE_MODELS_PATH:modelsFile,OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_TEST_MANAGED_CONFIG_DIR:path.join(temporary,'managed'),
        NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_REGISTRY:origin+'/registry',npm_config_registry:origin+'/registry'};
    assert.equal((await execute(engine,['--version'],{cwd:project,env,timeout:15000,killSignal:'SIGKILL'})).stdout.trim(),evidence.engineVersion);
    Object.assign(process.env,env,{NEUROCENTER_URL:'https://native-acceptance.example.test',NEUROCENTER_BRIDGE_HOME:path.join(temporary,'bridge-private')});
    for(const key of ['OPENCODE_CONFIG','OPENCODE_CONFIG_DIR','OPENCODE_CONFIG_CONTENT','OPENCODE_DISABLE_PROJECT_CONFIG'])delete process.env[key];
    const moduleUrl=pathToFileURL(adapter),load=relative=>import(new URL(relative,moduleUrl).href),workspace=await load('../../bridge/workspace.js'),state=await load('../../bridge/state.js');
    const {providerContext}=await load('./context.js'),{saveProvider}=await load('./engine.js');
    const {projectAgentMappings}=await load('../project-agents/model-compiler.js'),{configureProjectAgents}=await load('../project-agents/index.js'),{createProjectAgentsPayload,compileProjectAgents}=await load('../project-agents/contract.js');
    const projectId='prj-native-ollama',deviceId=randomUUID(),noop=async()=>{};
    await workspace.setRoot(temporary);await workspace.bindProject(projectId,path.basename(project));await state.writeState('credentials',{deviceId,token:'OWNED_DEVICE_FIXTURE'});
    const bindingId=await workspace.projectBindingId(projectId),instanceId=await workspace.projectInstanceId(projectId),options={temperature:0,topP:0.4,maxOutputTokens:128,contextWindow:8192};
    const descriptor={schemaVersion:1,deviceId,projectId,bindingId,instanceId,providerId:provider,providerKind:'ollama',schemaDigest:'b'.repeat(64),connector:null,
        expectations:{catalogModelId:'model-native-ollama',modelPin:'c'.repeat(64),runtimeModel:model,capability:'chat',baseUrl:origin+'/prefix',options}};
    const context=await providerContext(descriptor,noop),agent={id:'agent-native-ollama',slug:'nc-native-ollama',version:1,enabled:true,description:'Owned native acceptance',prompt:'Use the read tool once, then respond with the model result.',mode:'primary',permission:{read:'allow',bash:'deny',edit:'deny'},model:'neurocenter/model-native-ollama'};
    let revision=null;
    for(const withKey of [false,true]){
        keyed=withKey;round=0;assertion=undefined;
        await fs.writeFile(path.join(config,'opencode.json'),JSON.stringify({mcp:{},plugin:[],enabled_providers:[provider],lsp:false,formatter:false,autoupdate:false,snapshot:false,share:'disabled',permission:{'*':'deny',read:'allow'}}));
        const status=await saveProvider(context,withKey?key:undefined,revision,noop);assert.equal(status.ready,true);revision=status.revision;
        const payload=createProjectAgentsPayload({schemaVersion:2,projectId,bindingId,instanceId,revision:withKey?2:1,agents:[agent],modelRequirements:[{kind:'catalog',agentId:agent.id,catalogModelId:'model-native-ollama',modelPin:'c'.repeat(64),runtime:'remote-ollama',runtimeModel:model,baseUrl:origin+'/prefix',options,capability:'chat'}]});
        const mappings=await projectAgentMappings(payload,project,noop);assert.equal(mappings[0].runtime,'remote-ollama');
        await configureProjectAgents(payload,noop,noop,async value=>compileProjectAgents(payload,value));
        const locked=[config,path.join(config,'node_modules'),path.join(project,'.opencode'),path.join(project,'.opencode/node_modules')];
        for(const dir of locked)await fs.chmod(dir,0o500);
        let result,owned,logs;
        try{owned=await nativeServer(env);const session=await owned.post('/session',{title:'Owned native Ollama acceptance'});assert.ok(session.id);
            result=await owned.post('/session/'+session.id+'/message',{agent:agent.slug,parts:[{type:'text',text:'Read owned.txt using read, then reply OK.'}]});}
        catch(error){logs=await owned?.close();throw Object.assign(error,logs??{});}
        finally{if(owned&&!logs)logs=await owned.close();for(const dir of locked)await fs.chmod(dir,0o700);}
        if(assertion)throw assertion;
        assert.equal(round,2,logs.stderr);assert.ok(JSON.stringify(result).includes('OLLAMA_NATIVE_OK'),JSON.stringify(result)+logs.stderr);
        assert.ok(!JSON.stringify(result).includes(key)&&!logs.stderr.includes(key));
        evidence.scenarios.push({key:withKey?'local-file':'none',nativeRequests:round,realToolRead:true,streamedReply:true,ownedServerReaped:true});
    }
    assert.equal(evidence.registryRequests,0);evidence.ok=true;
}catch(error){evidence.error=String(error.stack??error).replaceAll(key,'[fixture-key]');evidence.child={code:error.code,signal:error.signal,killed:error.killed,stdout:String(error.stdout??'').slice(-4000).replaceAll(key,'[fixture-key]'),stderr:String(error.stderr??'').slice(-12000).replaceAll(key,'[fixture-key]')};process.exitCode=1;}
finally{
    evidence.nativeRequests=nativeRequests;const logDirectory=path.join(home,'data/opencode/log');evidence.lastLogs=[];
    for(const name of await fs.readdir(logDirectory).catch(()=>[]))if(name.endsWith('.log'))evidence.lastLogs.push((await fs.readFile(path.join(logDirectory,name),'utf8')).split('\n').slice(-35).join('\n').replaceAll(key,'[fixture-key]').replaceAll(temporary,'[owned-temp]'));
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(temporary,{recursive:true,force:true});evidence.temporaryProfileRemoved=true;
    await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(evidence));
}
