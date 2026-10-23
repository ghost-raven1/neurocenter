import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeWatchFixture,until} from './dev-watch-native.fixture.mjs';
import {stopWatchGroup} from '../workspace/dev-watch-owned.mjs';
import {devProcessIdentity,discoverDevProcesses} from '../workspace/dev-processes.mjs';
import {runBuildProcess} from '../workspace/isolated-build-process.mjs';
const selected=[['catalog-service','services/catalog-service','main.js']];
test('real compiler owner forwards a successful exit and cleans its complete group',async t=>{
    const f=await nativeWatchFixture(t),file=path.join(f.root,'compiler.cjs');await fs.writeFile(file,'process.stdout.write("compiled");');let pid;const result=await runBuildProcess({node:process.execPath,args:[file],cwd:f.root,env:{PATH:process.env.PATH},ownerFile:path.join(f.root,'scripts/workspace/dev-watch-child.mjs'),logFile:path.join(f.root,'compiler.log'),onSpawn:value=>pid=value,timeoutMs:5000});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.groupAlive(pid),false);assert.equal((await fs.stat(path.join(f.root,'compiler.log'))).mode&0o777,0o600);
});
test('SIGKILL of the owner parent reaps actual command and TERM-ignoring grandchildren through IPC EOF',async t=>{
    const f=await nativeWatchFixture(t),state=path.join(f.root,'pids.json'),command=path.join(f.root,'service.cjs'),parentFile=path.join(f.root,'parent.mjs');
    await fs.writeFile(command,`const {spawn}=require('node:child_process'),fs=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.env.STATE,JSON.stringify({pid:process.pid,grand:child.pid}));setInterval(()=>{},1000);`);
    await fs.writeFile(parentFile,`import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,[${JSON.stringify(path.join(f.root,'scripts/workspace/dev-watch-child.mjs'))}],{cwd:${JSON.stringify(f.root)},detached:true,stdio:['ignore','ignore','ignore','ipc']});child.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(state+'.owner')},String(child.pid));child.send({kind:'run',args:[${JSON.stringify(command)}],environment:{PATH:process.env.PATH,STATE:${JSON.stringify(state)}}});});setInterval(()=>{},1000);`);
    const parent=spawn(process.execPath,[parentFile],{stdio:'ignore'});f.children.push(parent);await until(()=>fs.readFile(state,'utf8').then(JSON.parse,()=>null));const owner=Number(await fs.readFile(state+'.owner','utf8'));f.groups.push({pid:owner,identity:devProcessIdentity(owner)});parent.kill('SIGKILL');await once(parent,'exit');await until(()=>!f.groupAlive(owner));assert.equal(f.groupAlive(owner),false);
});
test('a reused/foreign PID identity is refused without killing that process',async t=>{
    const f=await nativeWatchFixture(t),command=path.join(f.root,'hold.cjs');await fs.writeFile(command,'setInterval(()=>{},1000);');const own=await f.owner([command]);await assert.rejects(stopWatchGroup({...own.record,identity:'another command'}),/PID_REUSED/);assert.ok(devProcessIdentity(own.record.pid));await stopWatchGroup(own.record);
});
test('successful generation restarts only the affected service, preserves environment privately, and prunes unused outputs',async t=>{
    const f=await nativeWatchFixture(t),runtime=await f.runtime(),one=await f.generation('one');await runtime.start(one);for(const item of runtime.active.values())await runtime.ready(item);const oldCatalog=runtime.active.get('catalog').record.pid,oldGateway=runtime.active.get('gateway').record.pid,two=await f.generation('two');await runtime.publish(two,selected);
    assert.notEqual(runtime.active.get('catalog').record.pid,oldCatalog);assert.equal(runtime.active.get('gateway').record.pid,oldGateway);assert.deepEqual(await(await fetch('http://127.0.0.1:'+runtime.active.get('catalog').service.port+'/version')).json(),{value:'two'});
    const metadata=await fs.readFile(path.join(f.root,'.run/processes.json'),'utf8');assert.doesNotMatch(metadata,/NEVER_IN_METADATA|PRIVATE_FIXTURE_SECRET/);assert.equal((await fs.stat(path.join(f.root,'.run/processes.json'))).mode&0o777,0o600);
    const discovered=discoverDevProcesses(f.root,[...runtime.config.services]);assert.ok(discovered.some(record=>record.pid===runtime.active.get('catalog').record.pid));await runtime.close();assert.deepEqual(await fs.readdir(path.join(f.root,'.run/dev-watch/generations')),[]);
});
test('failed new runtime restores the previous immutable runtime/shared bytes',async t=>{
    const f=await nativeWatchFixture(t),runtime=await f.runtime(),one=await f.generation('previous');await runtime.start(one);for(const item of runtime.active.values())await runtime.ready(item);const previousGateway=runtime.active.get('gateway').record.pid,bad=await f.generation('bad',{crash:true});await assert.rejects(runtime.publish(bad,selected),/WATCH_SERVICE_EXITED/);assert.equal(runtime.active.get('gateway').record.pid,previousGateway);assert.deepEqual(await(await fetch('http://127.0.0.1:'+runtime.active.get('catalog').service.port+'/version')).json(),{value:'previous'});await runtime.close();
});
test('stop during a compiler run removes npm-style descendants and reports cancellation',async t=>{
    const f=await nativeWatchFixture(t),file=path.join(f.root,'build.cjs');await fs.writeFile(file,`const {spawn}=require('node:child_process');spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);const abort=new AbortController();let pid;const pending=runBuildProcess({node:process.execPath,args:[file],cwd:f.root,env:{PATH:process.env.PATH},ownerFile:path.join(f.root,'scripts/workspace/dev-watch-child.mjs'),logFile:path.join(f.root,'cancel.log'),signal:abort.signal,onSpawn:value=>pid=value,timeoutMs:10000});await until(()=>pid);await delay(100);abort.abort();const result=await pending;assert.equal(result.failure.code,'CANCELLED');assert.equal(f.groupAlive(pid),false);
});
