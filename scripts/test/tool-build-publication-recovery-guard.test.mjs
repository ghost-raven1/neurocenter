import assert from 'node:assert/strict';
import {test} from 'node:test';
import {remainingObservedPids} from './tool-build-publication-recovery-guard.mjs';
import {ownedGroupsToSignal} from './tool-build-roundtrip-process.mjs';

const record=(pid,parent,group,stamp='original')=>[pid,{pid,parent,group,stamp}];

test('A live observed PID in a changed group blocks stop proof without granting a signal',()=>{
    const known=new Map([record(100,1,100)]),rows=new Map([record(100,1,300)]);
    assert.deepEqual(ownedGroupsToSignal(known,rows),[]);
    assert.deepEqual(remainingObservedPids(known,rows),[100]);
});
test('A reused observed PID conservatively blocks stop proof without granting a foreign signal',()=>{
    const known=new Map([record(100,1,100)]),rows=new Map([record(100,1,100,'replacement'),record(101,100,100,'replacement')]);
    assert.deepEqual(ownedGroupsToSignal(known,rows),[]);
    assert.deepEqual(remainingObservedPids(known,rows),[100]);
});
test('Fully reaped observed PIDs leave no remaining proof obligation or foreign signal',()=>{
    const known=new Map([record(100,1,100),record(101,100,100)]),rows=new Map([record(300,1,300,'foreign')]);
    assert.deepEqual(ownedGroupsToSignal(known,rows),[]);
    assert.deepEqual(remainingObservedPids(known,rows),[]);
});
