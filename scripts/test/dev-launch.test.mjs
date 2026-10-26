import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync, renameSync} from 'node:fs';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {launchFixture} from './dev-launch.fixture.mjs';
import {readDevLaunchLog} from '../dev-mcp/launch-logs.mjs';
import {readOwnedFile} from '../dev-mcp/safe-file.mjs';
import {devProcessIdentity} from '../workspace/dev-processes.mjs';
import {inspectLaunchProcess, launchProvenanceEnabled, saveLaunchReceipt} from '../workspace/dev-launch-provenance.mjs';
import {stopWatchGroup, groupAlive} from '../workspace/dev-watch-owned.mjs';

for (const wrapper of [false, true]) test('launcher binds ' + (wrapper ? 'actual service separately from its wrapper' : 'direct service') + ' to a private new log', async t => {
    const f = await launchFixture(t), generation = wrapper ? randomUUID() : null, sourceSha256 = wrapper ? 'a'.repeat(64) : null;
    const launched = await f.launch({wrapper,generation,sourceSha256}), file = f.receipt(launched.launchId);
    const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal((await fs.stat(launched.logFile)).mode & 0o777, 0o600);
    assert.equal(receipt.process.pid, launched.record.servicePid);
    assert.notEqual(receipt.owner.pid, receipt.process.pid);
    assert.doesNotMatch(JSON.stringify(receipt), /NEVER_IN_RECEIPT|PRIVATE_TEST_TOKEN|NODE_OPTIONS/);
    const value = await readDevLaunchLog(f.root, 'catalog');
    assert.equal(value.launch.generation,generation);assert.equal(value.launch.sourceSha256,sourceSha256);
    assert.equal(value.launch.launchId, launched.launchId); assert.equal(value.currentProcessCorrelation.state, 'owned');
    assert.equal(value.currentProcessCorrelation.pid, receipt.process.pid);
    assert.doesNotMatch(JSON.stringify(value), /"cwd"|"command"|NEVER_IN_RECEIPT/);
});

test('cancellation while waiting for the actual ACK keeps its signal and reaps the new process', async t => {
    const f = await launchFixture(t), controller = new AbortController(); let owned;
    await fs.writeFile(path.join(f.root, 'scripts/workspace/dev-launch-ack.mjs'), '// Intentionally no ACK.');
    const pending = f.launch({signal: controller.signal, onOwner: value => { owned = value; controller.abort('SIGTERM'); }});
    await assert.rejects(pending, error => error.code === 'ECANCELED' && error.signal === 'SIGTERM');
    assert.equal(groupAlive(owned.pid), false); assert.equal(devProcessIdentity(owned.pid), '');
});

for(const stage of ['app-entry','caller-preload'])test('unavailable initial owner identity gates '+stage+' and its immediate writer descendant', async t => {
    const f = await launchFixture(t), state = path.join(f.root, 'writer.json');
    const writer=`const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(process.env.WRITER_STATE,JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);`;
    const preload=path.join(f.root,'caller-preload.cjs');await fs.writeFile(stage==='app-entry'?f.entry:preload,writer);
    let descendant;
    try {
        await assert.rejects(f.launch({environment:{WRITER_STATE:state,...stage==='caller-preload'?{NODE_OPTIONS:'--require='+JSON.stringify(preload)}:{}},identifyOwner:()=>{
            spawnSync(process.execPath,['-e',`const fs=require('node:fs'),end=Date.now()+500;while(!fs.existsSync(process.argv[1])&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`,state],{timeout:1000});
            return '';
        }}), /PROCESS_IDENTITY/);
        const started = await fs.readFile(state,'utf8').then(JSON.parse,()=>null);
        descendant = started && inspectLaunchProcess(started.pid);
        assert.equal(descendant?.state === 'observed',false,'The app must stay behind the owner barrier when its identity is unavailable.');
        assert.equal(started,null);
    } finally {
        // Clean the deliberately exposed pre-fix descendant using its freshly observed own cwd/birth only.
        if(descendant?.state==='observed'&&descendant.cwd===path.dirname(path.dirname(f.entry))){
            const fresh=inspectLaunchProcess(descendant.pid);
            if(fresh.state==='observed'&&fresh.birth===descendant.birth)process.kill(descendant.pid,'SIGKILL');
        }
    }
});

