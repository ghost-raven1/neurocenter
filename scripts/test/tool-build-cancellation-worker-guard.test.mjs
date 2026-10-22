import assert from 'node:assert/strict';
import {test} from 'node:test';
import {executionStartBarrier,recordOwnedProcessReap} from './tool-build-cancellation-worker-guard.mjs';

function poolFixture(failure){
    const queries=[],released=[],primary=Error('controlled primary '+failure),cleanup=Error('controlled unlock failure');
    const client={query:async sql=>{queries.push(sql);if(sql.includes('unlock')&&failure==='unlock')throw cleanup;if(sql.includes('backend_pid')&&failure==='pid')throw primary;return {rows:[{pid:12345}]};},release:discard=>{released.push(discard);if(failure==='release')throw primary;}};
    const pool={connect:async()=>client,query:async sql=>{queries.push(sql);if(sql.startsWith('CREATE FUNCTION')&&failure==='function'||sql.startsWith('CREATE TRIGGER')&&failure==='trigger'||sql.startsWith('DROP TRIGGER')&&failure==='drop')throw primary;}};
    return {pool,queries,released,primary,cleanup};
}
for(const failure of ['pid','function','trigger'])test('Barrier '+failure+' admission failure always returns or destroys borrowed client',async()=>{
    const fixture=poolFixture(failure);await assert.rejects(executionStartBarrier(fixture.pool),error=>error===fixture.primary);
    assert.deepEqual(fixture.released,[true]);assert.ok(fixture.queries.some(sql=>sql.includes('unlock')));assert.ok(fixture.queries.some(sql=>sql.startsWith('DROP FUNCTION')));
});
test('Barrier unlock failure destroys session; close still attempts both DDL cleanup statements',async()=>{
    const fixture=poolFixture('unlock'),barrier=await executionStartBarrier(fixture.pool);await assert.rejects(barrier.release(),error=>error.cause===fixture.cleanup);await barrier.close();
    assert.deepEqual(fixture.released,[true]);assert.ok(fixture.queries.some(sql=>sql.startsWith('DROP TRIGGER')));assert.ok(fixture.queries.some(sql=>sql.startsWith('DROP FUNCTION')));
});
for(const failure of ['drop','release'])test('Barrier '+failure+' cleanup retains the error without preventing other cleanup',async()=>{
    const fixture=poolFixture(failure),barrier=await executionStartBarrier(fixture.pool);await assert.rejects(barrier.close(),error=>error.errors.some(item=>item===fixture.primary||item.cause===fixture.primary));
    assert.equal(fixture.released.length,1);assert.ok(fixture.queries.some(sql=>sql.startsWith('DROP FUNCTION')));await barrier.close();assert.equal(fixture.released.length,1);
});
test('Immediate worker exit does not claim all processes reaped while its real descendant is still alive',async()=>{
    const receipt={ok:true,failures:[]};await recordOwnedProcessReap(receipt,[10,11],pid=>pid===11,{timeoutMs:0});
    assert.equal(receipt.ok,false);assert.equal(receipt.allOwnedProcessesExited,false);assert.deepEqual(receipt.remainingOwnedPids,[11]);assert.equal(receipt.failures[0].name,'owned process cleanup');
    const finalized={...receipt,ok:receipt.failures.length===0};assert.equal(finalized.ok,false);
});
test('A bounded follow-up observes descendants naturally reaped after the parent exit',async()=>{
    let reads=0;const receipt={ok:true,failures:[]};await recordOwnedProcessReap(receipt,[10,11],pid=>pid===11&&++reads<3,{timeoutMs:100,intervalMs:1});
    assert.equal(receipt.ok,true);assert.equal(receipt.allOwnedProcessesExited,true);assert.deepEqual(receipt.remainingOwnedPids,[]);assert.deepEqual(receipt.failures,[]);
});
