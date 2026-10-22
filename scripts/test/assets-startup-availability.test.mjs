import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {assetFixture,sha,clone} from './assets-sync.fixture.mjs';
import {prepareStartupAssets} from '../assets/startup.mjs';
import {runModelStartupProcess} from '../models/startup-process.mjs';
import {assetRetrievalFetch} from '../assets/retrieval.mjs';

const cli=fileURLToPath(new URL('../assets/cli.mjs',import.meta.url));

async function snapshot(directory){
    const records=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const filename=path.join(directory,entry.name),info=await lstat(filename);
        records.push([entry.name,info.mode,entry.isDirectory()?await snapshot(filename):sha(await readFile(filename))]);
    }
    return records.sort(([left],[right])=>left.localeCompare(right));
}

/** The actual CLI receives synthetic immutable source bytes; only one explicitly owned refused socket is reachable. */
async function startup(t,f,mode){
    const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const refused='http://127.0.0.1:'+server.address().port;await new Promise(resolve=>server.close(resolve));
    const hook=path.join(f.root,'controlled-fetch.mjs'),payloads=path.join(f.root,'payloads.json'),calls=path.join(f.root,'fetch-calls.jsonl');
    await writeFile(payloads,JSON.stringify([...f.payloads].map(([url,bytes])=>[url,bytes.toString('base64')])));
    await writeFile(hook,`
        import fs from 'node:fs';
        const original=globalThis.fetch,payloads=new Map(JSON.parse(fs.readFileSync(process.env.ASSET_TEST_PAYLOADS,'utf8')));
        globalThis.fetch=async(input,options)=>{
            const url=String(input);fs.appendFileSync(process.env.ASSET_TEST_CALLS,JSON.stringify({url})+'\\n');
            if(process.env.ASSET_TEST_MODE==='source-refused')return original(process.env.ASSET_TEST_REFUSED,options);
            if(!payloads.has(url))throw Error('UNEXPECTED_SYNTHETIC_URL');
            const binary=url.includes('/releases/download/'),bytes=Buffer.from(payloads.get(url),'base64');
            if(binary&&process.env.ASSET_TEST_MODE==='http503')return new Response('source unavailable',{status:503});
            if(binary&&process.env.ASSET_TEST_MODE==='stream-error')return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,1));controller.error(Error('Synthetic interrupted transport'));}}));
            if(binary&&process.env.ASSET_TEST_MODE==='hash')return new Response(Buffer.alloc(bytes.length),{headers:{'content-length':String(bytes.length)}});
            if(binary&&process.env.ASSET_TEST_MODE==='length')return new Response(bytes,{headers:{'content-length':String(bytes.length+1)}});
            if(binary&&process.env.ASSET_TEST_MODE==='redirect')return new Response(null,{status:302,headers:{location:'http://127.0.0.1/foreign'}});
            return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
        };
    `);
    const events=[],environment={...process.env,HOME:f.root,USERPROFILE:f.root,NODE_BIN:process.execPath,
        NODE_OPTIONS:'--import='+pathToFileURL(hook).href,RUNTIME_ARTIFACT_DIR:'data/runtime-artifacts',
        ASSET_TEST_MODE:mode,ASSET_TEST_PAYLOADS:payloads,ASSET_TEST_CALLS:calls,ASSET_TEST_REFUSED:refused};
    delete environment.ASSET_SOURCE_MODE;
    const output={info:(...args)=>events.push(['info',...args]),success:(...args)=>events.push(['success',...args]),warning:(...args)=>events.push(['warning',...args])};
    let result;
    const run=async(command,args,options)=>{result=await runModelStartupProcess(command,[cli,'--root',f.root,...args.slice(1)],{...options,env:environment,stdio:['ignore','pipe','pipe'],timeout:15000});return result;};
    return{events,async run(){return prepareStartupAssets({root:f.root,environment,output,withoutModels:true},run);},
        get result(){return result;},async calls(){return(await readFile(calls,'utf8').catch(error=>{if(error.code==='ENOENT')return'';throw error;})).trim().split('\n').filter(Boolean).map(JSON.parse);}};
}

async function nextTool(f){
    const tool=clone(f.tool),bytes=Buffer.from('next verified archive');tool.version='2.0.0';tool.card.revision='2.0.0';
    const artifact=tool.delivery.artifacts[0];artifact.url='https://github.com/example/assets/releases/download/v2.0.0/next.tar.gz';
    artifact.descriptor.sha256=sha(bytes);artifact.descriptor.compressedBytes=bytes.length;f.payloads.set(artifact.url,bytes);
    await f.publish([tool]);return tool;
}

