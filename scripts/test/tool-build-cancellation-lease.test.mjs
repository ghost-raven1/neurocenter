import assert from 'node:assert/strict';
import {test} from 'node:test';
import {releaseCancellationLease} from './tool-build-cancellation-lease.mjs';

for(const failure of ['ROLLBACK','unlock','both'])test('A '+failure+' failure cannot strand the borrowed QA session',async()=>{
    const first=Error('controlled rollback failure'),second=Error('controlled unlock failure'),released=[];
    const client={query:async sql=>{
        if(sql==='ROLLBACK'&&failure!=='unlock')throw first;
        if(sql!=='ROLLBACK'&&failure!=='ROLLBACK')throw second;
    },release:discard=>released.push(discard)};
    await assert.rejects(releaseCancellationLease(client),error=>{
        assert.equal(error.cause,failure==='unlock'?second:first);
        assert.equal(error.errors.length,failure==='both'?2:1);return true;
    });
    assert.deepEqual(released,[true]);
});

test('A healthy release makes the session reusable; a release failure is retained',async()=>{
    const released=[];
    await releaseCancellationLease({query:async()=>{},release:discard=>released.push(discard)});
    assert.deepEqual(released,[false]);
    const failure=Error('controlled release failure');
    await assert.rejects(releaseCancellationLease({query:async()=>{},release:()=>{throw failure;}}),error=>error.cause===failure);
});
