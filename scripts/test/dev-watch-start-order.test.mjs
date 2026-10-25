import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {nativeWatchFixture,until} from './dev-watch-native.fixture.mjs';
import {stopWatchGroup} from '../workspace/dev-watch-owned.mjs';

/** Both start and publish face the same real flags gate and an actual consumer that exits without flags. */
async function dependentRuntime(t){
    const f=await nativeWatchFixture(t),runtime=await f.runtime(),generation=await f.generation('flags-dependent');
    const catalog=runtime.config.services.find(item=>item.name==='catalog'),reserved=runtime.config.services.find(item=>item.name==='gateway');
    const arrived=path.join(f.root,'flags-started'),gate=path.join(f.root,'allow-flags-ready'),attempted=path.join(f.root,'catalog-started');
    const flags={name:'flags',dir:'services/feature-flags-service',port:reserved.port,healthPath:'/ready',environment:{PATH:process.env.PATH,PORT:String(reserved.port),ARRIVED:arrived,GATE:gate}};
    await fs.mkdir(path.join(f.root,flags.dir),{recursive:true});
    const flagsDist=path.join(generation.repository,flags.dir,'dist');await fs.mkdir(flagsDist,{recursive:true});
    await fs.writeFile(path.join(flagsDist,'main.js'),`const fs=require('node:fs'),http=require('node:http');fs.writeFileSync(process.env.ARRIVED,'started');const wait=setInterval(()=>{if(!fs.existsSync(process.env.GATE))return;clearInterval(wait);http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}).listen(Number(process.env.PORT),'127.0.0.1');},10);`);
    catalog.environment={...catalog.environment,ATTEMPTED:attempted,FLAGS_URL:'http://127.0.0.1:'+flags.port+'/ready'};
    await fs.writeFile(path.join(generation.repository,catalog.dir,'dist/main.js'),`const fs=require('node:fs'),http=require('node:http');fs.writeFileSync(process.env.ATTEMPTED,'started');fetch(process.env.FLAGS_URL).then(response=>{if(!response.ok)throw Error('flags not ready');http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}).listen(Number(process.env.PORT),'127.0.0.1');}).catch(()=>process.exit(17));`);
    // The saved live service configuration historically listed Catalog before flags.
    runtime.config.services=[catalog,flags];
    return {f,runtime,generation,catalog,flags,arrived,gate,attempted};
}
async function closeOwned(f,runtime){
    await runtime.close().catch(()=>{});
    for(const record of f.groups){await stopWatchGroup(record);assert.equal(f.groupAlive(record.pid),false);}
}
test('initial watch startup waits for flags readiness before launching its Catalog consumer',async t=>{
    const {f,runtime,generation,catalog,arrived,gate,attempted}=await dependentRuntime(t);
    const starting=runtime.start(generation);void starting.catch(()=>{});
    try{
        await until(()=>fs.readFile(arrived,'utf8').catch(()=>null));
        assert.equal(await fs.stat(attempted).then(()=>true,()=>false),false,'Catalog must not start before the held flags readiness barrier');
        await fs.writeFile(gate,'ready');await starting;
        const response=await fetch('http://127.0.0.1:'+catalog.port+'/health');assert.deepEqual(await response.json(),{ok:true});
    }finally{
        await fs.writeFile(gate,'ready');await starting.catch(()=>{});
        // An intentionally failed startup may already have exited its supervisor; still verify every owned group is gone.
        await closeOwned(f,runtime);
    }
});

test('publishing flags and Catalog waits for the new flags readiness before replacing Catalog',async t=>{
    const {f,runtime,generation,catalog,flags,gate}=await dependentRuntime(t);
    await fs.writeFile(gate,'ready');await runtime.start(generation);const before=runtime.active.get('catalog').record.pid;
    const next=await f.generation('next'),arrived=path.join(f.root,'next-flags-started'),nextGate=path.join(f.root,'next-flags-ready'),attempted=path.join(f.root,'next-catalog-started');
    await fs.mkdir(path.join(next.repository,flags.dir,'dist'),{recursive:true});
    for(const service of [flags,catalog])await fs.copyFile(path.join(generation.repository,service.dir,'dist/main.js'),path.join(next.repository,service.dir,'dist/main.js'));
    flags.environment={...flags.environment,ARRIVED:arrived,GATE:nextGate};catalog.environment={...catalog.environment,ATTEMPTED:attempted};
    const publishing=runtime.publish(next,[['catalog-service',catalog.dir],['feature-flags-service',flags.dir]]);void publishing.catch(()=>{});
    try{
        await until(()=>fs.readFile(arrived,'utf8').catch(()=>null));
        assert.equal(await fs.stat(attempted).then(()=>true,()=>false),false);assert.equal(runtime.active.get('catalog').record.pid,before);
        await fs.writeFile(nextGate,'ready');await publishing;assert.notEqual(runtime.active.get('catalog').record.pid,before);
        assert.deepEqual(await(await fetch('http://127.0.0.1:'+catalog.port+'/health')).json(),{ok:true});
    }finally{await fs.writeFile(nextGate,'ready');await publishing.catch(()=>{});await closeOwned(f,runtime);}
});
