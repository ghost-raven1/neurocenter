import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {devProcessIdentity} from '../workspace/dev-processes.mjs';
import {inspectLaunchBirth} from '../workspace/dev-launch-inspection.mjs';
import {groupAlive,stopWatchGroup} from '../workspace/dev-watch-owned.mjs';

/** IPC barriers control only these detached fixture groups; cleanup rechecks each owned process birth. */
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc exited owner '))),children=[],descendants=[];
    t.after(async()=>{
        for(const before of descendants){const current=inspectLaunchBirth(before.pid);if(current.state==='observed'&&current.birth===before.birth)process.kill(current.pid,'SIGKILL');}
        for(const {child,birth} of children){
            const current=inspectLaunchBirth(child.pid);
            if(current.state==='observed'&&current.birth===birth){
                const exited=once(child,'exit',{signal:AbortSignal.timeout(3000)});child.kill('SIGKILL');await exited;
            }else if(child.exitCode===null&&child.signalCode===null)await once(child,'exit',{signal:AbortSignal.timeout(3000)});
        }
        await fs.rm(root,{recursive:true,force:true});
    });
    async function start({descendant=false}={}){
        const body=`process.on('message',value=>{if(value==='exit')process.exit(7);});`+(descendant
            ?`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000);process.send("ready");'],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.send({descendant:child.pid}));`
            :`process.send('ready');`);
        const child=spawn(process.execPath,['-e',body,'owned-'+children.length],
            {cwd:root,detached:true,env:{PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','ignore','ipc']});
        const [ready]=await once(child,'message',{signal:AbortSignal.timeout(3000)});
        if(descendant){const observed=inspectLaunchBirth(ready.descendant);assert.equal(observed.state,'observed');descendants.push(observed);}
        const observed=inspectLaunchBirth(child.pid);assert.equal(observed.state,'observed');assert.equal(observed.pgid,child.pid);
        children.push({child,birth:observed.birth});
        return {child,birth:observed.birth,record:{pid:child.pid,identity:devProcessIdentity(child.pid)}};
    }
    return {start};
}

/** Block this parent's event loop until the OS reports Z, so Node cannot reap the child before the assertion. */
function exitBeforeParentReaps(owned,{liveGroup=false}={}){
    owned.exited=once(owned.child,'exit',{signal:AbortSignal.timeout(3000)});
    assert.equal(owned.child.connected,true);owned.child.send('exit');
    const deadline=Date.now()+3000;let birth;
    do{birth=inspectLaunchBirth(owned.child.pid);}while(birth.state!=='ended'&&Date.now()<deadline);
    assert.equal(birth.state,'ended');assert.equal(owned.child.exitCode,null);
    const current=devProcessIdentity(owned.child.pid);
    assert.ok(current.startsWith(owned.birth),'The exited owner retains the same OS birth, not a reused PID.');
    assert.notEqual(current,owned.record.identity,'The OS rewrites only the zombie command.');
    assert.equal(groupAlive(owned.child.pid),liveGroup);
}

test('an exited owner with no live group is already cleaned and never signalled',async t=>{
    const f=await fixture(t),owned=await f.start(),foreign=await f.start();
    exitBeforeParentReaps(owned);
    const signals=[],kill=process.kill;
    const spy=t.mock.method(process,'kill',function(pid,signal){signals.push({pid,signal});return kill.call(process,pid,signal);});
    try{
        await assert.doesNotReject(stopWatchGroup(owned.record));
        assert.deepEqual(signals,[]);assert.equal(groupAlive(owned.record.pid),false);
        const current=inspectLaunchBirth(foreign.child.pid);assert.equal(current.state,'observed');assert.equal(current.birth,foreign.birth);
    }finally{spy.mock.restore();}
    await owned.exited.then(([code])=>assert.equal(code,7));
});

test('a live different PID identity remains refused without signalling its group',async t=>{
    const f=await fixture(t),owned=await f.start(),foreign=await f.start(),signals=[],kill=process.kill;
    const spy=t.mock.method(process,'kill',function(pid,signal){signals.push({pid,signal});return kill.call(process,pid,signal);});
    try{
        await assert.rejects(stopWatchGroup({pid:foreign.child.pid,identity:owned.record.identity}),/WATCH_PID_REUSED/);
        assert.deepEqual(signals,[]);assert.equal(groupAlive(foreign.child.pid),true);
        const current=inspectLaunchBirth(foreign.child.pid);assert.equal(current.state,'observed');assert.equal(current.birth,foreign.birth);
    }finally{spy.mock.restore();}
});

test('an ended owner with live descendants remains refused without signalling an uncertain group',async t=>{
    const f=await fixture(t),owned=await f.start({descendant:true}),signals=[],kill=process.kill;
    exitBeforeParentReaps(owned,{liveGroup:true});
    const spy=t.mock.method(process,'kill',function(pid,signal){signals.push({pid,signal});return kill.call(process,pid,signal);});
    try{
        await assert.rejects(stopWatchGroup(owned.record),/WATCH_PID_REUSED/);
        assert.deepEqual(signals,[]);assert.equal(groupAlive(owned.child.pid),true);
    }finally{spy.mock.restore();}
    await owned.exited.then(([code])=>assert.equal(code,7));
});
