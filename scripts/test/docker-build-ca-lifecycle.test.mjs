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
import {pathToFileURL} from 'node:url';
import {withDockerBuildCa} from '../workspace/docker-build-ca.mjs';

const helper=new URL('../workspace/docker-build-ca.mjs',import.meta.url).href;
const contexts=['docker/build-ca','frontend/docker/build-ca'];
const certificates=new X509Certificate(rootCertificates[0]).toString()+'\n';
const proofs=[];

/** Real filesystem and independently controlled Node processes, without any Docker or user profile. */
async function fixture(t){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-ca-lifecycle-')));
    const processes=[];
    t.after(async()=>{assert.ok(processes.every(child=>child.exited),'All owned participants must exit before fixture cleanup');await fs.rm(directory,{recursive:true,force:true});proofs.push({directory,processes,removed:await fs.stat(directory).then(()=>false,error=>error.code==='ENOENT')});if(process.env.DOCKER_BUILD_CA_TEST_EVIDENCE)await fs.writeFile(process.env.DOCKER_BUILD_CA_TEST_EVIDENCE,JSON.stringify(proofs,null,2)+'\n');});
    for(const context of contexts)await fs.mkdir(path.join(directory,context),{recursive:true});
    const ca=path.join(directory,'public.pem');await fs.writeFile(ca,certificates);
    return{directory,processes,environment:{NEUROCENTER_BUILD_CA_FILE:ca},files:contexts.map(context=>path.join(directory,context,'extra.pem'))};
}
async function exactFiles(f){for(const file of f.files)assert.equal(await fs.readFile(file,'utf8'),certificates);}
async function absentFiles(f){for(const file of f.files)await assert.rejects(fs.stat(file),{code:'ENOENT'});}
function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

