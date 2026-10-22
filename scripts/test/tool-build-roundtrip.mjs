import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {cancellationFixture,deferred,until} from './tool-build-cancellation.fixture.mjs';
import {ownedProcessSnapshot,observeOwnedProcesses,ownedGroupsToSignal} from './tool-build-roundtrip-process.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
if(process.platform==='win32'||Number(process.versions.node.split('.')[0])<24)throw Error('This native roundtrip requires Node24 and POSIX process inventory; Windows acceptance is separate.');
const bridge=process.env.TOOL_BUILD_BRIDGE_DIST,builder=process.env.TOOL_BUILD_SCRIPT;
for(const [label,value]of [['Bridge dist',bridge],['Real builder',builder]]){
    if(!value||!path.isAbsolute(value))throw Error(label+' must be an explicit absolute candidate path');
}
assert.ok((await stat(path.join(bridge,'bridge/installer.js'))).isFile());
assert.ok((await stat(builder)).isFile());
const inputs=['tool-build-roundtrip.mjs','tool-build-roundtrip-worker.mjs','tool-build-roundtrip-install.mjs','tool-build-roundtrip-process.mjs','tool-build-roundtrip-process.test.mjs','tool-build-cancellation.fixture.mjs','owned-postgres.fixture.mjs','tool-build-cancellation-lease.mjs'].map(name=>path.join(root,'scripts/test',name));
const hashes=async()=>Object.fromEntries(await Promise.all(inputs.map(async filename=>[path.relative(root,filename),createHash('sha256').update(await readFile(filename)).digest('hex')])));
const inputHashes=await hashes();
const fixture=await cancellationFixture();
const {pool,load,folder,actor,receipt}=fixture;
receipt.scope='Actual JS source → Catalog queue/builder/publication → exact package → separate native bridge installer';
receipt.harnessHashes=inputHashes;
receipt.limits.push('Loopback flags/events and approved runtime transport use fixture authorization; production Gateway/device leasing are separate acceptance.');
receipt.limits.push('Installed hook is invoked directly through generated OpenCode config; ordinary native OpenCode startup is separate acceptance.');
const runtime=new(load('runtime-artifacts/runtime-artifacts.js').RuntimeArtifacts)({pool});
const {captureProjectAsset,checkedProjectPackage}=load('catalog/project-asset-pins.js');
const projectAssets=new(load('catalog/project-asset-repository.js').ProjectAssetRepository)(pool);
const projectId='prj-owned-package-roundtrip';
const projectPin=async id=>(await pool.query('SELECT * FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3',[projectId,id,'plugin'])).rows[0];
const activeOrigins=async id=>(await pool.query('SELECT * FROM asset_source_receipts WHERE asset_kind=$1 AND native_id=$2 AND active ORDER BY repository,external_id',['plugin',id])).rows;
const workers=[],requests=[],approved=new Map(),knownProcesses=new Map();
const credentials={deviceId:randomUUID(),email:actor.email,token:randomUUID()},job={id:randomUUID(),lease:randomUUID(),deviceId:credentials.deviceId};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
/** Record the current owned tree before shutdown; a reaped parent must not hide a live builder. */
function discoverOwnedProcesses(){
    const rows=ownedProcessSnapshot();observeOwnedProcesses(knownProcesses,rows,workers.map(worker=>worker.child.pid));return rows;
}
async function waitOwnedStopped(ms){
    const end=Date.now()+ms;
    while(Date.now()<end){const rows=discoverOwnedProcesses();if(!ownedGroupsToSignal(knownProcesses,rows).length)return true;await delay(80);}
    return false;
}
function signalOwnedGroups(signal){
    const rows=discoverOwnedProcesses();
    for(const group of ownedGroupsToSignal(knownProcesses,rows))try{process.kill(-group,signal);}catch(error){if(error.code!=='ESRCH')throw error;}
}
const deadline=async(promise,label,ms=15000)=>{
    let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' deadline')),ms);})]);}
    finally{clearTimeout(timer);}
};
const server=createServer((request,response)=>{
    void(async()=>{
        const match=new RegExp('^/api/device-channel/jobs/'+job.id+'/runtime/([a-f0-9]{64})$').exec(request.url??'');
        requests.push({method:request.method,path:request.url});
        if(request.method!=='GET'||!match||!approved.has(match[1])||request.headers.authorization!=='Bearer '+credentials.token
            ||request.headers['x-neurocenter-job-id']!==job.id||request.headers['x-neurocenter-job-lease']!==job.lease){response.statusCode=403;response.end();return;}
        const artifact=await runtime.open(match[1]);assert.equal(artifact.bytes,approved.get(match[1]));
        response.setHeader('Content-Length',String(artifact.bytes));response.setHeader('Content-Type','application/octet-stream');
        await pipeline(artifact.stream,response);
    })().catch(()=>{if(!response.headersSent){response.statusCode=500;response.end();}else response.destroy();});
});
async function start(filename,extra={}){
    const ready=deferred(),closed=deferred(),pending=new Map(),logs=[];
    const child=spawn(process.execPath,[filename],{env:{...process.env,...extra},detached:true,stdio:['ignore','pipe','pipe','ipc']});
    const worker={child,closed:closed.promise,pending,logs};workers.push(worker);
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logs.push(String(chunk).replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted database]')));
    const fail=error=>{ready.reject(error);for(const deferred of pending.values())deferred.reject(error);pending.clear();};
    child.on('error',fail);
    child.on('message',message=>{
        if(message?.type==='ready')ready.resolve(message);
        else if(message?.type==='fatal')fail(Error(message.message));
        else if(message?.type==='response'){
            const waiting=pending.get(message.id);pending.delete(message.id);
            if(message.ok)waiting?.resolve(message.value);else waiting?.reject(Object.assign(Error(message.error?.message),{status:message.error?.status}));
        }
    });
    child.once('close',(code,signal)=>{fail(Error('Owned child exited'));closed.resolve({code,signal});});
    await deadline(ready.promise,'Owned process ready');discoverOwnedProcesses();return worker;
}
async function ask(worker,message){
    const id=randomUUID(),result=deferred();worker.pending.set(id,result);
    try{worker.child.send({...message,id});return await deadline(result.promise,'Owned request',120000);}
    finally{worker.pending.delete(id);}
}
const source=version=>({type:'files',entrypoint:'plugin.mjs',files:[{path:'plugin.mjs',content:`export default async()=>({'experimental.chat.system.transform':async(_request,output)=>output.system.push(${JSON.stringify(version)})});\n`}]});
const terminal=async id=>until(async()=>{
    const row=await fixture.row(id);return ['FAILED','SUCCEEDED','CANCELLED'].includes(row.state)?row:false;
},'real builder terminal state',120000);
const packageFor=async(id,version)=>(await captureProjectAsset(pool,id,'plugin',version)).package;
function approve(pkg){for(const descriptor of pkg.config.extra.runtimeArtifacts)approved.set(descriptor.sha256,descriptor.compressedBytes);}
async function sourceProof(result,expectedSource){
    const {rows}=await pool.query('SELECT * FROM asset_source_versions WHERE repository=$1 AND external_id=$2 AND asset_version=$3',['local-archive',result.assetId,result.sourceVersion]);
    assert.equal(rows.length,1);const row=rows[0];assert.equal(row.descriptor_sha256,result.sourceSha256);
    const descriptor=row.descriptor.source;assert.equal(descriptor.type,'archive');
    const bytes=await readFile(path.join(folder,'runtime/.asset-source-blobs',descriptor.sha256+'.blob'));
    assert.equal(bytes.length,descriptor.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),descriptor.sha256);
    const snapshot=JSON.parse(bytes.toString('utf8'));
    assert.equal(snapshot.declaration.entrypoint,expectedSource.entrypoint);
    assert.deepEqual(snapshot.files,expectedSource.files);
    const archives=[];
    for(const {descriptor:artifact}of row.descriptor.delivery.artifacts){
        const archive=await readFile(path.join(folder,'runtime',artifact.sha256+'.tar.gz'));
        assert.equal(archive.length,artifact.compressedBytes);assert.equal(createHash('sha256').update(archive).digest('hex'),artifact.sha256);
        archives.push({sha256:artifact.sha256,bytes:archive.length});
    }
    return {descriptorSha256:row.descriptor_sha256,nativeVersion:row.native_version,sourceSha256:descriptor.sha256,sourceBytes:bytes.length,archives};
}

