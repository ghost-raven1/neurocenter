import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';

test('Missing paused boolean never permits runtime replacement or registration',()=>installerLifecycleFixture('missing-paused',async f=>{
    const result=await f.run({INSTALLER_FIXTURE_PREPARE:'{"ok":true}'});
    assert.notEqual(result.status,0,'An unconfirmed worker pause must refuse publication');
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.equal(f.state.paused,false,'An admitted pause must be compensated when its result is invalid');
}));
test('Lost prepare acknowledgement after real API pause resumes the queue and preserves the old runtime',()=>installerLifecycleFixture('lost-prepare-ack',async f=>{
    const result=await f.run({INSTALLER_FIXTURE_PREPARE:'lost'});
    assert.notEqual(result.status,0);
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.equal(f.state.paused,false,'The server pause must not survive a failed prepare acknowledgement');
    assert.equal(f.state.requests.filter(request=>request.route.endsWith('/worker/resume')).length,1);
}));

async function existingProfile(f){
    const config=path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc'),runtimeHome=path.join(f.root,'saved-runtime-home'),bridgeHome=path.join(f.root,'saved-bridge-state');
    const ca=path.join(f.root,'owned-ca.pem');await fs.writeFile(ca,'');
    const own={type:'local',enabled:false,command:[path.join(f.install,'bin/node'),path.join(f.install,'dist/index.js')],timeout:45000,environment:{NEUROCENTER_URL:f.origin,NEUROCENTER_API_URL:f.origin,HOME:runtimeHome,XDG_CONFIG_HOME:path.join(runtimeHome,'runtime-config'),NEUROCENTER_BRIDGE_HOME:bridgeHome,NODE_EXTRA_CA_CERTS:ca,HTTPS_PROXY:'http://127.0.0.1:1',CUSTOM_SETTING:'retain exact'}};
    const text='// Existing user profile\n'+JSON.stringify({agent:{existing:{mode:'subagent',description:'keep agent'}},model:'team/model',mcp:{other:{type:'remote',url:'https://other.example.test'},'neurocenter-asset-sync':own}},null,2)+'\n';
    await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,text);
    const namespace=createHash('sha256').update(f.origin).digest('hex').slice(0,20);await fs.mkdir(path.join(bridgeHome,namespace),{recursive:true});
    f.state.token='owned-fixture-token';await fs.writeFile(path.join(bridgeHome,namespace,'credentials.json'),JSON.stringify({token:f.state.token,deviceId:'paired-device'}));
    return{config,text,own,runtimeHome,bridgeHome};
}
test('Public update preserves exact disabled same-site JSONC entry and all other OpenCode agents',()=>installerLifecycleFixture('profile-preserved',async f=>{
    const saved=await existingProfile(f);f.state.token=undefined;const result=await f.run();assert.equal(result.status,0,result.stderr);
    assert.equal(await fs.readFile(saved.config,'utf8'),saved.text,'A still-valid registration needs no replacement');
}));
test('Public update uses saved runtime namespace and credentials while management keeps caller HOME',()=>installerLifecycleFixture('runtime-environment',async f=>{
    const saved=await existingProfile(f),result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    assert.equal(f.state.paused,false);assert.equal(f.state.requests.filter(r=>r.route.endsWith('/identity')).length,1);
    const contexts=(await fs.readFile(f.environment.INSTALLER_FIXTURE_CONTEXTS,'utf8')).trim().split('\n').map(JSON.parse);
    for(const item of contexts.filter(row=>['--prepare-upgrade','--finish-upgrade','--connect-open'].includes(row.mode))){assert.equal(item.home,saved.runtimeHome);assert.equal(item.bridgeHome,saved.bridgeHome);assert.equal(item.ca,saved.own.environment.NODE_EXTRA_CA_CERTS);assert.equal(item.proxy,saved.own.environment.HTTPS_PROXY);}
    const management=contexts.find(row=>row.mode==='--install-command');assert.equal(management.home,f.home);assert.equal(management.xdg,f.environment.XDG_CONFIG_HOME);
    assert.equal(await fs.readFile(path.join(f.home,'.local/bin/neurocenter-bridge'),'utf8'),'owned caller launcher');await assert.rejects(fs.stat(path.join(saved.runtimeHome,'.local/bin/neurocenter-bridge')),{code:'ENOENT'});
    assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);
}));

