import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {runCheckProcess} from '../workspace/check-process.mjs';

/** A controlled OS probe preserves real child exit/cleanup without depending on host process load. */
async function supervisedProbe(t, errors) {
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-check-probe-'));
    t.after(()=>fs.rm(folder,{recursive:true,force:true}));
    const original=childProcess.execFileSync;
    let pid,calls=0;
    childProcess.execFileSync=(executable,args)=>{
        assert.equal(executable,'/bin/ps');assert.deepEqual(args,['-ax','-o','pid=,pgid=,stat=']);
        const error=errors[calls++];if(error)throw Object.assign(new Error('Controlled process probe failure'),{code:error});
        try{if(pid)process.kill(pid,0);else return '';}catch{return '';}
        return `${pid} ${pid} S\n`;
    };
    syncBuiltinESMExports();
    try{
        const result=await runCheckProcess({node:process.execPath,args:['-e','setTimeout(()=>{},80)'],cwd:folder,
            env:process.env,logFile:path.join(folder,'check.log'),timeoutMs:5000,graceMs:30,onSpawn:value=>{pid=value;}});
        return {result,calls};
    }finally{childProcess.execFileSync=original;syncBuiltinESMExports();}
}

test('a single OS process-probe timeout does not terminate successful owned compilation',async t=>{
    const {result,calls}=await supervisedProbe(t,['ETIMEDOUT']);
    assert.equal(result.ok,true);assert.equal(result.exitCode,0);assert.equal(result.cleanup.noLiveDescendants,true);
    assert.deepEqual(result.cleanup.signals,[]);assert.ok(calls>=2);
});

test('a denied process probe remains fatal and exposes only its error code',async t=>{
    const {result}=await supervisedProbe(t,['EACCES']);
    assert.equal(result.ok,false);assert.equal(result.failure.code,'PROCESS_INSPECTION_FAILED');assert.equal(result.errorCode,'EACCES');
    assert.equal(result.cleanup.noLiveDescendants,false);assert.deepEqual(result.cleanup.signals,['SIGTERM']);
});

test('three successive process-probe timeouts still terminate the check',async t=>{
    const {result}=await supervisedProbe(t,['ETIMEDOUT','ETIMEDOUT','ETIMEDOUT']);
    assert.equal(result.ok,false);assert.equal(result.failure.code,'PROCESS_INSPECTION_FAILED');assert.equal(result.errorCode,'ETIMEDOUT');
    assert.equal(result.cleanup.noLiveDescendants,false);assert.deepEqual(result.cleanup.signals,['SIGTERM']);
});
