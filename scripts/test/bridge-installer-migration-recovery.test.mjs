import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';

/** An unreachable previous site must not prevent an idle computer joining the current site. */
async function previousProfile(f){
    const site='http://127.0.0.1:1',bridgeHome=path.join(f.root,'previous-state');
    const config=path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc');
    const own={type:'local',enabled:false,timeout:45000,command:[path.join(f.install,'bin/node'),path.join(f.install,'dist/index.js')],environment:{NEUROCENTER_URL:site,NEUROCENTER_BRIDGE_HOME:bridgeHome,CUSTOM_SETTING:'keep'}};
    const text='// Previous profile\n'+JSON.stringify({agent:{keep:{mode:'subagent'}},mcp:{'neurocenter-asset-sync':own}},null,2)+'\n';
    const directory=path.join(bridgeHome,createHash('sha256').update(site).digest('hex').slice(0,20));
    await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,text);
    await fs.mkdir(directory,{recursive:true});
    const credentials=path.join(directory,'credentials.json'),bytes='{"token":"previous-owned-token","deviceId":"previous-owned-device"}\n';
    await fs.writeFile(credentials,bytes);
    return{config,text,directory,credentials,bytes,own};
}
async function unchanged(f,saved){
    assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);
    assert.equal(await fs.readFile(saved.credentials,'utf8'),saved.bytes);
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.equal(f.state.paused,false);
    assert.equal(f.state.requests.filter(r=>r.method==='POST').length,0);
}

for(const state of ['absent','dead'])test('An unreachable previous site with '+state+' worker permits target pairing without old credentials',()=>installerLifecycleFixture('migration-idle-'+state,async f=>{
    const saved=await previousProfile(f);
    if(state==='dead'){
        const {stdout}=await promisify(execFile)(process.execPath,['-p','process.pid'],{timeout:3000});
        const pid=Number(stdout.trim());assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
        await fs.writeFile(path.join(saved.directory,'worker.lock'),String(pid));
    }
    const result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    const value=JSON.parse((await fs.readFile(saved.config,'utf8')).replace(/^\/\/ Previous profile\n/,''));
    assert.deepEqual(value.mcp['neurocenter-asset-sync'],{...saved.own,environment:{...saved.own.environment,NEUROCENTER_URL:f.origin,NEUROCENTER_API_URL:f.origin}});
    assert.equal(await fs.readFile(saved.credentials,'utf8'),saved.bytes);
    assert.match(result.stdout,/Подключение ждёт подтверждения/);
    assert.doesNotMatch(result.stdout,/Компьютер уже подключён/);
    const calls=f.state.requests.filter(r=>r.method==='POST');
    assert.deepEqual(calls.map(r=>r.route),['/api/device-channel/pair/start']);
    assert.equal(calls[0].authorization,false);
    assert.equal(f.state.paused,false);
}));

for(const state of ['malformed','symlink'])test('A '+state+' previous worker lock is not treated as an absent worker',()=>installerLifecycleFixture('migration-lock-'+state,async f=>{
    const saved=await previousProfile(f),lock=path.join(saved.directory,'worker.lock');
    if(state==='malformed')await fs.writeFile(lock,'not-a-pid');
    else{const target=path.join(f.root,'unrelated-lock');await fs.writeFile(target,String(process.pid));await fs.symlink(target,lock);}
    const result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.notEqual(result.status,0);
    await unchanged(f,saved);process.kill(process.pid,0);
}));

test('A worker lock appearing after the idle proof stops migration before publication',()=>installerLifecycleFixture('migration-lock-race',async f=>{
    const saved=await previousProfile(f),marker=path.join(f.root,'lock-published'),hook=path.join(f.root,'publish-lock.cjs');
    await fs.writeFile(hook,`const fs=require('node:fs');const write=fs.writeFileSync;fs.writeFileSync=function(file,text,...args){const result=write.call(this,file,text,...args);if(typeof file==='number'&&typeof text==='string'&&text.includes('"skipPreparation"')&&!fs.existsSync(${JSON.stringify(marker)})){write.call(fs,${JSON.stringify(marker)},'owned concurrent lock');write.call(fs,${JSON.stringify(path.join(saved.directory,'worker.lock'))},${JSON.stringify(String(process.pid))});}return result;};`);
    const result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',NODE_OPTIONS:'--require '+hook});assert.notEqual(result.status,0);
    assert.equal(await fs.readFile(marker,'utf8'),'owned concurrent lock');await unchanged(f,saved);process.kill(process.pid,0);
}));