let fatal;
try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port,home=path.join(folder,'bridge-profile');
    await mkdir(path.join(home,'projects/bound-project'),{recursive:true});
    await writeFile(path.join(home,'projects/bound-project/opencode.json'),JSON.stringify({plugin:['manual-package@1.0.0'],mcp:{manual:{type:'local',command:['node','manual.js']}}}));
    await fixture.releaseWorkerGate();
    const worker=await start(fileURLToPath(new URL('./tool-build-roundtrip-worker.mjs',import.meta.url)),{TOOL_BUILD_TEST_ACTOR:actor.email});
    const installer=await start(fileURLToPath(new URL('./tool-build-roundtrip-install.mjs',import.meta.url)),{
        NEUROCENTER_URL:origin,NEUROCENTER_API_URL:origin,NEUROCENTER_BRIDGE_HOME:path.join(home,'private-state'),
        TOOL_BUILD_ROUNDTRIP_HOME:home,HOME:home,USERPROFILE:home,
    });
    let first,firstPackage,firstProof,firstPin,second,secondPackage,secondOrigins;
    const firstInput={requestKey:randomUUID(),kind:'plugin',name:'Owned JS roundtrip '+randomUUID().slice(0,8),description:'Private actual build and installation acceptance',targets:[process.platform+'-'+process.arch],source:source('A')};
    await fixture.check('Actual queued JS build retains its exact source and installs through the generated OpenCode entry',async()=>{
        const queued=await ask(worker,{type:'request',action:'create',input:firstInput});first=await terminal(queued.id);
        assert.equal(first.state,'SUCCEEDED',first.error??first.message);
        firstProof=await sourceProof(first.result,firstInput.source);
        await pool.query('INSERT INTO projects(id,name,state,rag_project_key) VALUES($1,$2,$3,$1)',[projectId,'Private actual packaging roundtrip','ACTIVE']);
        await projectAssets.add(projectId,first.result.catalogId,'plugin',actor.email);
        firstPin=await projectPin(first.result.catalogId);firstPackage=checkedProjectPackage(firstPin);approve(firstPackage);
        const installed=await ask(installer,{type:'install',credentials,job,pkg:firstPackage});
        assert.deepEqual(installed.hookOutput,['A']);assert.equal(installed.result.version,first.result.version);assert.ok(installed.authorizationChecks>=2);
        assert.deepEqual(installed.config.mcp.manual,{type:'local',command:['node','manual.js']});assert.ok(installed.config.plugin.includes('manual-package@1.0.0'));
        const replay=await ask(worker,{type:'request',action:'create',input:firstInput});assert.equal(replay.id,first.id);
        return {buildId:first.id,catalogId:first.result.catalogId,packageManifest:firstPackage.manifest.sha256,source:firstProof,installedVersion:installed.result.version,replaySameJob:true};
    });
    await fixture.check('Explicit update publishes version2 without changing immutable version1, then installs the new hook',async()=>{
        const target=await ask(worker,{type:'request',action:'target',input:{kind:'plugin',catalogId:first.result.catalogId}});
        assert.equal(target.updateSupported,true);assert.equal(target.expectedVersion,1);
        const publication={catalogId:target.catalogId,expectedVersion:target.expectedVersion,expectedSourceHash:target.expectedSourceHash};
        const input={...firstInput,requestKey:randomUUID(),source:source('B'),publication};
        const queued=await ask(worker,{type:'request',action:'create',input});second=await terminal(queued.id);
        assert.equal(second.state,'SUCCEEDED',second.error??second.message);assert.equal(second.result.catalogId,first.result.catalogId);assert.equal(second.result.version,2);
        secondOrigins=await activeOrigins(second.result.catalogId);
        assert.deepEqual(await projectPin(first.result.catalogId),firstPin,'Publishing global version2 must not replace a project pin');
        await projectAssets.add(projectId,first.result.catalogId,'plugin',actor.email);
        assert.deepEqual(await projectPin(first.result.catalogId),firstPin,'Repeated add must preserve the existing project version');
        await projectAssets.pin(projectId,second.result.catalogId,'plugin',actor.email,{version:2,expectedVersion:1,expectedManifest:firstPackage.manifest.sha256});
        secondPackage=checkedProjectPackage(await projectPin(second.result.catalogId));approve(secondPackage);
        assert.equal((await packageFor(first.result.catalogId,1)).manifest.sha256,firstPackage.manifest.sha256);
        assert.deepEqual(await sourceProof(first.result,firstInput.source),firstProof);
        const installed=await ask(installer,{type:'install',credentials,job,pkg:secondPackage});assert.deepEqual(installed.hookOutput,['B']);assert.equal(installed.result.version,2);
        assert.deepEqual(installed.config.mcp.manual,{type:'local',command:['node','manual.js']});assert.ok(installed.config.plugin.includes('manual-package@1.0.0'));
        const replay=await ask(worker,{type:'request',action:'create',input});assert.equal(replay.id,second.id);assert.equal(replay.result.version,2);
        return {buildId:second.id,nativeId:second.result.catalogId,version:2,source:await sourceProof(second.result,input.source),previousSourceAndPackagePreserved:true,replaySameJob:true};
    });
    await fixture.check('Explicit historical project pin reinstalls version1 without a new build or loss of manual configuration',async()=>{
        const before=Number((await pool.query('SELECT count(*)::int AS count FROM tool_build_jobs')).rows[0].count);
        await projectAssets.pin(projectId,first.result.catalogId,'plugin',actor.email,{version:1,expectedVersion:2,expectedManifest:secondPackage.manifest.sha256});
        const historical=checkedProjectPackage(await projectPin(first.result.catalogId));
        assert.equal(historical.manifest.sha256,firstPackage.manifest.sha256);
        const restored=await ask(installer,{type:'install',credentials,job,pkg:historical});
        assert.deepEqual(restored.hookOutput,['A']);assert.equal(restored.result.version,1);
        assert.deepEqual(restored.config.mcp.manual,{type:'local',command:['node','manual.js']});assert.ok(restored.config.plugin.includes('manual-package@1.0.0'));
        assert.equal((await packageFor(first.result.catalogId,2)).manifest.sha256,secondPackage.manifest.sha256);
        const head=(await pool.query('SELECT version FROM ai_plugins WHERE id=$1',[first.result.catalogId])).rows[0];
        assert.equal(Number(head.version),2,'Changing the project pin must not downgrade the global catalog head');
        assert.deepEqual(await activeOrigins(first.result.catalogId),secondOrigins,'Project rollback must not change the active source head');
        assert.equal(Number((await pool.query('SELECT count(*)::int AS count FROM tool_build_jobs')).rows[0].count),before);
        return {installedVersion:1,globalVersion:Number(head.version),activeSourceHeadPreserved:true,noNewBuild:true,oldSource:await sourceProof(first.result,firstInput.source)};
    });
    receipt.runtimeRequests=requests;
}catch(error){fatal=error;receipt.failures.push({name:'Actual JS roundtrip',message:error.message,stack:error.stack});}
finally{
    try{discoverOwnedProcesses();}catch(error){fatal??=error;receipt.failures.push({name:'Owned process inventory',message:error.message});}
    for(const worker of workers)if(worker.child.connected)worker.child.send({type:'stop'});
    try{
        if(!await waitOwnedStopped(10000)){
            signalOwnedGroups('SIGTERM');
            if(!await waitOwnedStopped(2000)){signalOwnedGroups('SIGKILL');assert.ok(await waitOwnedStopped(8000),'Owned process groups must be reaped');}
            receipt.failures.push({name:'Owned process cleanup',message:'Graceful stop deadline required owned-group termination'});
        }
        for(const worker of workers)await deadline(worker.closed,'Owned child reaped',2000);
    }catch(error){fatal??=error;receipt.failures.push({name:'Owned process cleanup',message:error.message});}
    receipt.workerLogs=workers.map(worker=>({pid:worker.child.pid,lines:worker.logs.join('').slice(-15000)}));
    receipt.observedOwnedPids=[...knownProcesses.keys()];receipt.remainingOwnedPids=[...knownProcesses.keys()].filter(alive);
    receipt.allOwnedProcessesExited=receipt.remainingOwnedPids.length===0;
    if(!receipt.allOwnedProcessesExited){const error=Error('Observed process identity remains unresolved after cleanup');fatal??=error;receipt.failures.push({name:'Owned process cleanup',message:error.message});}
    await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
    try{receipt.sourceStable=JSON.stringify(inputHashes)===JSON.stringify(await hashes());assert.ok(receipt.sourceStable,'QA inputs changed during actual acceptance');}
    catch(error){fatal??=error;receipt.failures.push({name:'QA source stability',message:error.message});}
    await fixture.close();
}
console.log(JSON.stringify({ok:receipt.ok,checks:receipt.checks.length,receipt:path.join(folder,'receipt.json')}));
if(fatal||!receipt.ok)process.exitCode=1;