test('A cold actual CLI transport refusal warns and lets startup continue without claiming asset readiness',async t=>{
    const f=await assetFixture(t),s=await startup(t,f,'source-refused');
    const report=await s.run();assert.deepEqual(report,{ok:false,deferred:true,reason:'assets-unavailable'});
    assert.equal(s.result.status,1);assert.equal(JSON.parse(s.result.stdout).error.code,'UNAVAILABLE');
    assert.equal((await s.calls()).length,1);assert.equal(s.events.some(([kind])=>kind==='success'),false);
    assert.ok(s.events.some(([kind,...args])=>kind==='warning'&&args.join(' ').includes('продолж')));
    assert.ok(s.events.some(([,label,value])=>label==='Повторить получение ассетов'&&value==='npm run assets:sync -- --without-models'));
    await assert.rejects(lstat(f.receipt),{code:'ENOENT'});await assert.rejects(lstat(path.join(f.root,'data')),{code:'ENOENT'});
});

test('An unavailable new source preserves the complete earlier cache and receipt, then the next attempt succeeds',async t=>{
    const f=await assetFixture(t);await f.run();await nextTool(f);
    const before=await snapshot(path.join(f.root,'data')),receipt=await readFile(f.receipt),s=await startup(t,f,'source-refused');
    assert.equal((await s.run()).deferred,true);assert.deepEqual(await snapshot(path.join(f.root,'data')),before);assert.deepEqual(await readFile(f.receipt),receipt);
    const retry=await startup(t,f,'ok'),report=await retry.run();assert.equal(report.ok,true);assert.equal(report.downloaded,1);
    assert.equal(retry.events.filter(([kind])=>kind==='success').length,1);assert.equal(retry.events.filter(([kind])=>kind==='warning').length,0);
    assert.equal(JSON.parse(await readFile(f.receipt)).revision,report.revision);
});

for(const mode of ['http503','stream-error'])test('Unavailable artifact delivery stays deferred and retains old verified bytes: '+mode,async t=>{
    const f=await assetFixture(t);await f.run();const before=await snapshot(path.join(f.root,'data/runtime-artifacts/.asset-source-blobs')),receipt=await readFile(f.receipt);
    await nextTool(f);const s=await startup(t,f,mode);assert.equal((await s.run()).deferred,true);
    assert.equal(JSON.parse(s.result.stdout).error.code,'ASSET_RETRIEVAL_UNAVAILABLE');
    assert.deepEqual(await snapshot(path.join(f.root,'data/runtime-artifacts/.asset-source-blobs')),before);assert.deepEqual(await readFile(f.receipt),receipt);
    assert.equal(s.events.some(([kind])=>kind==='success'),false);
});

for(const mode of ['hash','length','redirect'])test('Untrusted delivery remains a hard startup failure instead of a deferred success: '+mode,async t=>{
    const f=await assetFixture(t),s=await startup(t,f,mode);await assert.rejects(s.run(),/Поставка проекта не подготовлена/);
    assert.equal(s.events.some(([kind])=>kind==='success'||kind==='warning'),false);
    await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
    assert.deepEqual(await readdir(path.join(f.root,'data/runtime-artifacts/.asset-source-blobs')),[]);
});

test('Only structured unsuccessful retrieval reports can defer; malformed reports and local failures stay hard',async()=>{
    const warnings=[],input={root:'/isolated',withoutModels:true,environment:{},output:{info(){},success(){assert.fail('No readiness');},warning:value=>warnings.push(value)}};
    for(const result of [{status:0,stdout:JSON.stringify({ok:false,error:{code:'UNAVAILABLE'}})},
        {status:1,stdout:'fetch failed'},{status:1,stdout:JSON.stringify({ok:false,error:{code:'INVALID_SOURCE'}})},
        {status:1,stdout:JSON.stringify({ok:false,error:{code:'ENOSPC'}})},
        {status:1,error:Object.assign(Error('spawn failed'),{code:'ENOENT'}),stdout:JSON.stringify({ok:false,error:{code:'UNAVAILABLE'}})},
        {status:1,signal:'SIGTERM',stdout:JSON.stringify({ok:false,error:{code:'UNAVAILABLE'}})}]){
        await assert.rejects(prepareStartupAssets(input,async()=>result),/Поставка проекта не подготовлена/);
    }
    assert.deepEqual(warnings,[]);
});

test('Explicit user abort identity survives transport classification while a source timeout remains retryable',async()=>{
    for(const reason of [new DOMException('User abort','AbortError'),Object.assign(Error('Cancelled'),{code:'ECANCELED'})]){
        const abort=new AbortController();abort.abort(reason);
        await assert.rejects(assetRetrievalFetch(async()=>{throw reason;})('https://example.invalid',{signal:abort.signal}),error=>error===reason);
    }
    const timeout=new DOMException('Source timeout','TimeoutError'),abort=new AbortController();abort.abort(timeout);
    await assert.rejects(assetRetrievalFetch(async()=>{throw timeout;})('https://example.invalid',{signal:abort.signal}),error=>error.code==='ASSET_RETRIEVAL_UNAVAILABLE'&&error.cause===timeout);
});