async function participant(f,module=helper){
    const code=module===null?`import fs from 'node:fs/promises';import path from 'node:path';
        const bytes=await fs.readFile(process.argv[2]);for(const context of ['docker/build-ca','frontend/docker/build-ca'])await fs.writeFile(path.join(process.argv[1],context,'extra.pem'),bytes,{flag:'wx'});
        process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));process.disconnect();`
        :`import {withDockerBuildCa} from ${JSON.stringify(module)};
        try {await withDockerBuildCa(process.argv[1],{NEUROCENTER_BUILD_CA_FILE:process.argv[2]},async()=>{
            process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));
        });process.send({done:true});} catch(error){process.send({error:error.message});process.exitCode=1;}
        process.disconnect();`;
    const child=spawn(process.execPath,['--input-type=module','-e',code,f.directory,f.environment.NEUROCENTER_BUILD_CA_FILE],{stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    const record={pid:child.pid,exited:false};f.processes.push(record);
    const exited=once(child,'exit');exited.then(([code,signal])=>{Object.assign(record,{exited:true,code,signal});});
    let first;try{first=await Promise.race([once(child,'message').then(([message])=>message),exited.then(([status])=>({exit:status,stderr})),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Owned CA participant did not reply')),5000);timer.unref();})]);}
    catch(error){child.kill('SIGKILL');await exited;throw error;}
    return{child,first,exited,async stop(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}};
}

test('Exact public CA left by a previous builder can be reused without replacing or deleting its files',async t=>{
    const f=await fixture(t);for(const file of f.files)await fs.writeFile(file,certificates);
    const before=await Promise.all(f.files.map(file=>fs.stat(file)));
    let called=false;await withDockerBuildCa(f.directory,f.environment,async()=>{called=true;await exactFiles(f);});
    assert.equal(called,true,'An exact verified CA left by interruption must not block the next action');
    await exactFiles(f);
    for(let i=0;i<f.files.length;i++){const after=await fs.stat(f.files[i]);assert.equal(after.ino,before[i].ino);assert.equal(after.dev,before[i].dev);}
});

test('An interrupted unleased builder leaves exact public bytes reusable by the next action',{timeout:15000},async t=>{
    const f=await fixture(t),legacy=process.env.DOCKER_BUILD_CA_LEGACY_HELPER,first=await participant(f,legacy?pathToFileURL(legacy).href:null);
    try{
        assert.deepEqual(first.first,{ready:true});await exactFiles(f);await first.stop();
        const before=await Promise.all(f.files.map(file=>fs.stat(file)));let called=false;
        await withDockerBuildCa(f.directory,f.environment,async()=>{called=true;await exactFiles(f);});assert.equal(called,true);
        for(let i=0;i<f.files.length;i++)assert.equal((await fs.stat(f.files[i])).ino,before[i].ino);await exactFiles(f);
    }finally{await first.stop();}
});

test('An interrupted leased builder is refused with its exact path and PID, without evicting its files',{timeout:15000},async t=>{
    const f=await fixture(t),first=await participant(f);
    try{
        assert.deepEqual(first.first,{ready:true});await first.stop();let called=false;
        await assert.rejects(withDockerBuildCa(f.directory,f.environment,()=>{called=true;}),error=>error.message.includes(path.join(f.directory,'.run/docker-build-ca.lock'))&&error.message.includes('PID '+first.child.pid));
        assert.equal(called,false);await exactFiles(f);
    }finally{await first.stop();}
});

test('A malformed pre-existing lease refuses before staging and remains untouched',async t=>{
    const f=await fixture(t),lease=path.join(f.directory,'.run/docker-build-ca.lock');await fs.mkdir(lease,{recursive:true});await fs.writeFile(path.join(lease,'foreign'),'unknown owner');
    await assert.rejects(withDockerBuildCa(f.directory,f.environment,()=>assert.fail('Busy lease must not admit an action')),error=>error.message.includes(lease));
    assert.equal(await fs.readFile(path.join(lease,'foreign'),'utf8'),'unknown owner');await absentFiles(f);
});

test('Canonical root aliases share one same-CA lease and nested failure keeps the outer files',async t=>{
    const f=await fixture(t),alias=path.join(f.directory,'alias');await fs.symlink(f.directory,alias);
    await withDockerBuildCa(f.directory,f.environment,async()=>{
        await assert.rejects(withDockerBuildCa(alias,f.environment,()=>{throw Error('nested failure');}),/nested failure/);await exactFiles(f);
    });await absentFiles(f);
});

test('A second CA cannot replace the public bytes of an active same-process action',async t=>{
    const f=await fixture(t),other=path.join(f.directory,'other.pem');await fs.writeFile(other,rootCertificates[1]);
    await withDockerBuildCa(f.directory,f.environment,async()=>{
        await assert.rejects(withDockerBuildCa(f.directory,{NEUROCENTER_BUILD_CA_FILE:other},()=>assert.fail('Different CA must not run')),/другим CA/);await exactFiles(f);
    });await absentFiles(f);
});

test('Symlinked lease or context ancestors refuse before any action and preserve their targets',async t=>{
    for(const relative of ['.run','frontend']){
        const f=await fixture(t),target=path.join(f.directory,'foreign');await fs.mkdir(target);await fs.writeFile(path.join(target,'sentinel'),'keep');
        await fs.rm(path.join(f.directory,relative),{recursive:true,force:true});await fs.symlink(target,path.join(f.directory,relative));
        await assert.rejects(withDockerBuildCa(f.directory,f.environment,()=>assert.fail('Symlink must not admit an action')),/ссылкой/);
        assert.equal(await fs.readFile(path.join(target,'sentinel'),'utf8'),'keep');await assert.rejects(fs.stat(f.files[0]),{code:'ENOENT'});
    }
});

test('Changed lease ownership preserves its records and staged CA without replacing the primary failure',async t=>{
    const f=await fixture(t),failure=Error('Docker causal failure'),lease=path.join(f.directory,'.run/docker-build-ca.lock');let owner;
    await assert.rejects(withDockerBuildCa(f.directory,f.environment,async()=>{
        [owner]=await fs.readdir(lease);await fs.rm(path.join(lease,owner));await fs.writeFile(path.join(lease,owner),'foreign owner');throw failure;
    }),error=>error===failure);
    assert.match(failure.message,/Docker causal failure/);assert.ok(failure.message.includes(lease),'The CLI must expose retained cleanup state alongside the primary failure');assert.ok(failure.cleanupError instanceof Error);
    assert.equal(await fs.readFile(path.join(lease,owner),'utf8'),'foreign owner');await exactFiles(f);
});

test('A foreign file swapped in while cleanup reads its owned descriptor survives',async t=>{
    const f=await fixture(t),filename=f.files[0],saved=path.join(f.directory,'owned-original.pem'),open=fs.open;
    let cleanup=false,swapped=false;
    const mocked=t.mock.method(fs,'open',async(file,...args)=>{
        const handle=await open(file,...args);
        if(file===filename&&cleanup){
            const read=handle.read.bind(handle);
            handle.read=async(...values)=>{const result=await read(...values);if(!swapped){swapped=true;await fs.rename(filename,saved);await fs.writeFile(filename,'foreign replacement during read');}return result;};
        }
        return handle;
    });
    syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
    await withDockerBuildCa(f.directory,f.environment,()=>{cleanup=true;});
    assert.equal(swapped,true,'The replacement must occur inside the actual descriptor read');
    assert.equal(await fs.readFile(filename,'utf8'),'foreign replacement during read');assert.equal(await fs.readFile(saved,'utf8'),certificates);
    await assert.rejects(fs.stat(f.files[1]),{code:'ENOENT'});
});

test('A same-process action arriving during final cleanup waits for that lease instead of failing busy',async t=>{
    const f=await fixture(t),open=fs.open,realpath=fs.realpath,entered=gate(),release=gate(),secondResolved=gate();let cleanup=false,held=false,second,startingSecond=false;
    const mocked=t.mock.method(fs,'open',async(file,...args)=>{
        const handle=await open(file,...args);
        if(file===f.files[0]&&cleanup){const read=handle.read.bind(handle);handle.read=async(...values)=>{if(!held){held=true;entered.resolve();await release.promise;}return read(...values);};}
        return handle;
    });
    const resolved=t.mock.method(fs,'realpath',async(...args)=>{const result=await realpath(...args);if(startingSecond&&args[0]===f.directory)secondResolved.resolve();return result;});
    syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();resolved.mock.restore();syncBuiltinESMExports();});
    const first=withDockerBuildCa(f.directory,f.environment,()=>{cleanup=true;});await entered.promise;
    let called=false;startingSecond=true;second=withDockerBuildCa(f.directory,f.environment,()=>{called=true;});const outcome=second.then(()=>undefined,error=>error);
    try{await secondResolved.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal(called,false);}
    finally{release.resolve();await first;}
    assert.equal(await outcome,undefined);assert.equal(called,true);await absentFiles(f);
});

test('A nested same-CA action retains both files until its outer action completes',async t=>{
    const f=await fixture(t);
    await withDockerBuildCa(f.directory,f.environment,async()=>{
        await exactFiles(f);await withDockerBuildCa(f.directory,f.environment,()=>exactFiles(f));await exactFiles(f);
    });await absentFiles(f);
});

test('Concurrent same-CA actions cannot clean up while another admitted action still needs the files',async t=>{
    const f=await fixture(t),entered=gate(),release=gate();let second;
    try{
        await withDockerBuildCa(f.directory,f.environment,async()=>{
            second=withDockerBuildCa(f.directory,f.environment,async()=>{entered.resolve();await release.promise;await exactFiles(f);});
            await Promise.race([entered.promise,second]);await entered.promise;
        });await exactFiles(f);
    }finally{release.resolve();await second;}
    await absentFiles(f);
});

test('Independent callers refuse an active lease, preserving its files, then succeed after its release',{timeout:15000},async t=>{
    const f=await fixture(t),first=await participant(f);let second;
    try{
        assert.deepEqual(first.first,{ready:true});const before=await Promise.all(f.files.map(file=>fs.stat(file)));
        second=await participant(f);assert.match(second.first.error,/сборк/i);assert.deepEqual(await second.exited,[1,null]);await exactFiles(f);
        for(let i=0;i<f.files.length;i++)assert.equal((await fs.stat(f.files[i])).ino,before[i].ino);
        first.child.send('finish');assert.deepEqual(await first.exited,[0,null]);await absentFiles(f);
        second=await participant(f);assert.deepEqual(second.first,{ready:true});second.child.send('finish');assert.deepEqual(await second.exited,[0,null]);await absentFiles(f);
    }finally{await first.stop();await second?.stop();}
});
