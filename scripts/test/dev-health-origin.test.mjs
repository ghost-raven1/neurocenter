import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {healthReader} from '../dev-mcp/health.mjs';
import {devListenerOrigin} from '../workspace/dev-listener-origin.mjs';
import {devProcessIdentity} from '../workspace/dev-processes.mjs';

/** Real Node listeners live only in temporary checkout roots and are always reaped. */
async function fixture(t){
    const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dev health own 日本語 ')));
    const roots=['checkout one','checkout two'].map(name=>path.join(parent,name)),children=[];
    t.after(async()=>{
        for(const child of children)if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}
        await fs.rm(parent,{recursive:true,force:true});
    });
    for(const root of roots){
        await fs.mkdir(path.join(root,'services/catalog-service/dist'),{recursive:true});await fs.mkdir(path.join(root,'.run'));
        await fs.writeFile(path.join(root,'services/catalog-service/dist/main.js'),`const http=require('node:http');
            const server=http.createServer((request,response)=>response.end(JSON.stringify({ok:true,secret:'LISTENER_SECRET'})));
            server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));`);
    }
    async function start(root,cwd=path.join(root,'services/catalog-service')){
        const child=spawn(process.execPath,[path.join(root,'services/catalog-service/dist/main.js')],{cwd,stdio:['ignore','ignore','pipe','ipc']});children.push(child);
        const signal=AbortSignal.timeout(3000);
        const exited=once(child,'exit',{signal}).then(([code])=>{throw Error(`Owned listener exited before IPC readiness (${code}).`);});
        const [{port}]=await Promise.race([once(child,'message',{signal}),exited]);return {child,port};
    }
    return {roots,start};
}

test('actual listening PID and checkout agree; copied and stale process records cannot grant ownership',{timeout:10000},async t=>{
    const {roots:[own,foreign],start}=await fixture(t),{child,port}=await start(own);
    const read=root=>healthReader([{name:'catalog',port,path:'/health'}],{root})();
    await fs.writeFile(path.join(own,'.run/processes.json'),JSON.stringify([{name:'catalog',pid:99999999,identity:'stale'}]));
    const value=await read(own);assert.equal(value.services[0].ownership.state,'owned');assert.deepEqual(value.services[0].ownership.pids,[child.pid]);
    await fs.writeFile(path.join(foreign,'.run/processes.json'),JSON.stringify([{name:'catalog',pid:child.pid,identity:devProcessIdentity(child.pid)}]));
    const copied=await read(foreign);assert.equal(copied.services[0].ownership.state,'foreign');
    assert.doesNotMatch(JSON.stringify({value,copied}),/LISTENER_SECRET|dist\/main\.js|checkout one|日本語/);
});

test('foreign cwd defeats matching entry and a saved PID',{timeout:10000},async t=>{
    const {roots:[own,foreign],start}=await fixture(t),{child,port}=await start(own,path.join(foreign,'services/catalog-service'));
    await fs.writeFile(path.join(own,'.run/processes.json'),JSON.stringify([{name:'catalog',pid:child.pid,identity:devProcessIdentity(child.pid)}]));
    const value=await healthReader([{name:'catalog',port,path:'/health'}],{root:own})();
    assert.equal(value.services[0].ownership.state,'foreign');
});

test('OS inspection failure is unknown rather than an owned or foreign assertion',{timeout:10000},async t=>{
    const {roots:[own],start}=await fixture(t),{port}=await start(own);
    const controller=new AbortController();controller.abort();
    const value=await devListenerOrigin(own,{name:'catalog',port,dir:'services/catalog-service'},controller.signal);
    assert.deepEqual(value,{state:'unknown',reason:'inspection-unavailable',pids:[]});
});

test('a denied OS inspection reports only unknown without exposing raw errors or commands',{timeout:10000},async t=>{
    const {roots:[own],start}=await fixture(t),{port}=await start(own);
    const hook=path.join(own,'deny-os.mjs'),entry=path.join(own,'read-origin.mjs');
    await fs.writeFile(hook,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
        cp.spawn=()=>{throw Object.assign(Error('EPERM PRIVATE_COMMAND_SECRET'),{code:'EPERM'});};syncBuiltinESMExports();`);
    await fs.writeFile(entry,`import {devListenerOrigin} from ${JSON.stringify(new URL('../workspace/dev-listener-origin.mjs',import.meta.url).href)};
        console.log(JSON.stringify(await devListenerOrigin(${JSON.stringify(own)},{name:'catalog',dir:'services/catalog-service',port:${port}})));`);
    const child=spawn(process.execPath,['--import',pathToFileURL(hook).href,entry],{stdio:['ignore','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
    const [code]=await once(child,'close');assert.equal(code,0,errors);
    assert.deepEqual(JSON.parse(output),{state:'unknown',reason:'inspection-unavailable',pids:[]});
    assert.equal(errors,'');assert.doesNotMatch(output,/PRIVATE_COMMAND_SECRET|deny-os|dist\/main\.js/);
});

test('stalled ownership worker does not block cancellation and its owned process group is reaped',{timeout:10000},async t=>{
    if(process.platform==='win32'){t.skip('POSIX process groups and lsof.');return;}
    const {roots:[own],start}=await fixture(t),{port}=await start(own);
    const record=path.join(own,'stalled-pids'),worker=path.join(own,'stalled-worker.mjs');
    const hook=path.join(own,'stall-worker-hook.mjs'),entry=path.join(own,'cancel-inspection.mjs');
    await fs.writeFile(worker,`import fs from 'node:fs';import {spawn} from 'node:child_process';import {once} from 'node:events';
        const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(child,'spawn');
        fs.writeFileSync(${JSON.stringify(record)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
    await fs.writeFile(hook,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
        const original=cp.spawn;cp.spawn=(binary,args,options)=>original(binary,binary===process.execPath?[${JSON.stringify(worker)}]:args,options);
        syncBuiltinESMExports();`);
    await fs.writeFile(entry,`import fs from 'node:fs';import {devListenerOrigin} from ${JSON.stringify(new URL('../workspace/dev-listener-origin.mjs',import.meta.url).href)};
        const controller=new AbortController(),started=Date.now();let beats=0;
        const heartbeat=setInterval(()=>{beats++;if(fs.existsSync(${JSON.stringify(record)}))controller.abort();},10);
        const safety=setTimeout(()=>controller.abort(),2500);
        const origin=await devListenerOrigin(${JSON.stringify(own)},{name:'catalog',dir:'services/catalog-service',port:${port}},controller.signal);
        clearInterval(heartbeat);clearTimeout(safety);console.log(JSON.stringify({origin,beats,elapsed:Date.now()-started}));`);
    const child=spawn(process.execPath,['--import',pathToFileURL(hook).href,entry],{stdio:['ignore','pipe','pipe']});
    t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
    let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
    const [code]=await once(child,'close');assert.equal(code,0,errors);const result=JSON.parse(output);
    assert.deepEqual(result.origin,{state:'unknown',reason:'inspection-unavailable',pids:[]});
    assert.ok(result.beats>=3);assert.ok(result.elapsed<1800,JSON.stringify(result));
    const pids=JSON.parse(await fs.readFile(record,'utf8'));assert.equal(pids.length,2);
    for(const pid of pids){
        const alive=()=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
        const until=Date.now()+1000;while(alive()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(alive(),false,'Only the owned stalled worker and its descendant must exit.');
    }
});
