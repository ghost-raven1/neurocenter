// Local acceptance uses an existing own QA card and changes only disposable project/device/folder state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url)),base=new URL(process.env.NEUROCENTER_TEST_URL||'http://localhost:5173');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(base.hostname)&&!base.username&&!base.password&&base.pathname==='/','Only a local root URL is allowed');
const expectedBridgeVersion=JSON.parse(await fs.readFile(path.join(root,'mcp/neurocenter-asset-sync/package.json'),'utf8')).version;
const sourceAssetId=process.env.NATIVE_UPLOAD_QA_ASSET||'tool-b0234be8bfb7250d0bae0f35ddc2ea5f';
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-native-install-')),folder=path.join(temporary,'Рабочая папка','Проект MCP с пробелами');
await fs.mkdir(folder,{recursive:true});process.env.NEUROCENTER_URL=base.origin;process.env.NEUROCENTER_BRIDGE_HOME=path.join(temporary,'bridge-state');
const {writeState,stateDir}=await import(new URL('../../mcp/neurocenter-asset-sync/dist/bridge/state.js',import.meta.url));
const {setRoot}=await import(new URL('../../mcp/neurocenter-asset-sync/dist/bridge/workspace.js',import.meta.url));
const require=createRequire(path.join(root,'mcp/neurocenter-asset-sync/package.json'));
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js'),{parse}=require('jsonc-parser');
let cookie='',project,deviceId,worker,installed=false,manifest,binding,client,version,assetId;
const cases=[],cleanupErrors=[],jobIds=[];let workerVersion,uninstalled=false,projectDeleted=false,deviceRevoked=false,error;