for(const flag of ['1','0'])test('owner SIGKILL reaps the service and stubborn descendant while recording='+flag, async t => {
    const f=await launchFixture(t),foreign=await f.launch(),state=path.join(f.root,'owned-pids.json'),ready=path.join(f.root,'writer-ready');
    const writer=path.join(path.dirname(f.entry),'stubborn.cjs');
    await fs.writeFile(writer,`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.WRITER_READY,'ready');setInterval(()=>{},1000);`);
    await fs.writeFile(f.entry,`const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,[process.env.WRITER_FILE],{stdio:'inherit'});fs.writeFileSync(process.env.WRITER_STATE,JSON.stringify({service:process.pid,writer:child.pid}));console.log('started');setInterval(()=>{},1000);`);
    const launched=await f.launch({environment:{NEUROCENTER_DEV_LAUNCH_PROVENANCE:flag,WRITER_STATE:state,WRITER_READY:ready,WRITER_FILE:writer}});
    const deadline=Date.now()+3000;while(!await fs.stat(ready).then(()=>true,()=>false)&&Date.now()<deadline)await delay(20);
    assert.equal(await fs.readFile(ready,'utf8'),'ready');
    const pids=JSON.parse(await fs.readFile(state,'utf8')),owned=[inspectLaunchProcess(pids.service),inspectLaunchProcess(pids.writer)];
    try{
        const exited=once(launched.child,'exit');launched.child.kill('SIGKILL');await exited;
        const stopped=Date.now()+1000;while(groupAlive(launched.record.pid)&&Date.now()<stopped)await delay(20);
        assert.equal(groupAlive(launched.record.pid),false,'Owner loss must not leave its service or TERM-ignoring descendant alive.');
        assert.ok(devProcessIdentity(foreign.record.pid));assert.equal(inspectLaunchProcess(foreign.record.servicePid).state,'observed');
    }finally{
        for(const before of owned){const current=inspectLaunchProcess(before.pid);if(current.state==='observed'&&current.birth===before.birth&&current.cwd===path.dirname(path.dirname(f.entry)))process.kill(current.pid,'SIGKILL');}
        const index=f.records.indexOf(launched.record);if(index>=0)f.records.splice(index,1);
    }
});

test('retained ownership IPC does not keep a naturally completed service alive',async t=>{
    const f=await launchFixture(t);await fs.writeFile(f.entry,'console.log("completed");');
    try{await f.launch();}catch(error){assert.match(error.code,/DEV_LAUNCH_(EXITED|PROCESS_IDENTITY)/);}
    const record=f.records.at(-1);assert.ok(record);
    const deadline=Date.now()+1000;while(groupAlive(record.pid)&&Date.now()<deadline)await delay(20);
    assert.equal(groupAlive(record.pid),false);
});

for (const kind of ['missing-ack', 'receipt-failure', 'unknown-inspection']) test(kind + ' stops only the new launch and preserves prior history', async t => {
    const f = await launchFixture(t), previous = await f.launch(); let failed;
    if (kind === 'missing-ack') await fs.writeFile(path.join(f.root, 'scripts/workspace/dev-launch-ack.mjs'), '// Intentionally no IPC acknowledgement.');
    await assert.rejects(f.launch({acknowledgeTimeoutMs: 150, onOwner: record => { failed = record; },
        ...(kind === 'receipt-failure' ? {save: async () => { throw Object.assign(Error('ENOSPC'), {code: 'ENOSPC'}); }} : {}),
        ...(kind === 'unknown-inspection' ? {inspectProcess: () => ({state: 'unknown'})} : {})}));
    assert.ok(failed); assert.equal(groupAlive(failed.pid), false); assert.equal(devProcessIdentity(failed.pid), '');
    assert.ok(devProcessIdentity(previous.record.pid));
    assert.equal((await readDevLaunchLog(f.root, 'catalog')).launch.launchId, previous.launchId);
});

