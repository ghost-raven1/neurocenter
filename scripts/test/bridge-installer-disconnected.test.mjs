import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';

/** Real installer/context and private files; the delivered CLI deliberately has legacy prepare refusal. */
async function profile(f){
    const config=path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc'),bridgeHome=path.join(f.root,'retained-state');
    const own={type:'local',enabled:false,command:[path.join(f.install,'bin/node'),path.join(f.install,'dist/index.js')],
        environment:{NEUROCENTER_URL:f.origin,NEUROCENTER_API_URL:f.origin,NEUROCENTER_BRIDGE_HOME:bridgeHome,CUSTOM_SETTING:'keep manually configured'}};
    const text='// Retain user settings exactly\n'+JSON.stringify({model:'team/model',agent:{existing:{mode:'subagent',description:'retain'}},mcp:{other:{type:'remote',url:'https://other.example.test'},'neurocenter-asset-sync':own}},null,2)+'\n';
    await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,text);
    const directory=path.join(bridgeHome,createHash('sha256').update(f.origin).digest('hex').slice(0,20));await fs.mkdir(directory,{recursive:true});
    const credentials=path.join(directory,'credentials.json'),credentialText=JSON.stringify({deviceId:'retained-device',token:'owned-revoked-token'});
    const journal=path.join(directory,'workspace-identity-pending.json'),journalText='{"owned":"retained reconciliation"}\n';
    await fs.writeFile(credentials,credentialText,{mode:0o600});await fs.writeFile(journal,journalText,{mode:0o600});
    return {config,text,bridgeHome,directory,credentials,credentialText,journal,journalText};
}
async function preserved(saved){
    assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);
    assert.equal(await fs.readFile(saved.credentials,'utf8'),saved.credentialText);
    assert.equal(await fs.readFile(saved.journal,'utf8'),saved.journalText);
}
const modes=async f=>(await fs.readFile(f.environment.INSTALLER_FIXTURE_EVENTS,'utf8')).trim().split('\n');

for(const lock of ['absent','dead'])test(`No live worker (${lock}) skips a legacy prepare refusal and reaches explicit reconnect`,()=>installerLifecycleFixture('disconnected-'+lock,async f=>{
    const saved=await profile(f);let deadPid;
    if(lock==='dead'){
        const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});deadPid=child.pid;
        const [code]=await once(child,'exit');assert.equal(code,0);assert.throws(()=>process.kill(deadPid,0),{code:'ESRCH'});
        await fs.writeFile(path.join(saved.directory,'worker.lock'),String(deadPid));
    }
    const result=await f.run({INSTALLER_FIXTURE_PREPARE:'refused'},{reconnect:true});
    assert.equal(result.status,0,result.stderr);await preserved(saved);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.install,'package.json'),'utf8')).version,f.version);
    await assert.rejects(fs.stat(path.join(f.install,'previous.txt')),{code:'ENOENT'});
    const calls=await modes(f);assert.ok(calls.includes('--reconnect-open'));
    assert.ok(!calls.includes('--prepare-upgrade'));assert.ok(!calls.includes('--finish-upgrade'));
    assert.equal(f.state.requests.filter(r=>r.route.endsWith('/worker/pause')||r.route.endsWith('/worker/resume')).length,0);
    assert.equal(f.state.paused,false);
    if(deadPid)assert.equal(await fs.readFile(path.join(saved.directory,'worker.lock'),'utf8'),String(deadPid));
}));

test('A live owned worker with HTTP401 still refuses replacement without killing its owner',()=>installerLifecycleFixture('disconnected-live-refusal',async f=>{
    const saved=await profile(f),worker=await f.startWorker({NEUROCENTER_BRIDGE_HOME:saved.bridgeHome});
    saved.credentialText=await fs.readFile(saved.credentials,'utf8');f.state.token='different-owned-server-token';
    const result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});
    assert.notEqual(result.status,0);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.equal(await fs.readFile(path.join(worker.directory,'worker.lock'),'utf8'),String(worker.pid));process.kill(worker.pid,0);
    await preserved(saved);const calls=await modes(f);assert.ok(calls.includes('--prepare-upgrade'));assert.ok(!calls.includes('--init'));assert.ok(!calls.includes('--connect-open'));
    assert.ok(f.state.requests.some(r=>r.route.endsWith('/worker/pause')));
}));

test('An unknown prepare ACK with a proven live worker still compensates its actual HTTP pause',()=>installerLifecycleFixture('disconnected-live-lost-ack',async f=>{
    const saved=await profile(f),worker=await f.startWorker({NEUROCENTER_BRIDGE_HOME:saved.bridgeHome});
    saved.credentialText=await fs.readFile(saved.credentials,'utf8');
    const result=await f.run({INSTALLER_FIXTURE_PREPARE:'lost'});
    assert.notEqual(result.status,0);assert.equal(f.state.paused,false);
    assert.equal(f.state.requests.filter(r=>r.route.endsWith('/worker/pause')).length,1);
    assert.equal(f.state.requests.filter(r=>r.route.endsWith('/worker/resume')).length,1);
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.equal(await fs.readFile(path.join(worker.directory,'worker.lock'),'utf8'),String(worker.pid));process.kill(worker.pid,0);
    await preserved(saved);
}));

test('A worker lock appearing after the skipped-preparation snapshot prevents publication',()=>installerLifecycleFixture('disconnected-lock-appeared',async f=>{
    const saved=await profile(f),lock=path.join(saved.directory,'worker.lock'),marker=path.join(f.root,'lock-appeared'),hook=path.join(f.root,'appear-lock.cjs');
    await fs.writeFile(hook,`const fs=require('node:fs'),path=require('node:path');const rename=fs.renameSync;fs.renameSync=function(from,to,...args){const result=rename.call(this,from,to,...args);if(path.basename(to)==='context.json'&&!fs.existsSync(${JSON.stringify(marker)})){const value=JSON.parse(fs.readFileSync(to,'utf8'));if(value.skipPreparation&&value.current.file===${JSON.stringify(saved.config)}){fs.mkdirSync(path.dirname(${JSON.stringify(lock)}),{recursive:true});fs.writeFileSync(${JSON.stringify(lock)},${JSON.stringify(String(process.pid))});fs.writeFileSync(${JSON.stringify(marker)},'appeared after snapshot');}}return result;};`);
    const result=await f.run({INSTALLER_FIXTURE_PREPARE:'refused',NODE_OPTIONS:'--require '+hook});
    assert.notEqual(result.status,0);assert.equal(await fs.readFile(marker,'utf8'),'appeared after snapshot');
    assert.match(result.stderr,/Состояние прежнего worker изменилось/);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.equal(await fs.readFile(lock,'utf8'),String(process.pid));await preserved(saved);
    const calls=await modes(f).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
    assert.ok(!calls.includes('--prepare-upgrade'));assert.ok(!calls.includes('--finish-upgrade'));assert.ok(!calls.includes('--init'));
}));
