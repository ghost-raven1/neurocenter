import assert from 'node:assert/strict';
import {test} from 'node:test';
import {launchFixture} from './dev-launch.fixture.mjs';
import {blockedLaunch} from './dev-launch-recovery.fixture.mjs';
import {recoverDevLaunch} from '../workspace/dev-launch-recovery.mjs';
import {inspectLaunchProcess} from '../workspace/dev-launch-inspection.mjs';
import {groupAlive} from '../workspace/dev-watch-owned.mjs';
import {devProcessIdentity} from '../workspace/dev-processes.mjs';

for(const flag of ['1','0'])test('fresh saved witness reaps blocked actual and stubborn writer after owner loss, recording='+flag,async t=>{
    const f=await launchFixture(t),foreign=await f.launch(),owned=await blockedLaunch(f,{NEUROCENTER_DEV_LAUNCH_PROVENANCE:flag});
    await owned.killOwner();
    try{
        const witness=owned.launched.record.serviceWitness;assert.equal(witness.pid,owned.pids.pid);assert.equal(witness.pgid,owned.launched.record.pid);
        const actual=inspectLaunchProcess(witness.pid);assert.equal(actual.state,'observed');assert.notEqual(actual.ppid,owned.launched.record.pid);
        assert.equal((await owned.cleanup()).state,'stopped');assert.equal(groupAlive(owned.launched.record.pid),false);
        assert.ok(devProcessIdentity(foreign.record.pid));assert.equal(inspectLaunchProcess(foreign.record.serviceWitness.pid).state,'observed');
    }finally{await owned.cleanup();}
});

for(const kind of ['birth','pgid','fd','command','cwd','inspection','second-proof'])test('orphan recovery refuses '+kind+' mismatch without any signal',async t=>{
    const f=await launchFixture(t),owned=await blockedLaunch(f);await owned.killOwner();let reads=0;const signals=[];
    try{
        const result=await recoverDevLaunch(f.root,owned.launched.record,f.service,{sendGroup:(...args)=>signals.push(args),inspectProcess:pid=>{
            const observed=inspectLaunchProcess(pid);
            if(pid!==owned.pids.pid||observed.state!=='observed')return observed;
            reads++;
            if(kind==='birth'||kind==='second-proof'&&reads===2)return {...observed,birth:'Mon Jan 01 00:00:00 2001'};
            if(kind==='pgid')return {...observed,pgid:observed.pgid+1};
            if(kind==='fd')return {...observed,outputs:[{dev:0,ino:0},{dev:0,ino:0}]};
            if(kind==='command')return {...observed,commandSha256:'0'.repeat(64)};
            if(kind==='cwd')return {...observed,cwd:'/another-checkout'};
            if(kind==='inspection')return {state:'unknown'};
            return observed;
        }});
        assert.equal(result.state,'unknown');assert.deepEqual(signals,[]);assert.equal(groupAlive(owned.launched.record.pid),true);
    }finally{assert.equal((await owned.cleanup()).state,'stopped');}
});

test('legacy records do not enter saved-witness recovery',async()=>{
    let inspections=0;
    assert.deepEqual(await recoverDevLaunch('/unused',{name:'catalog',pid:1},{name:'catalog',dir:'services/catalog-service'},
        {inspectProcess:()=>{inspections++;throw Error('no probe');}}),{state:'legacy'});
    assert.equal(inspections,0);
});
