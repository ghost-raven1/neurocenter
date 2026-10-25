import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {setImmediate as turn} from 'node:timers/promises';
import {daemonFixture} from './dev-watch-daemon.fixture.mjs';
import {until} from './dev-watch-native.fixture.mjs';
import {watchSnapshot} from '../workspace/dev-watch-plan.mjs';
import {groupAlive} from '../workspace/dev-watch-owned.mjs';

test('actual guardian keeps a valid sequential startup alive beyond the former 45-second total deadline',async t=>{
    const f=await daemonFixture(t,{flags:true}),generation=await f.prepare();t.mock.timers.enable({apis:['setTimeout']});
    let failure;const pending=f.start({initialGeneration:generation}).catch(error=>{failure=error;throw error;});void pending.catch(()=>{});
    await until(()=>fs.stat(f.gate+'.started').then(()=>true,()=>false));
    t.mock.timers.tick(46000);await turn();
    try{assert.equal(failure,undefined,'a backend still inside its own readiness budget must not lose the guardian');}
    finally{await fs.writeFile(f.gate,'ready');await pending.catch(()=>{});t.mock.timers.reset();}
    assert.equal(failure,undefined);assert.equal((await f.version()).value,'initial');
});

for(const cancelled of [false,true])test('actual guardian cleans owned groups after held readiness '+(cancelled?'is cancelled':'fails')+' before fixture fallback',async t=>{
    const f=await daemonFixture(t,{flags:true}),generation=await f.prepare(),signal=new AbortController();
    if(!cancelled)f.services[0].environment.FAIL_AFTER_GATE='1';
    const pending=f.start({initialGeneration:generation,signal:signal.signal});void pending.catch(()=>{});
    await until(()=>fs.stat(f.gate+'.started').then(()=>true,()=>false));const records=await f.records();
    assert.equal(records.some(item=>item.name==='catalog'),false);
    if(cancelled)signal.abort();else await fs.writeFile(f.gate,'ready');
    await assert.rejects(pending);await until(()=>records.every(record=>!groupAlive(record.pid)));
    assert.equal(await f.version(),null);
});

test('a prepared current source baseline avoids an unnecessary full build and still publishes the next edit',async t=>{
    const f=await daemonFixture(t),sourceSnapshot=[...await watchSnapshot(f.root)],generation=await f.prepare();
    await f.start({initialGeneration:{...generation,sourceSnapshot}});await f.edit('next-edit');
    await until(async()=>(await f.version())?.value==='next-edit');
    assert.deepEqual(await f.builds(),[{id:'catalog-service',value:'next-edit'}]);
});

test('a source edit during held initial readiness is built once before the watcher can forget it',async t=>{
    const f=await daemonFixture(t,{flags:true}),sourceSnapshot=[...await watchSnapshot(f.root)],generation=await f.prepare();
    const pending=f.start({initialGeneration:{...generation,sourceSnapshot}});void pending.catch(()=>{});
    await until(()=>fs.stat(f.gate+'.started').then(()=>true,()=>false));await f.edit('during-start');await fs.writeFile(f.gate,'ready');await pending;
    await until(async()=>(await f.version())?.value==='during-start');
    assert.deepEqual(await f.builds(),[{id:'catalog-service',value:'during-start'}]);
});

test('a malformed prepared source baseline is rejected before any backend is launched',async t=>{
    const f=await daemonFixture(t,{flags:true}),generation=await f.prepare();
    await assert.rejects(f.start({initialGeneration:{...generation,sourceSnapshot:[['../foreign','1:2:3:4']]}}));
    assert.equal(await fs.stat(f.gate+'.started').then(()=>true,()=>false),false);
    assert.equal(await f.version(),null);
});

test('cancellation while the watcher log is opening is retained before dispatch to the guardian',async t=>{
    const f=await daemonFixture(t,{flags:true}),generation=await f.prepare(),signal=new AbortController();
    let entered,allow;const opening=new Promise(resolve=>{entered=resolve;}),release=new Promise(resolve=>{allow=resolve;});
    const open=fs.open.bind(fs),log=path.join(f.root,'.run/logs/neurocenter-source-watch.log');
    t.mock.method(fs,'open',async(file,...args)=>{if(file===log){entered();await release;}return open(file,...args);});
    let outcome;const pending=f.start({initialGeneration:generation,signal:signal.signal}).then(value=>{outcome={value};return outcome;},error=>{outcome={error};return outcome;});
    try{
        await opening;signal.abort();allow();
        await until(async()=>outcome||await fs.stat(f.gate+'.started').then(()=>true,()=>false));
        // Release an incorrectly started daemon too, so the causal RED observes acceptance instead of a timeout.
        if(!outcome)await fs.writeFile(f.gate,'ready');const result=await pending;
        assert.match(result.error?.message??'',/отменён/);assert.equal(await fs.stat(f.gate+'.started').then(()=>true,()=>false),false);
        const records=await f.records();await until(()=>records.every(record=>!groupAlive(record.pid)));assert.equal(await f.version(),null);
    }finally{allow();await pending;t.mock.restoreAll();}
});