test('recording disabled preserves append reading and removes caller launch labels', async t => {
    const f = await launchFixture(t), launched = await f.launch({environment: {NEUROCENTER_DEV_LAUNCH_PROVENANCE: '0', NEUROCENTER_DEV_LAUNCH_ID: randomUUID()}});
    assert.equal(launched.launchId, null); assert.equal(launched.record.servicePid, undefined);
    const value = await readDevLaunchLog(f.root, 'catalog'); assert.equal(value.launch, null); assert.match(value.text, /"launchId":null/);
    assert.deepEqual(value.currentProcessCorrelation, {state: 'unknown', reason: 'append-log-without-launch-provenance'});
    await assert.rejects(fs.stat(path.join(f.root, '.run/dev-launches')), {code: 'ENOENT'});
    assert.throws(() => launchProvenanceEnabled({NEUROCENTER_DEV_LAUNCH_PROVENANCE: 'typo'}), /INVALID_FLAG/);
});

test('history survives process exit, disabled recording, and selection of an older launch', async t => {
    const f = await launchFixture(t), first = await f.launch(); await stopWatchGroup(first.record);
    const second = await f.launch();
    const old = await readDevLaunchLog(f.root, 'catalog', {launchId: first.launchId});
    assert.equal(old.launch.launchId, first.launchId); assert.deepEqual(old.currentProcessCorrelation, {state: 'historical', reason: 'launch-process-ended'});
    assert.equal((await readDevLaunchLog(f.root, 'catalog')).launch.launchId, second.launchId);
    assert.deepEqual((await readDevLaunchLog(f.root,'catalog',{launchId:second.launchId})).currentProcessCorrelation,{state:'historical',reason:'retained-launch'});
    let probes = 0;
    const uninspected = await readDevLaunchLog(f.root, 'catalog', {inspect: false, inspectProcess: () => { probes++; throw Error('must not probe'); }});
    assert.equal(probes, 0); assert.equal(uninspected.launch.launchId, second.launchId);
    assert.deepEqual(uninspected.currentProcessCorrelation, {state: 'unknown', reason: 'launch-inspection-disabled'});
    await assert.rejects(readDevLaunchLog(f.root, 'catalog', {launchId: randomUUID()}), error => error.code === 'NOT_FOUND');
});

test('a successful disabled launch clears only its current index and keeps UUID history readable', async t => {
    const f = await launchFixture(t), previous = await f.launch(); await stopWatchGroup(previous.record);
    await f.launch({environment: {NEUROCENTER_DEV_LAUNCH_PROVENANCE: '0', NEUROCENTER_DEV_LAUNCH_ID: randomUUID()}});
    const current = await readDevLaunchLog(f.root, 'catalog');
    assert.equal(current.launch, null); assert.match(current.text, /"launchId":null/);
    const history = await readDevLaunchLog(f.root, 'catalog', {launchId: previous.launchId});
    assert.equal(history.launch.launchId, previous.launchId); assert.equal(history.currentProcessCorrelation.state, 'historical');
});

test('disabled launch refuses an invalid current index without removing it', async t => {
    const f = await launchFixture(t), previous = await f.launch(); let failed;
    const index = path.join(f.root, '.run/dev-launches/catalog/current.json'); await fs.writeFile(index, 'broken-index', {mode: 0o600});
    await assert.rejects(f.launch({environment: {NEUROCENTER_DEV_LAUNCH_PROVENANCE: '0'}, onOwner: value => { failed = value; }}), /UNSAFE_INDEX/);
    assert.equal(await fs.readFile(index, 'utf8'), 'broken-index'); assert.equal(failed, undefined,'Invalid metadata must be refused before spawning an owner.');
    assert.ok(devProcessIdentity(previous.record.pid));
});

test('a replacement inode cannot borrow a valid launch receipt or its text labels', async t => {
    const f = await launchFixture(t), launched = await f.launch();
    await fs.rename(launched.logFile, launched.logFile + '.retained');
    await fs.writeFile(launched.logFile, '[launch] current=true launchId=' + launched.launchId, {mode: 0o600});
    const value = await readDevLaunchLog(f.root, 'catalog');
    assert.equal(value.launch, null); assert.deepEqual(value.currentProcessCorrelation, {state: 'unknown', reason: 'launch-log-identity-changed'});
});

test('a log replaced while the receipt is being published fails launch and reaps its new process', async t => {
    const f = await launchFixture(t); let owned;
    await assert.rejects(f.launch({onOwner: value => { owned = value; }, save: async (filename, value) => {
        await saveLaunchReceipt(filename, value);
        if (value.kind === 'neurocenter-dev-launch') {
            const log = path.join(f.root, value.log.path); await fs.rename(log, log + '.retained'); await fs.writeFile(log, 'replaced', {mode: 0o600});
        }
    }}), /LOG_CHANGED/);
    assert.equal(groupAlive(owned.pid), false); assert.equal(devProcessIdentity(owned.pid), '');
});

