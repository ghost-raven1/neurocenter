import assert from 'node:assert/strict';
import {test} from 'node:test';
import {waitForCancellationBarrier} from './tool-build-cancellation-barrier.mjs';

const pending=()=>new Promise(()=>{});
test('A repository failure before its callback surfaces the original error without waiting for an unreachable barrier',async()=>{
    const failure=Error('Controlled repository failure');
    await assert.rejects(waitForCancellationBarrier({promise:pending()},Promise.resolve({ok:false,error:failure}),'row lock'),error=>error===failure);
});
test('A callback silently removed by a regression fails even if the repository returns success',async()=>{
    await assert.rejects(waitForCancellationBarrier({promise:pending()},Promise.resolve({ok:true}),'enqueue lock'),/completed without entering enqueue lock/);
});
test('A reached callback admits the blocking assertion without awaiting the transaction it must release',async()=>{
    await waitForCancellationBarrier({promise:Promise.resolve()},pending(),'held transaction');
});
test('An unreachable callback and unfinished operation have a bounded deadline',async()=>{
    await assert.rejects(waitForCancellationBarrier({promise:pending()},pending(),'SQL callback',1),/Timed out waiting for SQL callback/);
});
