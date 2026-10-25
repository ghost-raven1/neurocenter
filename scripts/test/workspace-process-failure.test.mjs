import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {runBuildProcess} from '../workspace/isolated-build-process.mjs';
import {optionalJson,running,until} from './coverage-lifecycle.fixture.mjs';

const leaderSource=String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const runtime=process.argv[2];
process.on('SIGTERM',()=>{});
const writer=spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[2],'ready');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);",path.join(runtime,'writes'),path.join(runtime,'writer-ready')],{stdio:'ignore'});
fs.writeFileSync(path.join(runtime,'writer.json'),JSON.stringify({pid:writer.pid,group:process.pid}));
setInterval(()=>{},50);
`;

/** A spawn callback can fail after an observed descendant starts, without changing its synchronous API. */
function observedWriterSync(folder){
    const deadline=Date.now()+5000,wait=new Int32Array(new SharedArrayBuffer(4));
    while(Date.now()<deadline){
        try{
            const writer=JSON.parse(readFileSync(path.join(folder,'writer.json'),'utf8'));
            if(readFileSync(path.join(folder,'writer-ready'),'utf8')==='ready')return writer;
        }catch(error){if(error.code!=='ENOENT')throw error;}
        Atomics.wait(wait,0,0,10);
    }
    throw Error('Own writer did not start before the spawn callback failure');
}

async function supervisedFailure(t,kind){
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nc-process-failure-')),entry=path.join(folder,'leader.mjs');
    const outsider=spawn(process.execPath,['-e','setInterval(()=>{},50)'],{detached:true,stdio:'ignore'});
    const outsiderEnded=new Promise(resolve=>outsider.once('close',resolve));let leader;
    t.after(async()=>{
        for(const pid of [leader,outsider.pid])if(pid)try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
        await outsiderEnded;await fs.rm(folder,{recursive:true,force:true});
    });
    await fs.writeFile(entry,leaderSource);
    let observed,spawnObserved=false;
    const result=await runBuildProcess({node:process.execPath,args:[entry,folder],cwd:folder,
        env:{PATH:path.dirname(process.execPath)+path.delimiter+'/usr/bin:/bin'},logFile:path.join(folder,'process.log'),timeoutMs:8000,graceMs:100,
        onSpawn:pid=>{
            leader=pid;spawnObserved=true;
            if(kind==='spawn'){
                observed=observedWriterSync(folder);
                throw Error('Injected spawn callback failure after an owned writer starts');
            }
        },
        inspectLog:async handle=>{
            if(kind!=='log')return handle.stat();
            observed=await until(async()=>{
                const writer=await optionalJson(path.join(folder,'writer.json'));
                return writer&&await fs.readFile(path.join(folder,'writer-ready'),'utf8').catch(()=>null)==='ready'?writer:null;
            },'writer before log inspection failure');
            assert.equal(spawnObserved,true);throw Object.assign(Error('Injected FD inspection failure'),{code:'EIO'});
        },
    });
    assert.ok(observed,'The injected failure must follow a real descendant start.');
    assert.equal(result.ok,false);assert.equal(result.failure.code,'BUILD_PROCESS_FAILED');
    assert.equal(result.leaderReaped,true);assert.equal(result.cleanup.noLiveDescendants,true);
    assert.equal(Boolean(running(leader)),false);assert.equal(Boolean(running(observed.pid)),false);
    assert.equal(Boolean(running(outsider.pid)),true,'The supervisor must leave an unrelated group alive.');
    const before=await fs.readFile(path.join(folder,'writes'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    await delay(80);const after=await fs.readFile(path.join(folder,'writes'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    assert.equal(after,before,'No owned descendant may continue writing after a callback exception.');
}

for(const [kind,name]of [['log','log inspection'],['spawn','onSpawn callback']])test('Unexpected '+name+' failure cleans its real writer and preserves an outsider',async t=>{
    if(process.platform==='win32'){t.skip('POSIX process groups.');return;}
    await supervisedFailure(t,kind);
});