for(const concurrentEdit of [false,true])test('A lost migration write ACK '+(concurrentEdit?'preserves a later user edit':'restores the exact previous registration and runtime'),()=>installerLifecycleFixture('migration-write-ack-'+concurrentEdit,async f=>{
    const saved=await previousProfile(f),marker=path.join(f.root,'migration-written'),hook=path.join(f.root,'migration-ack.cjs'),userText=saved.text+'// Concurrent user edit\n';
    await fs.writeFile(hook,`const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=function(from,to){const result=rename.call(this,from,to);if(to===${JSON.stringify(saved.config)}&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'write committed before lost ACK');${concurrentEdit?`fs.writeFileSync(to,${JSON.stringify(userText)});`:''}throw Error('Owned migration write acknowledgement lost');}return result;};`);
    const result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',NODE_OPTIONS:'--require '+hook});assert.notEqual(result.status,0);
    assert.equal(await fs.readFile(marker,'utf8'),'write committed before lost ACK');
    if(concurrentEdit){assert.equal(await fs.readFile(saved.config,'utf8'),userText);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');assert.equal(f.state.requests.filter(r=>r.method==='POST').length,0);}
    else await unchanged(f,saved);
    assert.equal(await fs.readFile(saved.credentials,'utf8'),saved.bytes);
    assert.doesNotMatch(result.stdout,/Компьютер уже подключён|Подключение ждёт подтверждения/);
}));

for(const change of ['replacement','chmod','restore-failure'])test('Unconfirmed migration recovery retains its private snapshot after '+change,()=>installerLifecycleFixture('migration-private-recovery-'+change,async f=>{
    const saved=await previousProfile(f),marker=path.join(f.root,'published'),hook=path.join(f.root,'preserve-recovery.cjs');
    const mutation=change==='replacement'?`const bytes=fs.readFileSync(to);const other=to+'.own-replacement';fs.writeFileSync(other,bytes);rename.call(fs,other,to);`
        :change==='chmod'?`fs.chmodSync(to,0o640);`:'';
    await fs.writeFile(hook,`const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=function(from,to){if(to!==${JSON.stringify(saved.config)})return rename.call(this,from,to);if(fs.existsSync(${JSON.stringify(marker)})){if(${JSON.stringify(change)}==='restore-failure')throw Object.assign(Error('Owned restoration denied'),{code:'EACCES'});return rename.call(this,from,to);}const result=rename.call(this,from,to);${mutation}const s=fs.statSync(to);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({dev:s.dev,ino:s.ino,mode:s.mode}));throw Error('Owned migration acknowledgement lost');};`);
    const result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',NODE_OPTIONS:'--require '+hook});assert.notEqual(result.status,0);
    const published=JSON.parse(await fs.readFile(marker,'utf8')),current=await fs.stat(saved.config);
    assert.equal(current.dev,published.dev);assert.equal(current.ino,published.ino);assert.equal(current.mode,published.mode);
    const retained=(await fs.readdir(path.dirname(f.install))).filter(name=>name.startsWith('.neurocenter-install.'));
    assert.equal(retained.length,1);const recovery=path.join(path.dirname(f.install),retained[0]);
    const plan=JSON.parse(await fs.readFile(path.join(recovery,'context.json'),'utf8'));
    assert.equal(plan.text,saved.text);assert.equal((await fs.stat(recovery)).mode&0o777,0o700);
    assert.equal((await fs.stat(path.join(recovery,'context.json'))).mode&0o777,0o600);
    assert.match(result.stderr,/Приватный снимок и план сохранены/);
    assert.equal(await fs.readFile(saved.credentials,'utf8'),saved.bytes);
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.equal(f.state.requests.filter(r=>r.method==='POST').length,0);
}));

for(const kind of ['NUL value','invalid key','oversized output'])test('Migration rejects '+kind+' before pausing or replacing the runtime',()=>installerLifecycleFixture('migration-admission-'+kind,async f=>{
    const saved=await previousProfile(f);let text;
    if(kind==='oversized output')text=saved.text+'/*'+'x'.repeat(8*1024*1024-5-Buffer.byteLength(saved.text))+'*/\n';
    else{const value=JSON.parse(saved.text.replace(/^\/\/ Previous profile\n/,''));value.mcp['neurocenter-asset-sync'].environment[kind==='invalid key'?'NOT-VALID':'CUSTOM_SETTING']=kind==='NUL value'?'a\0b':'keep';text=JSON.stringify(value);}
    saved.text=text;await fs.writeFile(saved.config,text);
    const result=await f.run({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.notEqual(result.status,0);
    await unchanged(f,saved);
    if(kind==='oversized output')assert.match(result.stderr,/8 МиБ/);
}));

for(const rollback of [false,true])test('Migration preserves permissions during '+(rollback?'rollback':'publication'),()=>installerLifecycleFixture('migration-permissions-'+rollback,async f=>{
    const saved=await previousProfile(f);await fs.chmod(saved.config,0o640);let environment={INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'};
    if(rollback){
        const hook=path.join(f.root,'mode-rollback.cjs'),marker=path.join(f.root,'mode-written');
        await fs.writeFile(hook,`const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=function(from,to){const result=rename.call(this,from,to);if(to===${JSON.stringify(saved.config)}&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'owned mode rollback');throw Error('Owned publication ACK lost');}return result;};`);
        environment.NODE_OPTIONS='--require '+hook;
    }
    const result=await f.run(environment);assert.equal(result.status===0,!rollback,result.stderr);
    assert.equal((await fs.stat(saved.config)).mode&0o777,0o640);
    if(rollback)await unchanged(f,saved);
    else assert.equal(JSON.parse((await fs.readFile(saved.config,'utf8')).replace(/^\/\/ Previous profile\n/,'')).mcp['neurocenter-asset-sync'].environment.NEUROCENTER_URL,f.origin);
}));