test('late publication failure restores the previous healthy index', async t => {
    const f = await launchFixture(t), previous = await f.launch(); let next;
    await assert.rejects(f.launch({save:async(filename,value)=>{
        await saveLaunchReceipt(filename,value);
        if(value.kind==='neurocenter-dev-launch')next=value;
        else if(value.launchId===next?.launchId){const log=path.join(f.root,next.log.path);await fs.rename(log,log+'.retained');await fs.writeFile(log,'substituted',{mode:0o600});}
    }}), /LOG_CHANGED/);
    assert.equal((await readDevLaunchLog(f.root,'catalog')).launch?.launchId,previous.launchId);
    assert.ok(devProcessIdentity(previous.record.pid));
});

test('late rollback preserves a different concurrently selected launch', async t => {
    const f=await launchFixture(t),previous=await f.launch(),concurrent=await f.launch(),index=path.join(f.root,'.run/dev-launches/catalog/current.json');let next;
    await saveLaunchReceipt(index,{schemaVersion:1,launchId:previous.launchId});
    await assert.rejects(f.launch({save:async(filename,value)=>{
        await saveLaunchReceipt(filename,value);
        if(value.kind==='neurocenter-dev-launch')next=value;
        else if(value.launchId===next?.launchId){await saveLaunchReceipt(index,{schemaVersion:1,launchId:concurrent.launchId});const log=path.join(f.root,next.log.path);await fs.rename(log,log+'.retained');await fs.writeFile(log,'substituted',{mode:0o600});}
    }}), /LOG_CHANGED/);
    assert.equal((await readDevLaunchLog(f.root,'catalog')).launch?.launchId,concurrent.launchId);
});

test('a concurrent publication is refused before its app runs while the prior transaction owns the index', async t => {
    const f=await launchFixture(t);let attempted=false,spawned=false;
    const launched=await f.launch({save:async(filename,value)=>{
        await saveLaunchReceipt(filename,value);
        if(value.kind==='neurocenter-dev-launch'){
            attempted=true;await assert.rejects(f.launch({onOwner:()=>{spawned=true;}}),/INDEX_BUSY/);
        }
    }});
    assert.equal(attempted,true);assert.equal(spawned,false);
    assert.equal((await readDevLaunchLog(f.root,'catalog')).launch.launchId,launched.launchId);
});

for(const owner of ['reused','ended'])test('a stale index lock fails closed when its owner is '+owner, async t => {
    const f=await launchFixture(t),previous=await f.launch(),lock=path.join(f.root,'.run/dev-launches/catalog/index.lock');
    if(owner==='ended'){const exited=once(previous.child,'exit');await stopWatchGroup(previous.record);await exited;f.records.splice(f.records.indexOf(previous.record),1);}
    const stale=JSON.stringify({pid:previous.record.pid,birth:'Mon Jan 01 00:00:00 2001',nonce:randomUUID()});
    await fs.writeFile(lock,stale,{mode:0o600});
    await assert.rejects(f.launch(),error=>error.code==='DEV_LAUNCH_LOCK_STALE');
    assert.equal(await fs.readFile(lock,'utf8'),stale);assert.equal((await readDevLaunchLog(f.root,'catalog')).launch.launchId,previous.launchId);
    // Explicit cleanup belongs only to this private fixture; the launcher never reclaims stale locks.
    await fs.unlink(lock);
    const launched=await f.launch();
    if(owner==='reused')assert.ok(devProcessIdentity(previous.record.pid));assert.equal((await readDevLaunchLog(f.root,'catalog')).launch.launchId,launched.launchId);
    await assert.rejects(fs.stat(lock),{code:'ENOENT'});
});