test('Failed registration restores and restarts the actual owned previous worker after resuming its queue',()=>installerLifecycleFixture('rollback-worker',async f=>{
    const worker=await f.startWorker(),result=await f.run({INSTALLER_FIXTURE_NATIVE_UPGRADE:'1',INSTALLER_FIXTURE_INIT_FAIL:'1'});
    assert.notEqual(result.status,0);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');assert.equal(f.state.paused,false);
    const deadline=Date.now()+2500;let marker;
    while(Date.now()<deadline){marker=await fs.readFile(path.join(worker.directory,'worker-version.json'),'utf8').then(JSON.parse,()=>undefined);if(marker?.pid!==worker.pid&&marker?.version==='0.9.17')break;await new Promise(r=>setTimeout(r,25));}
    if(marker?.pid!==worker.pid&&marker?.pid)f.state.workers.push({pid:marker.pid,entry:path.join(f.install,'dist/index.js')});
    assert.ok(marker?.pid!==worker.pid,'Returning old bytes must also restore the worker stopped by preparation');process.kill(marker.pid,0);assert.equal(await fs.readFile(path.join(worker.directory,'worker.lock'),'utf8'),String(marker.pid));
}));

test('A fresh public installation registers the caller config without pausing an absent previous runtime',()=>installerLifecycleFixture('fresh-install',async f=>{
    await fs.rm(f.install,{recursive:true});const result=await f.run();assert.equal(result.status,0,result.stderr);
    const config=JSON.parse(await fs.readFile(path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc'),'utf8'));
    assert.equal(config.mcp['neurocenter-asset-sync'].enabled,true);assert.equal(config.mcp['neurocenter-asset-sync'].environment.NEUROCENTER_URL,f.origin);
    assert.equal(f.state.requests.filter(r=>r.method==='POST').length,0);
}));
for(const [label,change] of [
    ['invalid saved site',entry=>entry.environment.NEUROCENTER_URL='https://other.example.test/path'],
    ['foreign command',entry=>entry.command=['other-node','other-entry']],
    ['non-string environment',entry=>entry.environment.CUSTOM_SETTING=4],
    ['empty runtime HOME',entry=>entry.environment.HOME=''],
])test('Public update refuses '+label+' before queue pause or replacement',()=>installerLifecycleFixture('invalid-'+label,async f=>{
    const saved=await existingProfile(f),value=JSON.parse(saved.text.slice(saved.text.indexOf('{')));change(value.mcp['neurocenter-asset-sync']);const text=JSON.stringify(value);await fs.writeFile(saved.config,text);
    const result=await f.run();assert.notEqual(result.status,0);assert.equal(await fs.readFile(saved.config,'utf8'),text);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');assert.equal(f.state.requests.filter(r=>r.method==='POST').length,0);
}));
test('Duplicate own entries refuse publication instead of selecting the last JSONC value',()=>installerLifecycleFixture('duplicate-own',async f=>{
    const saved=await existingProfile(f),entry=JSON.stringify(saved.own),text='{"mcp":{"neurocenter-asset-sync":'+entry+',"neurocenter-asset-sync":'+entry+'}}';await fs.writeFile(saved.config,text);
    const result=await f.run();assert.notEqual(result.status,0);assert.equal(await fs.readFile(saved.config,'utf8'),text);assert.equal(f.state.requests.filter(r=>r.method==='POST').length,0);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
}));
test('A concurrent user config edit after queue pause survives and stops runtime publication',()=>installerLifecycleFixture('changed-config',async f=>{
    const saved=await existingProfile(f);f.state.token=undefined;const edit=saved.text+'// Concurrent user edit\n';f.state.onPause=()=>fs.writeFile(saved.config,edit);
    const result=await f.run();assert.notEqual(result.status,0);assert.equal(await fs.readFile(saved.config,'utf8'),edit);assert.equal(f.state.paused,false);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');assert.equal(f.state.requests.filter(r=>r.route.endsWith('/worker/resume')).length,1);
}));
test('A prepare refusal preserves the previous worker while conservatively compensating a possible pause',()=>installerLifecycleFixture('known-refusal',async f=>{
    const worker=await f.startWorker(),result=await f.run({INSTALLER_FIXTURE_PREPARE:'refused'});assert.notEqual(result.status,0);process.kill(worker.pid,0);
    assert.equal(await fs.readFile(path.join(worker.directory,'worker.lock'),'utf8'),String(worker.pid));assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');assert.equal(f.state.requests.filter(r=>r.route.endsWith('/worker/resume')).length,1);
}));
test('A lost real prepare ACK restarts only the proven stopped previous worker after compensation',()=>installerLifecycleFixture('lost-ack-owned-worker',async f=>{
    const worker=await f.startWorker(),result=await f.run({INSTALLER_FIXTURE_NATIVE_UPGRADE:'1',INSTALLER_FIXTURE_PREPARE:'lost'});assert.notEqual(result.status,0);assert.equal(f.state.paused,false);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    const deadline=Date.now()+2500;let marker;while(Date.now()<deadline){marker=await fs.readFile(path.join(worker.directory,'worker-version.json'),'utf8').then(JSON.parse,()=>undefined);if(marker?.pid!==worker.pid&&marker?.version==='0.9.17')break;await new Promise(r=>setTimeout(r,25));}
    assert.ok(marker?.pid!==worker.pid,'Lost ACK plus a proven stopped owner must not strand the previous worker');process.kill(marker.pid,0);assert.equal(await fs.readFile(path.join(worker.directory,'worker.lock'),'utf8'),String(marker.pid));
}));
test('Partial HTTP download preserves the installed runtime and a manual retry completes from a fresh archive',()=>installerLifecycleFixture('partial-download-retry',async f=>{
    f.state.archiveFailures=1;const first=await f.run();assert.notEqual(first.status,0);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');assert.equal(f.state.requests.filter(r=>r.method==='POST').length,0);
    assert.equal((await fs.readdir(path.dirname(f.install))).filter(name=>name.startsWith('.neurocenter-install.')).length,0);
    const retry=await f.run();assert.equal(retry.status,0,retry.stderr);assert.equal(JSON.parse(await fs.readFile(path.join(f.install,'package.json'),'utf8')).version,f.version);assert.equal(f.state.paused,false);
}));
test('Lost resume ACK retries compensation without replacing the retained disabled profile',()=>installerLifecycleFixture('lost-resume-ack',async f=>{
    const saved=await existingProfile(f);f.state.token=undefined;f.state.resumeFailures=1;const first=await f.run();assert.notEqual(first.status,0);assert.equal(f.state.paused,false);assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.equal(f.state.requests.filter(r=>r.route.endsWith('/worker/resume')).length,2);
    const retry=await f.run();assert.equal(retry.status,0,retry.stderr);assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.equal(f.state.paused,false);
}));
test('Two actual Bash installers serialize on the owned install lock',()=>installerLifecycleFixture('concurrent-installers',async f=>{
    let release,entered;const held=new Promise(resolve=>release=resolve),paused=new Promise(resolve=>entered=resolve);f.state.onPause=()=>{entered();return held;};
    const first=f.run();await paused;let second;try{second=await f.run();}finally{release();}const result=await first;
    assert.notEqual(second.status,0);assert.match(second.stderr,/Другая установка/);assert.equal(result.status,0,result.stderr);assert.equal(f.state.requests.filter(r=>r.route.endsWith('.tgz')).length,1);assert.equal(f.state.paused,false);
}));
test('An observed default JSON config disappearing during capture is a refusal, never a fresh registration',()=>installerLifecycleFixture('observed-config-disappeared',async f=>{
    const directory=path.join(f.environment.XDG_CONFIG_HOME,'opencode'),config=path.join(directory,'opencode.json');await fs.mkdir(directory,{recursive:true});await fs.writeFile(config,'{"agent":{"keep":{"mode":"subagent"}}}');
    const hook=path.join(f.root,'delete-observed-config.cjs'),marker=path.join(f.root,'deleted-once');
    await fs.writeFile(hook,`const fs=require('node:fs');const original=fs.realpathSync;fs.realpathSync=function(file,...args){const result=original.call(this,file,...args);if(file===${JSON.stringify(config)}&&new Error().stack.includes('context.cjs')&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'real deletion after realpath');fs.unlinkSync(file);}return result;};`);
    const result=await f.run({NODE_OPTIONS:'--require '+hook});assert.equal(await fs.readFile(marker,'utf8'),'real deletion after realpath');assert.notEqual(result.status,0,'A just-observed existing config is not an absent fresh config');
    await assert.rejects(fs.stat(config),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');assert.equal(f.state.requests.filter(r=>r.method==='POST').length,0);
}));

for(const part of ['entry','node','marker'])test('Rollback refuses automatic worker restart when previous '+part+' ownership proof changed',()=>installerLifecycleFixture('restart-refused-'+part,async f=>{
    const worker=await f.startWorker();
    if(part==='marker'){const file=path.join(worker.directory,'worker-version.json'),value=JSON.parse(await fs.readFile(file,'utf8'));value.buildId='e'.repeat(64);await fs.writeFile(file,JSON.stringify(value));}
    else f.state.onPause=()=>fs.appendFile(path.join(f.install,part==='entry'?'dist/index.js':'bin/node'),part==='entry'?'\n// Concurrent entry change\n':'\n# Concurrent node change\n');
    const result=await f.run({INSTALLER_FIXTURE_NATIVE_UPGRADE:'1',INSTALLER_FIXTURE_INIT_FAIL:'1'});assert.notEqual(result.status,0);assert.equal(f.state.paused,false);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.throws(()=>process.kill(worker.pid,0),error=>error.code==='ESRCH');await assert.rejects(fs.stat(path.join(worker.directory,'worker.lock')),{code:'ENOENT'});assert.equal(JSON.parse(await fs.readFile(path.join(worker.directory,'worker-version.json'),'utf8')).pid,worker.pid,'Unproven or changed old runtime must not be relaunched');
}));

test('A real failed prepare with a swallowed first resume error is compensated despite CLI ok:false',()=>installerLifecycleFixture('native-known-error-still-paused',async f=>{
    const worker=await f.startWorker();f.state.pauseReply={activeJobs:'invalid'};f.state.resumeRefusals=1;
    const result=await f.run({INSTALLER_FIXTURE_NATIVE_UPGRADE:'1'});assert.notEqual(result.status,0);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');process.kill(worker.pid,0);
    assert.equal(f.state.paused,false,'CLI ok:false does not certify that its own finally resumed the admitted pause');assert.equal(f.state.requests.filter(r=>r.route.endsWith('/worker/resume')).length,2);assert.equal(await fs.readFile(path.join(worker.directory,'worker.lock'),'utf8'),String(worker.pid));
}));

test('Saved runtime HOME also preserves pairing when no explicit bridge-state directory is configured',()=>installerLifecycleFixture('runtime-home-default-state',async f=>{
    const saved=await existingProfile(f),value=JSON.parse(saved.text.slice(saved.text.indexOf('{')));delete value.mcp['neurocenter-asset-sync'].environment.NEUROCENTER_BRIDGE_HOME;
    const text=JSON.stringify(value);await fs.writeFile(saved.config,text);const namespace=createHash('sha256').update(f.origin).digest('hex').slice(0,20),directory=path.join(saved.runtimeHome,'.config/neurocenter/bridge',namespace);
    await fs.mkdir(directory,{recursive:true});await fs.rename(path.join(saved.bridgeHome,namespace,'credentials.json'),path.join(directory,'credentials.json'));
    const result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);assert.equal(f.state.paused,false);assert.equal(await fs.readFile(saved.config,'utf8'),text);assert.equal(JSON.parse(await fs.readFile(path.join(directory,'credentials.json'),'utf8')).deviceId,'paired-device');await assert.rejects(fs.stat(path.join(f.home,'.config/neurocenter/bridge',namespace,'credentials.json')),{code:'ENOENT'});
}));
