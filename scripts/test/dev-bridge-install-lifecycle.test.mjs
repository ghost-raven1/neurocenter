import {test,mock,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fixture,update,unchanged,version} from './dev-bridge-install.fixture.mjs';

const exec=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const nativeEvidence={markers:[],signals:[]};
after(async()=>{if(process.env.DEV_BRIDGE_LIFECYCLE_EVIDENCE)await fs.writeFile(process.env.DEV_BRIDGE_LIFECYCLE_EVIDENCE,JSON.stringify(nativeEvidence,null,2)+'\n',{mode:0o600});});
async function workerMarker(f,pid){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
        try{const value=JSON.parse(await fs.readFile(path.join(f.state,'worker-version.json'),'utf8'));if((!pid||value.pid===pid)&&(await fs.readFile(path.join(f.state,'worker.lock'),'utf8'))===String(value.pid)){nativeEvidence.markers.push({pid:value.pid,home:value.fixtureHome,cwd:value.fixtureCwd,state:f.state,entry:path.join(f.install,'dist/index.js')});return value;}}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await sleep(20);
    }
    throw Error('Controlled fixture worker did not publish its owned marker.');
}
async function stopFixtureWorker(f,pid){
    if(!pid)return;
    let command;try{command=(await exec('ps',['-p',String(pid),'-o','uid=','-o','args='],{timeout:2000})).stdout.trim();}catch(error){if(error.code===1){nativeEvidence.signals.push({pid,alreadyExited:true});return;}throw error;}
    assert.ok(command.startsWith(String(process.getuid())+' '),command);
    assert.ok(command.endsWith(path.join(f.install,'dist/index.js')+' --worker'),command);
    const receipt={pid,uid:process.getuid(),command,home:f.home,signal:'SIGTERM',terminated:false};nativeEvidence.signals.push(receipt);
    process.kill(pid,'SIGTERM');const deadline=Date.now()+3000;
    while(Date.now()<deadline){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){receipt.terminated=true;return;}throw error;}await sleep(20);}
    process.kill(pid,'SIGKILL');throw Error('Owned fixture worker required force termination: '+pid);
}
async function installNativeOld(f){
    await fs.cp(f.content,f.install,{recursive:true});await fs.writeFile(path.join(f.install,'dist/build.json'),JSON.stringify({version,buildId:'a'.repeat(64)}));
}
async function nativeOldWorker(f){
    await installNativeOld(f);
    const child=spawn(process.execPath,[path.join(f.install,'dist/index.js'),'--worker'],{env:{...f.environment,...f.entry.environment},stdio:'ignore'});
    child.once('error',()=>{});await workerMarker(f,child.pid);return child;
}

