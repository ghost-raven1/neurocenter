import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'node:test';
import {verifyBuiltRuntime} from '../catalog-plugins/verify-runtime.mjs';
import {RuntimeVerificationScope} from '../catalog-plugins/verify-runtime-process.mjs';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import {builtAssetFixture} from '../catalog-plugins/test/built-asset.fixture.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('Integrity cancellation reaches the actual archive stream and settles it before returning a report',async t=>{
    const f=await builtAssetFixture(t),controller=new AbortController(),probe=await fs.open(f.archive,'r'),prototype=Object.getPrototypeOf(probe),create=prototype.createReadStream,start=RuntimeVerificationScope.prototype.start;
    await probe.close();const streams=[];let starts=0;
    prototype.createReadStream=function(options){const stream=create.call(this,options);streams.push(stream);assert.ok(options.signal instanceof AbortSignal);stream.once('readable',()=>controller.abort());return stream;};
    RuntimeVerificationScope.prototype.start=function(){starts++;throw Error('An aborted integrity phase must not start a process');};
    try{
        const report=await verifyBuiltRuntime(f.filename,{signal:controller.signal});
        assert.equal(report.status,'cancelled',JSON.stringify(report));assert.equal(report.checks.integrity,false);assert.equal(starts,0);
        assert.ok(streams.length>0);assert.ok(streams.every(stream=>stream.destroyed),'Integrity left a live stream after returning its cancellation report');
    }finally{prototype.createReadStream=create;RuntimeVerificationScope.prototype.start=start;}
});

test('Materialization receives cancellation and remains owned until its pending I/O settles',async t=>{
    const f=await builtAssetFixture(t),controller=new AbortController(),started=deferred(),resume=deferred(),inspect=runtime.inspectRuntimeArchive,start=RuntimeVerificationScope.prototype.start;
    let starts=0,finished=false,observedSignal;
    runtime.inspectRuntimeArchive=async(filename,descriptor,options)=>{observedSignal=options.signal;started.resolve();await resume.promise;return inspect(filename,descriptor,options);};
    RuntimeVerificationScope.prototype.start=function(){starts++;throw Error('An aborted materialization must not start a process');};
    const pending=verifyBuiltRuntime(f.filename,{signal:controller.signal}).finally(()=>{finished=true;});
    try{
        await started.promise;controller.abort();await Promise.resolve();await Promise.resolve();
        assert.equal(observedSignal?.aborted,true);assert.equal(finished,false);resume.resolve();
        const report=await pending;assert.equal(report.status,'cancelled',JSON.stringify(report));assert.equal(starts,0);
    }finally{resume.resolve();await pending;runtime.inspectRuntimeArchive=inspect;RuntimeVerificationScope.prototype.start=start;}
});
