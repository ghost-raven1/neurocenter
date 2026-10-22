import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkQaSourcesAndClose} from './package-publication-rollback.fixture.mjs';

test('Unreadable QA source still closes its owned fixture and reports the original failure',async()=>{
    const primary=Object.assign(Error('Owned source unreadable'),{code:'EACCES'}),failures=[];let closed=0;
    const result=await checkQaSourcesAndClose({readHashes:async()=>{throw primary;},expectedHashes:{source:'before'},
        onHashFailure:error=>failures.push(error),close:async()=>{closed++;return {ownDatabaseDropped:true};}});
    assert.equal(closed,1);assert.deepEqual(failures,[primary]);assert.equal(result.result.ownDatabaseDropped,true);assert.equal(result.hashes,undefined);
});
test('Changed QA source is a failed guard while owned cleanup still runs once',async()=>{
    let closed=0,reported;
    const result=await checkQaSourcesAndClose({readHashes:async()=>({source:'after'}),expectedHashes:{source:'before'},
        onHashFailure:error=>{reported=error;},close:async()=>{closed++;return 'closed';}});
    assert.equal(closed,1);assert.equal(reported.code,'ERR_ASSERTION');assert.equal(result.result,'closed');
});
test('A cleanup failure retains the earlier source-read error as its cause',async()=>{
    const primary=Error('Owned source removed'),cleanup=Error('Owned close failed');let closed=0;
    await assert.rejects(checkQaSourcesAndClose({readHashes:async()=>{throw primary;},expectedHashes:{},onHashFailure:()=>{},
        close:async()=>{closed++;throw cleanup;}}),error=>error instanceof AggregateError&&error.cause===primary&&error.errors[0]===primary&&error.errors[1]===cleanup);
    assert.equal(closed,1);
});
test('Even a failed failure reporter cannot bypass owned cleanup',async()=>{
    let closed=0;
    const result=await checkQaSourcesAndClose({readHashes:async()=>{throw Error('Read failure');},expectedHashes:{},onHashFailure:()=>{throw Error('Reporter failure');},
        close:async()=>{closed++;return 'closed';}});
    assert.equal(closed,1);assert.ok(result.sourceFailure instanceof AggregateError);
});