test('Post-swap lstat failure restores old runtime before reporting EIO',async()=>fixture(async f=>{
    const rename=fs.rename,lstat=fs.lstat;let swapped=false;
    const r=mock.method(fs,'rename',async(from,to)=>{const result=await rename(from,to);if(String(from).endsWith('/package')&&to===f.install)swapped=true;return result;});
    const l=mock.method(fs,'lstat',async(file,...args)=>{if(swapped&&file===f.install){swapped=false;throw Object.assign(Error('post-swap EIO'),{code:'EIO'});}return lstat(file,...args);});
    try{await assert.rejects(update(f),{code:'EIO'});await unchanged(f);}finally{r.mock.restore();l.mock.restore();}
}));
test('Owner wx collision preserves a pre-existing owner file and its directory',async()=>fixture(async f=>{
    const mkdir=fs.mkdir,lock=f.install+'.install-lock',owner=lock+'/owner.pid';
    const stub=mock.method(fs,'mkdir',async(file,...args)=>{const result=await mkdir(file,...args);if(file===lock)await fs.writeFile(owner,'foreign-owner',{flag:'wx'});return result;});
    try{await assert.rejects(update(f),{code:'EEXIST'});assert.equal(await fs.readFile(owner,'utf8'),'foreign-owner');await unchanged(f);}finally{stub.mock.restore();}
}));
test('Failure of the first rename retains old runtime without reporting a nonexistent previous package',async()=>fixture(async f=>{
    const rename=fs.rename,stub=mock.method(fs,'rename',async(from,to)=>{if(from===f.install&&String(to).endsWith('/previous'))throw Object.assign(Error('old rename denied'),{code:'EACCES'});return rename(from,to);});
    try{await assert.rejects(update(f),error=>{assert.equal(error.code,'EACCES');assert.equal(error.recoveryDirectory,undefined);return true;});await unchanged(f);}finally{stub.mock.restore();}
}));
test('Lost prepare ACK after an actual owned worker stops resumes queue and restores that worker',async()=>fixture(async f=>{
    const old=await nativeOldWorker(f),run=f.dependencies.runCommand;let resumed=false,prepares=0;
    f.dependencies.runCommand=async(...args)=>{if(args[1][1]==='--prepare-upgrade'&&++prepares===1){await stopFixtureWorker(f,old.pid);throw Error('prepare ACK lost after owned stop');}if(args[1][1]==='--finish-upgrade')resumed=true;return run(...args);};
    delete f.dependencies.startWorker;
    try{await assert.rejects(update(f),/prepare ACK lost/);assert.equal(resumed,true);const worker=await workerMarker(f);assert.notEqual(worker.pid,old.pid);assert.equal(worker.buildId,'a'.repeat(64));assert.equal(worker.fixtureHome,f.home);assert.equal(worker.fixtureCwd,process.cwd());}
    finally{let current;try{current=JSON.parse(await fs.readFile(path.join(f.state,'worker-version.json'),'utf8')).pid;}catch{}await stopFixtureWorker(f,current);await stopFixtureWorker(f,old.pid);}
}));
test('Default detached starter confirms an actual fixture child in isolated HOME without network',async()=>fixture(async f=>{
    delete f.dependencies.startWorker;let pid;
    try{const result=await update(f),worker=await workerMarker(f);pid=worker.pid;assert.equal(result.workerRestarted,true);assert.equal(worker.buildId,f.buildId);assert.equal(worker.fixtureHome,f.home);assert.equal(worker.fixtureCwd,process.cwd());process.kill(pid,0);}
    finally{if(!pid)try{pid=JSON.parse(await fs.readFile(path.join(f.state,'worker-version.json'),'utf8')).pid;}catch{}await stopFixtureWorker(f,pid);}
}));
test('Default starter observes real new-child exit and restarts only the restored old runtime',async()=>fixture(async f=>{
    await installNativeOld(f);f.environment.BRIDGE_FIXTURE_EXIT_BUILD=f.buildId;delete f.dependencies.startWorker;let pid;
    try{await assert.rejects(update(f),/завершился до подтверждения/);const worker=await workerMarker(f);pid=worker.pid;assert.equal(worker.buildId,'a'.repeat(64));assert.equal(worker.fixtureHome,f.home);assert.equal(await fs.readFile(path.join(f.install,'keep.txt'),'utf8'),'old runtime');}
    finally{if(!pid)try{pid=JSON.parse(await fs.readFile(path.join(f.state,'worker-version.json'),'utf8')).pid;}catch{}await stopFixtureWorker(f,pid);}
}));
test('Unknown prepare ACK never starts a duplicate while the original owned native worker is alive',async()=>fixture(async f=>{
    const old=await nativeOldWorker(f),run=f.dependencies.runCommand;
    f.dependencies.runCommand=async(...args)=>args[1][1]==='--prepare-upgrade'?Promise.reject(Error('ACK lost before owned stop')):run(...args);delete f.dependencies.startWorker;
    try{await assert.rejects(update(f),/ACK lost before owned stop/);const worker=await workerMarker(f,old.pid);assert.equal(worker.pid,old.pid);process.kill(old.pid,0);}
    finally{await stopFixtureWorker(f,old.pid);}
}));
test('Native spawn ENOENT cannot report success and rollback starts the old bundled runtime',async()=>fixture(async f=>{
    await installNativeOld(f);const run=f.dependencies.runCommand;let first=true,pid;delete f.dependencies.startWorker;
    f.dependencies.runCommand=async(...args)=>{const result=await run(...args);if(first&&args[1][1]==='--finish-upgrade'){first=false;await fs.unlink(path.join(f.install,'bin',process.platform==='win32'?'node.exe':'node'));}return result;};
    try{await assert.rejects(update(f),/завершился до подтверждения/);const worker=await workerMarker(f);pid=worker.pid;assert.equal(worker.buildId,'a'.repeat(64));assert.equal(worker.fixtureHome,f.home);}
    finally{if(!pid)try{pid=JSON.parse(await fs.readFile(path.join(f.state,'worker-version.json'),'utf8')).pid;}catch{}await stopFixtureWorker(f,pid);}
}));
