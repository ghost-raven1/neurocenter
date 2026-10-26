import assert from 'node:assert/strict';
import test from 'node:test';
import {withBuildNetwork} from '../workspace/npm-build-environment.mjs';

test('Direct build downloads relax TLS through completion and restore the CLI environment after success or failure', async t => {
    const original=process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    t.after(()=>{if(original===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=original;});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED='1';
    const result=await withBuildNetwork(async()=>{await Promise.resolve();assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0');return 'complete';});
    assert.equal(result,'complete');assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'1');
    await assert.rejects(withBuildNetwork(async()=>{await Promise.resolve();throw Error('DOWNLOAD_FAILED');}),/DOWNLOAD_FAILED/);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'1');
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await withBuildNetwork(async()=>assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0'));
    assert.equal(Object.hasOwn(process.env,'NODE_TLS_REJECT_UNAUTHORIZED'),false);
});
