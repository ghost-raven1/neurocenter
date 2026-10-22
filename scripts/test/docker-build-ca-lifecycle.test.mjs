import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {rootCertificates} from 'node:tls';
import {withDockerBuildCa} from '../workspace/docker-build-ca.mjs';

const helper=new URL('../workspace/docker-build-ca.mjs',import.meta.url).href;
const contexts=['docker/build-ca','frontend/docker/build-ca'];
const certificates=new X509Certificate(rootCertificates[0]).toString()+'\n';
const proofs=[];
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

/** All artifacts, participants and failures belong to this isolated filesystem fixture. */
async function fixture(t){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-ca-lifecycle-'))),processes=[];
    t.after(async()=>{
        assert.ok(processes.every(child=>child.exited),'All owned participants must exit before fixture cleanup');
        await fs.rm(directory,{recursive:true,force:true});proofs.push({directory,processes,removed:await fs.stat(directory).then(()=>false,error=>error.code==='ENOENT')});
        if(process.env.DOCKER_BUILD_CA_TEST_EVIDENCE)await fs.writeFile(process.env.DOCKER_BUILD_CA_TEST_EVIDENCE,JSON.stringify(proofs,null,2)+'\n');
    });
    for(const context of contexts)await fs.mkdir(path.join(directory,context),{recursive:true});
    const ca=path.join(directory,'public.pem');await fs.writeFile(ca,certificates);
    return{directory,processes,ca,environment:{NEUROCENTER_BUILD_CA_FILE:ca},files:contexts.map(context=>path.join(directory,context,'extra.pem'))};
}
const paths=(f,name)=>contexts.map(context=>path.join(f.directory,context,name));
async function selectedFiles(f,environment,expected=certificates){
    assert.match(environment.NEUROCENTER_BUILD_CA_NAME,/^ca-[a-f0-9-]{36}\.pem$/);
    for(const file of paths(f,environment.NEUROCENTER_BUILD_CA_NAME))assert.equal(await fs.readFile(file,'utf8'),expected);
}
async function absent(f,name){for(const file of paths(f,name))await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
async function noGenerated(f){for(const context of contexts)assert.deepEqual((await fs.readdir(path.join(f.directory,context))).filter(name=>/^ca-.*\.pem$/.test(name)),[]);}

async function participant(f,ca=f.ca){
    const code="import {withDockerBuildCa} from "+JSON.stringify(helper)+";"+
        "try{await withDockerBuildCa(process.argv[1],{NEUROCENTER_BUILD_CA_FILE:process.argv[2]},async({environment})=>{process.send({ready:true,environment});await new Promise(resolve=>process.once('message',resolve));});process.send({done:true});}catch(error){process.send({error:error.message});process.exitCode=1;}process.disconnect();";
    const child=spawn(process.execPath,['--input-type=module','-e',code,f.directory,ca],{stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});const record={pid:child.pid,exited:false};f.processes.push(record);
    const exited=once(child,'exit');exited.then(([code,signal])=>Object.assign(record,{exited:true,code,signal}));
    let first;
    try{first=await Promise.race([once(child,'message').then(([message])=>message),exited.then(([status])=>({exit:status,stderr})),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Owned CA participant did not reply')),5000);timer.unref();})]);}
    catch(error){child.kill('SIGKILL');await exited;throw error;}
    return{child,first,exited,async stop(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}};
}

for(const kind of ['empty','garbage','private-key','directory','symlink'])test('Unique CA selection ignores and preserves an untrusted legacy extra.pem: '+kind,async t=>{
    const f=await fixture(t),target=path.join(f.directory,'private-target');await fs.writeFile(target,'never send private target to Docker');
    for(const file of f.files){
        if(kind==='directory')await fs.mkdir(file);
        else if(kind==='symlink')await fs.symlink(target,file);
        else await fs.writeFile(file,kind==='empty'?'':kind==='private-key'?'-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n':'invalid old CA bytes');
    }
    const before=await Promise.all(f.files.map(file=>fs.lstat(file)));let called=false,name;
    await withDockerBuildCa(f.directory,f.environment,async({environment,args})=>{
        called=true;name=environment.NEUROCENTER_BUILD_CA_NAME;await selectedFiles(f,environment);
        assert.deepEqual(args,['--build-arg','NEUROCENTER_BUILD_CA_SHA256='+environment.NEUROCENTER_BUILD_CA_SHA256,'--build-arg','NEUROCENTER_BUILD_CA_NAME='+name]);
    });
    assert.equal(called,true);for(let index=0;index<f.files.length;index++){const after=await fs.lstat(f.files[index]);assert.equal(after.ino,before[index].ino);assert.equal(after.dev,before[index].dev);}
    assert.equal(await fs.readFile(target,'utf8'),'never send private target to Docker');await absent(f,name);
});

test('Legacy lock records and an exact old public CA are irrelevant and remain byte-for-byte untouched',async t=>{
    const f=await fixture(t),lock=path.join(f.directory,'.run/docker-build-ca.lock');await fs.mkdir(lock,{recursive:true});
    const owner=path.join(lock,'owner-123456-abandoned.json');await fs.writeFile(owner,'unconfirmed legacy owner');
    for(const file of f.files)await fs.writeFile(file,certificates);const original=await Promise.all(f.files.map(file=>fs.stat(file)));
    let name;await withDockerBuildCa(f.directory,f.environment,async({environment})=>{name=environment.NEUROCENTER_BUILD_CA_NAME;await selectedFiles(f,environment);});
    await absent(f,name);assert.equal(await fs.readFile(owner,'utf8'),'unconfirmed legacy owner');
    for(let index=0;index<f.files.length;index++){assert.equal(await fs.readFile(f.files[index],'utf8'),certificates);assert.equal((await fs.stat(f.files[index])).ino,original[index].ino);}
});

for(const different of [false,true])test('Nested invocations own independent files and preserve the outer selected CA; different='+different,async t=>{
    const f=await fixture(t),other=path.join(f.directory,'other.pem'),otherBytes=new X509Certificate(rootCertificates[1]).toString()+'\n';await fs.writeFile(other,otherBytes);
    const alias=path.join(f.directory,'alias');await fs.symlink(f.directory,alias);let outer,inner;
    await withDockerBuildCa(f.directory,f.environment,async({environment})=>{
        outer=environment;await selectedFiles(f,outer);
        await assert.rejects(withDockerBuildCa(alias,{NEUROCENTER_BUILD_CA_FILE:different?other:f.ca},async({environment})=>{
            inner=environment;assert.notEqual(inner.NEUROCENTER_BUILD_CA_NAME,outer.NEUROCENTER_BUILD_CA_NAME);await selectedFiles(f,inner,different?otherBytes:certificates);await selectedFiles(f,outer);throw Error('nested failure');
        }),/nested failure/);
        await absent(f,inner.NEUROCENTER_BUILD_CA_NAME);await selectedFiles(f,outer);
    });await absent(f,outer.NEUROCENTER_BUILD_CA_NAME);
});

test('Concurrent different-CA actions never clean each other up',async t=>{
    const f=await fixture(t),other=path.join(f.directory,'other.pem'),otherBytes=new X509Certificate(rootCertificates[1]).toString()+'\n';await fs.writeFile(other,otherBytes);
    const entered=gate(),release=gate();let second,firstEnv,secondEnv;
    try{
        await withDockerBuildCa(f.directory,f.environment,async({environment})=>{
            firstEnv=environment;
            second=withDockerBuildCa(f.directory,{NEUROCENTER_BUILD_CA_FILE:other},async({environment})=>{secondEnv=environment;entered.resolve();await release.promise;await selectedFiles(f,secondEnv,otherBytes);});
            await Promise.race([entered.promise,second]);await entered.promise;await selectedFiles(f,firstEnv);await selectedFiles(f,secondEnv,otherBytes);
        });
        await absent(f,firstEnv.NEUROCENTER_BUILD_CA_NAME);await selectedFiles(f,secondEnv,otherBytes);
    }finally{release.resolve();await second;}
    assert.notEqual(firstEnv.NEUROCENTER_BUILD_CA_NAME,secondEnv.NEUROCENTER_BUILD_CA_NAME);await noGenerated(f);
});

test('Independent different-CA processes can build concurrently and clean only their selected files',{timeout:15000},async t=>{
    const f=await fixture(t),other=path.join(f.directory,'other.pem'),otherBytes=new X509Certificate(rootCertificates[1]).toString()+'\n';await fs.writeFile(other,otherBytes);
    const first=await participant(f);let second;
    try{
        assert.equal(first.first.ready,true);second=await participant(f,other);assert.equal(second.first.ready,true);
        await selectedFiles(f,first.first.environment);await selectedFiles(f,second.first.environment,otherBytes);
        assert.notEqual(first.first.environment.NEUROCENTER_BUILD_CA_NAME,second.first.environment.NEUROCENTER_BUILD_CA_NAME);
        first.child.send('finish');assert.deepEqual(await first.exited,[0,null]);await absent(f,first.first.environment.NEUROCENTER_BUILD_CA_NAME);await selectedFiles(f,second.first.environment,otherBytes);
        second.child.send('finish');assert.deepEqual(await second.exited,[0,null]);await noGenerated(f);
    }finally{await first.stop();await second?.stop();}
});

test('An interrupted process leaves public files that cannot block the next fresh invocation',{timeout:15000},async t=>{
    const f=await fixture(t),first=await participant(f);let retry;
    try{
        assert.equal(first.first.ready,true);await first.stop();const before=await Promise.all(paths(f,first.first.environment.NEUROCENTER_BUILD_CA_NAME).map(file=>fs.stat(file)));
        await withDockerBuildCa(f.directory,f.environment,async({environment})=>{retry=environment;assert.notEqual(retry.NEUROCENTER_BUILD_CA_NAME,first.first.environment.NEUROCENTER_BUILD_CA_NAME);await selectedFiles(f,retry);});
        await absent(f,retry.NEUROCENTER_BUILD_CA_NAME);await selectedFiles(f,first.first.environment);
        for(let index=0;index<before.length;index++)assert.equal((await fs.stat(paths(f,first.first.environment.NEUROCENTER_BUILD_CA_NAME)[index])).ino,before[index].ino);
    }finally{await first.stop();}
});

test('Context ancestor symlinks refuse before action while a symlinked legacy .run is never consulted',async t=>{
    for(const relative of ['.run','frontend']){
        const f=await fixture(t),target=path.join(f.directory,'foreign');await fs.mkdir(target);await fs.writeFile(path.join(target,'sentinel'),'keep');
        await fs.rm(path.join(f.directory,relative),{recursive:true,force:true});await fs.symlink(target,path.join(f.directory,relative));
        if(relative==='.run')await withDockerBuildCa(f.directory,f.environment,async({environment})=>selectedFiles(f,environment));
        else await assert.rejects(withDockerBuildCa(f.directory,f.environment,()=>assert.fail('Symlink must not admit an action')),/ссылкой/);
        assert.equal(await fs.readFile(path.join(target,'sentinel'),'utf8'),'keep');assert.deepEqual(await fs.readdir(target),['sentinel']);
        assert.deepEqual((await fs.readdir(path.join(f.directory,contexts[0]))).filter(name=>/^ca-/.test(name)),[]);
    }
});

test('A foreign file swapped in while cleanup reads its owned descriptor survives',async t=>{
    const f=await fixture(t),saved=path.join(f.directory,'owned-original.pem'),open=fs.open;let cleanup=false,swapped=false,filename,name;
    const mocked=t.mock.method(fs,'open',async(file,...args)=>{
        const handle=await open(file,...args);
        if(file===filename&&cleanup){const read=handle.read.bind(handle);handle.read=async(...values)=>{const result=await read(...values);if(!swapped){swapped=true;await fs.rename(filename,saved);await fs.writeFile(filename,'foreign replacement during read');}return result;};}
        return handle;
    });
    syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
    await withDockerBuildCa(f.directory,f.environment,({environment})=>{name=environment.NEUROCENTER_BUILD_CA_NAME;filename=paths(f,name)[0];cleanup=true;});
    assert.equal(swapped,true);assert.equal(await fs.readFile(filename,'utf8'),'foreign replacement during read');assert.equal(await fs.readFile(saved,'utf8'),certificates);
    await assert.rejects(fs.stat(paths(f,name)[1]),{code:'ENOENT'});
});

test('A new action can finish while an unrelated invocation is still cleaning up',async t=>{
    const f=await fixture(t),open=fs.open,entered=gate(),release=gate();let filename,held=false,firstName,secondName;
    const mocked=t.mock.method(fs,'open',async(file,...args)=>{
        const handle=await open(file,...args);if(file===filename){const read=handle.read.bind(handle);handle.read=async(...values)=>{if(!held){held=true;entered.resolve();await release.promise;}return read(...values);};}return handle;
    });
    syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
    const first=withDockerBuildCa(f.directory,f.environment,({environment})=>{firstName=environment.NEUROCENTER_BUILD_CA_NAME;filename=paths(f,firstName)[0];});
    try{
        await entered.promise;await withDockerBuildCa(f.directory,f.environment,async({environment})=>{secondName=environment.NEUROCENTER_BUILD_CA_NAME;assert.notEqual(secondName,firstName);await selectedFiles(f,environment);});
        await absent(f,secondName);
    }finally{release.resolve();await first;}
    await absent(f,firstName);
});

test('A partial write is removed before action while its original filesystem error survives',async t=>{
    const f=await fixture(t),open=fs.open,failure=Object.assign(Error('owned partial write'),{code:'ENOSPC'});let injected=false,called=false;
    const mocked=t.mock.method(fs,'open',async(file,...args)=>{
        const handle=await open(file,...args);
        if(!injected&&path.dirname(file)===path.join(f.directory,contexts[0])&&String(args[0])==='wx'){injected=true;const write=handle.writeFile.bind(handle);handle.writeFile=async bytes=>{await write(bytes.subarray(0,32));throw failure;};}
        return handle;
    });
    syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
    await assert.rejects(withDockerBuildCa(f.directory,f.environment,()=>{called=true;}),error=>error===failure);assert.equal(injected,true);assert.equal(called,false);await noGenerated(f);
});

for(const primary of [false,true])test('Cleanup failures are visible, continue for the second file and preserve primary identity='+primary,async t=>{
    const f=await fixture(t),rm=fs.rm,failure=Error('owned Docker failure');let filename,name,injected=false;
    const mocked=t.mock.method(fs,'rm',async(file,...args)=>{if(file===filename&&!injected){injected=true;throw Object.assign(Error('owned cleanup denied'),{code:'EACCES'});}return rm(file,...args);});
    syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
    await assert.rejects(withDockerBuildCa(f.directory,f.environment,({environment})=>{name=environment.NEUROCENTER_BUILD_CA_NAME;filename=paths(f,name)[0];if(primary)throw failure;}),error=>{
        assert.equal(injected,true);assert.ok(error.message.includes(filename));if(primary){assert.equal(error,failure);assert.ok(error.cleanupError instanceof Error);}return true;
    });
    assert.equal(await fs.readFile(filename,'utf8'),certificates);await assert.rejects(fs.stat(paths(f,name)[1]),{code:'ENOENT'});
});