test('two stale-lock reclaimers both refuse without removing a lock or starting applications', async t => {
    const f=await launchFixture(t),previous=await f.launch(),lock=path.join(f.root,'.run/dev-launches/catalog/index.lock'),open=fs.open;
    const stale=JSON.stringify({pid:previous.record.pid,birth:'Mon Jan 01 00:00:00 2001',nonce:randomUUID()});await fs.writeFile(lock,stale,{mode:0o600});
    let arrived=0,release,spawned=0;const gate=new Promise(resolve=>{release=resolve;});
    fs.open=async(filename,...args)=>{try{return await open(filename,...args);}catch(error){if(filename===lock&&args[0]==='wx'&&error.code==='EEXIST'){if(++arrived===2)release();await gate;}throw error;}};
    let results;try{results=await Promise.allSettled([f.launch({onOwner:()=>{spawned++;}}),f.launch({onOwner:()=>{spawned++;}})]);}finally{fs.open=open;}
    assert.equal(arrived>=2,true);assert.equal(spawned,0);
    for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'DEV_LAUNCH_LOCK_STALE');}
    assert.equal(await fs.readFile(lock,'utf8'),stale);assert.equal((await readDevLaunchLog(f.root,'catalog')).launch.launchId,previous.launchId);
});

test('a partial index lock write is removed before retry and never starts an app', async t => {
    const f=await launchFixture(t),open=fs.open;let spawned=false;
    fs.open=async(filename,...args)=>{
        const handle=await open(filename,...args);
        if(path.basename(filename)==='index.lock')return new Proxy(handle,{get(target,key){if(key==='writeFile')return async()=>{throw Object.assign(Error('ENOSPC'),{code:'ENOSPC'});};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        return handle;
    };
    try{await assert.rejects(f.launch({onOwner:()=>{spawned=true;}}),/ENOSPC/);}finally{fs.open=open;}
    assert.equal(spawned,false);
    const launched=await f.launch();assert.equal((await readDevLaunchLog(f.root,'catalog')).launch.launchId,launched.launchId);
});

test('default correlation cannot retain owned when current changes during OS observation', async t => {
    const f=await launchFixture(t),previous=await f.launch(),next=await f.launch(),index=path.join(f.root,'.run/dev-launches/catalog/current.json');
    await saveLaunchReceipt(index,{schemaVersion:1,launchId:previous.launchId});let switched=false;
    const value=await readDevLaunchLog(f.root,'catalog',{inspectProcess:pid=>{
        const observed=inspectLaunchProcess(pid);
        if(!switched){switched=true;writeFileSync(index+'.next',JSON.stringify({schemaVersion:1,launchId:next.launchId}),{mode:0o600});renameSync(index+'.next',index);}
        return observed;
    }});
    assert.equal(switched,true);assert.notEqual(value.currentProcessCorrelation.state,'owned');
    assert.equal(value.launch.launchId,previous.launchId);
});

for (const kind of ['reused', 'unknown', 'cwd', 'output']) test('current correlation refuses ' + kind + ' OS evidence', async t => {
    const f = await launchFixture(t); await f.launch();
    const value = await readDevLaunchLog(f.root, 'catalog', {inspectProcess: pid => {
        const actual = inspectLaunchProcess(pid);
        if (kind === 'reused') actual.birth = 'Mon Jan 01 00:00:00 2001';
        if (kind === 'unknown') actual.state = 'unknown';
        if (kind === 'cwd') actual.cwd = '/somewhere-else';
        if (kind === 'output') actual.outputs = [{dev: 0, ino: 0}, {dev: 0, ino: 0}];
        return actual;
    }});
    assert.equal(value.currentProcessCorrelation.state, 'unknown'); assert.equal(Object.hasOwn(value.currentProcessCorrelation, 'pid'), false);
});

test('launch reads retain service/path/private-file guards and hash original bytes', async t => {
    const f = await launchFixture(t), launched = await f.launch();
    await assert.rejects(readDevLaunchLog(f.root, '../outside'), error => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(readDevLaunchLog(f.root, 'catalog', {launchId: '../outside'}), error => error.code === 'INVALID_ARGUMENT');
    await fs.chmod(f.receipt(launched.launchId), 0o644);
    await assert.rejects(readDevLaunchLog(f.root, 'catalog'), error => error.code === 'UNSAFE_FILE');
    const relative = '.run/logs/invalid-bytes.log', bytes = Buffer.from([0xff, 0x61, 0x80]); await fs.writeFile(path.join(f.root, relative), bytes);
    const selected = await readOwnedFile(f.root, relative, {limit: 100});
    assert.equal(selected.contentSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.notEqual(selected.contentSha256, createHash('sha256').update(selected.text).digest('hex'));
});
