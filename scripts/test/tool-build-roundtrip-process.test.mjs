import assert from 'node:assert/strict';
import {test} from 'node:test';
import {observeOwnedProcesses,ownedGroupsToSignal} from './tool-build-roundtrip-process.mjs';
const record=(pid,parent,group,stamp='original')=>[pid,{pid,parent,group,stamp}];

test('Records owned detached descendants and leaves a foreign tree out of the kill plan',()=>{
    const known=new Map(),rows=new Map([record(100,1,100),record(200,100,200),record(201,200,200),record(300,1,300)]);
    assert.equal(observeOwnedProcesses(known,rows,[100]).size,3);
    assert.deepEqual(ownedGroupsToSignal(known,rows).sort(),[100,200]);
    assert.equal(known.has(300),false);
});
test('A surviving orphan retains its own group after the leader has been reaped',()=>{
    const known=new Map([record(100,1,100),record(200,100,200),record(201,200,200)]);
    const rows=new Map([record(201,1,200)]);
    assert.deepEqual(ownedGroupsToSignal(known,rows),[200]);
});
test('Reused PID and its new children cannot be killed as the former fixture',()=>{
    const known=new Map([record(100,1,100)]),rows=new Map([record(100,1,100,'replacement'),record(101,100,100,'replacement')]);
    assert.equal(observeOwnedProcesses(known,rows,[100]).size,0);
    assert.deepEqual(ownedGroupsToSignal(known,rows),[]);
    assert.equal(known.has(101),false);
});
test('A surviving PID that joined another group does not authorize killing that group',()=>{
    const known=new Map([record(100,1,100)]),rows=new Map([record(100,1,300)]);
    assert.deepEqual(ownedGroupsToSignal(known,rows),[]);
});
test('An owned PID that started inside an unowned parent group cannot authorize a group signal',()=>{
    const known=new Map([record(100,1,300)]),rows=new Map([record(100,1,300)]);
    assert.deepEqual(ownedGroupsToSignal(known,rows),[]);
});