async function call(method,route,body,expected=200){
 const response=await fetch(new URL(route,base),{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{cookie,'Content-Type':'application/json','X-Neurocenter-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const value=await response.json();assert.equal(response.status,expected,`${method} ${route}: HTTP ${response.status}, ${typeof value.message==='string'?value.message.slice(0,300):''}`);return value;
}
async function waitFor(read,label){const deadline=Date.now()+60000;while(Date.now()<deadline){const value=await read();if(value)return value;await delay(250);}throw new Error('Did not observe '+label);}
async function device(){return(await call('GET','/api/devices')).find(item=>item.id===deviceId);}
async function job(kind,extra={}){
 const input={deviceId,projectId:project.id,requestKey:randomUUID(),kind,...extra},queued=await call('POST','/api/device-jobs',input,201);jobIds.push(queued.id);
 assert.equal((await call('POST','/api/device-jobs',input,201)).id,queued.id,'Exact job retry must be idempotent');
 const completed=await waitFor(async()=>{const next=(await call('GET','/api/device-jobs')).find(item=>item.id===queued.id);return next&&!['queued','running','reconciling'].includes(next.state)?next:undefined;},kind);
 assert.equal(completed.state,'succeeded',`${kind}: ${completed.message}`);return completed;
}
async function removeInstallation(){
 await job('uninstall',{assetId,assetKind:'mcp',expectedManifest:manifest,expectedBindingId:binding});installed=false;uninstalled=true;
 const list=await call('GET','/api/device-installations');assert.equal(list.some(item=>item.projectId===project.id&&item.deviceId===deviceId&&item.assetId===assetId),false);
}

try{
 const login=await fetch(new URL('/auth/login',base),{redirect:'manual',signal:AbortSignal.timeout(15000)});cookie=login.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
 const {user}=await call('GET','/auth/me');assert.equal(user.activeRole,'Главный админ');
 const {Pool}=createRequire(path.join(root,'services/catalog-service/package.json'))('pg'),pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',max:1});
 try{const result=await pool.query("SELECT result FROM tool_build_jobs WHERE state='SUCCEEDED' AND result->>'assetId'=$1 ORDER BY created_at DESC LIMIT 1",[sourceAssetId]);assetId=result.rows[0]?.result.catalogId;assert.ok(typeof assetId==='string','A published own QA card must exist');}finally{await pool.end();}
 const card=await call('GET','/api/ai-plugins/'+assetId);version=card.version;assert.ok(Number.isSafeInteger(version)&&version>0,'QA card must expose its current catalog version');
 project=await call('POST','/api/projects',{name:'QA native gateway '+randomUUID().slice(0,8)},201);
 await call('POST',`/api/projects/${project.id}/members`,{principalName:user.email,role:'Разработчик'},201);
 await call('POST',`/api/projects/${project.id}/assets`,{assetId,assetKind:'mcp'},201);
 const token=randomBytes(32).toString('hex'),pair=await call('POST','/api/device-channel/pair/start',{name:'QA · native upload installation',fingerprint:randomBytes(32).toString('hex'),credentialHash:createHash('sha256').update(token).digest('hex')},201);
 await call('POST',`/api/device-pairs/${pair.userCode}/approve`,{},201);const connected=await call('POST','/api/device-channel/pair/poll',{deviceCode:pair.deviceCode},201);
 deviceId=connected.deviceId;assert.ok(deviceId);assert.equal(connected.token,undefined);await writeState('credentials',{deviceId,token,email:user.email});await setRoot(path.dirname(folder));
 worker=spawn(process.execPath,[path.join(root,'mcp/neurocenter-asset-sync/dist/index.js'),'--worker'],{env:process.env,stdio:'ignore'});
 const ready=await waitFor(async()=>{const item=await device();return item?.online?item:undefined;},'the disposable worker');workerVersion=ready.report.bridgeVersion;assert.equal(workerVersion,expectedBridgeVersion);cases.push('Gateway paired a private worker '+expectedBridgeVersion+' without altering another device');
 const prepared=await job('prepare-bind-project',{folderName:path.basename(folder),bindingMode:'new'});
 await job('bind-project',{folderName:path.basename(folder),bindingMode:'new',preparationJobId:prepared.id,expectedPreparation:prepared.result.preparation});
 const bound=await waitFor(async()=>(await device())?.report.bindings?.find(item=>item.projectId===project.id&&item.valid),'the exact project binding');binding=bound.bindingId;assert.match(binding,/^[a-f0-9]{64}$/);cases.push('Gateway prepare/commit bound a temporary Unicode folder and duplicate jobs stayed idempotent');
 const pending=await call('POST','/api/device-install-plans',{projectId:project.id,assetId,assetKind:'mcp',version},201);
 const plan=await call('POST',`/api/device-install-plans/${pending.id}/approve`,{expectedManifest:pending.manifest,expectedRevision:pending.revision},201);assert.equal(plan.status,'approved');
 const installedJob=await job('install',{assetId,assetKind:'mcp',version,expectedBindingId:binding,expectedManifest:plan.manifest,planId:plan.id,planRevision:plan.revision});installed=true;manifest=installedJob.result.manifest;assert.equal(manifest,plan.manifest);
 const installation=(await call('GET','/api/device-installations')).find(item=>item.projectId===project.id&&item.deviceId===deviceId&&item.assetId===assetId);assert.ok(installation?.isCurrentBinding);cases.push('Approved exact native delivery was downloaded through the Gateway job and installed by the worker');
 const key=createHash('sha256').update('mcp:'+assetId).digest('hex').slice(0,24),receipt=JSON.parse(await fs.readFile(path.join(folder,'.opencode/neurocenter/receipts',key+'.json'),'utf8'));
 const configured=parse(await fs.readFile(path.join(folder,receipt.config.path),'utf8')).mcp[receipt.config.key],command=configured.command;assert.equal(configured.type,'local');assert.equal(configured.enabled,true);assert.ok(Array.isArray(command)&&command.length===1);
 assert.ok(command[0].startsWith(stateDir()+path.sep+'runtime-artifacts'+path.sep));assert.equal(path.basename(command[0]),'fixture-mcp');
 const archive=await fs.readFile(path.join(path.dirname(path.dirname(path.dirname(command[0]))),'.neurocenter-runtime-archive.tar.gz'));
 const runtimeSha=createHash('sha256').update(archive).digest('hex');assert.equal(runtimeSha,'1344ee62ab8d3e1174faaaf4a872f7806c9542b9c02fabf65e5c832723af4023');cases.push('Generated OpenCode configuration points at the exact checked private runtime cache SHA');
 client=new Client({name:'Neurocenter Gateway installation acceptance',version:'1.0.0'});await client.connect(new StdioClientTransport({command:command[0],cwd:folder,env:{PATH:'/nonexistent',HOME:temporary},stderr:'ignore'}));
 assert.equal(client.getServerVersion()?.name,'Neurocenter acceptance fixture');cases.push('Installed native MCP completed SDK initialize');
 assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['fixture_status']);cases.push('Installed native MCP completed SDK tools/list');
 const response=await client.callTool({name:'fixture_status',arguments:{}});assert.notEqual(response.isError,true);assert.equal(response.content[0].text,'fixture-ready');cases.push('Installed native MCP completed SDK tools/call with fixture-ready');await client.close();client=undefined;
 await removeInstallation();assert.equal(parse(await fs.readFile(path.join(folder,receipt.config.path),'utf8')).mcp?.[receipt.config.key],undefined);await assert.rejects(fs.stat(path.join(folder,'.opencode/neurocenter/receipts',key+'.json')),{code:'ENOENT'});cases.push('Gateway uninstall removed only the temporary installation and its OpenCode entry');
 assert.equal((await call('GET','/api/ai-plugins/'+assetId)).version,version);
}catch(cause){error=cause.message;process.exitCode=1;}finally{
 await client?.close().catch(()=>{});
 if(installed)try{await removeInstallation();}catch{cleanupErrors.push('Temporary installation cleanup failed');}
 if(worker&&worker.exitCode===null){const exited=new Promise(resolve=>worker.once('exit',resolve));worker.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(worker.exitCode===null){worker.kill('SIGKILL');await exited;}}
 if(deviceId)try{await call('DELETE','/api/devices/'+deviceId);deviceRevoked=true;}catch{cleanupErrors.push('Temporary device revocation failed');}
 if(project)try{await call('DELETE','/api/projects/'+project.id);projectDeleted=true;}catch{cleanupErrors.push('Temporary project deletion failed');}
 await fs.rm(temporary,{recursive:true,force:true});
 const report={ok:!error&&cleanupErrors.length===0,at:new Date().toISOString(),passed:cases.length,cases,...(error?{error}:{}),assetId:sourceAssetId,catalogId:assetId,version,workerVersion,gatewayInstallation:cases.some(item=>item.startsWith('Approved exact')),nativeProtocolChecks:cases.filter(item=>item.startsWith('Installed native MCP')).length,fixture:{projectId:project?.id,deviceId,jobIds},cleanup:{uninstalled,projectDeleted,deviceRevoked,temporaryFolderRemoved:true,auditHistoryRetained:true,errors:cleanupErrors},userDevicesChanged:false,catalogCardChanged:false};
 await fs.mkdir(path.join(root,'output/browser-feedback'),{recursive:true});await fs.writeFile(path.join(root,'output/browser-feedback/native-upload-gateway-install-live.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(cleanupErrors.length)process.exitCode=1;
}
