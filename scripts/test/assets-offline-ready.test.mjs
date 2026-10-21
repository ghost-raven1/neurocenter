import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,lstat,rm,chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {downloadArtifacts,serializeAsset} from '@neurocenter/asset-contract';
import {parseAssetsArguments} from '../assets/cli.mjs';
import {assetFixture,sha,clone} from './assets-sync.fixture.mjs';

const metadata=f=>path.join(f.root,'data/runtime-artifacts/.asset-source-metadata');
const binaryCalls=f=>f.calls.filter(url=>url.includes('/releases/download/'));
const execute=promisify(execFile),cli=fileURLToPath(new URL('../assets/cli.mjs',import.meta.url));
const entryFile=(f,entry)=>path.join(metadata(f),entry.sha256+'.json');
async function repin(f){
    const bytes=Buffer.from(JSON.stringify(f.index)+'\n');f.payloads.set(f.raw+'index.json',bytes);
    const pin={...f.pin,index:{...f.pin.index,sha256:sha(bytes)}};await f.json('services/shared/asset-source.lock.json',pin);return pin;
}
function descriptor(f,entry,bytes){f.payloads.set(f.raw+entry.path,bytes);entry.sha256=sha(bytes);}
function skills(f,count){return Array.from({length:count},(_,index)=>({...clone(f.skill),id:'fixture-skill-'+index,card:{...clone(f.skill.card),slug:'fixture-skill-'+index}}));}
async function snapshot(directory){
    const result=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const filename=path.join(directory,entry.name),info=await lstat(filename);
        result.push([entry.name,info.mode,info.mtimeMs,entry.isDirectory()?await snapshot(filename):sha(await readFile(filename))]);
    }
    return result.sort(([left],[right])=>left.localeCompare(right));
}

test('--offline-ready parses explicitly, composes with verify-only, and rejects duplicates',()=>{
    assert.deepEqual(parseAssetsArguments([]),{});
    assert.deepEqual(parseAssetsArguments(['--offline-ready','--verify-only','--asset','fixture-skill']),{offlineReady:true,verifyOnly:true,ids:['fixture-skill']});
    assert.throws(()=>parseAssetsArguments(['--offline-ready','--offline-ready']),/повторён/);
});
test('Offline preparation caches every current and historical descriptor and recipe, but only selected exact binary dependencies',async t=>{
    const f=await assetFixture(t),old=clone(f.tool),next=clone(old);next.version='2.0.0';next.card.revision='2.0.0';
    next.delivery.artifacts[0].url='https://github.com/example/assets/releases/download/v2.0.0/unselected.tar.gz';
    const recipe=Buffer.from('{"schemaVersion":1,"build":"fixture"}\n');next.recipe={path:'recipes/fixture-tool/2.0.0/build.json',sha256:sha(recipe)};
    f.payloads.set(f.raw+next.recipe.path,recipe);
    f.skill.dependencies=[{id:old.id,version:old.version,sha256:sha(serializeAsset(old))}];
    await f.publish([{asset:old,current:false},next,f.skill,f.bridge,f.model]);
    const report=await f.run({offlineReady:true,ids:[f.skill.id]});assert.equal(report.offlineReady,true);assert.equal(report.downloaded,1);
    assert.deepEqual(report.assets.map(item=>item.id+'@'+item.version),[old.id+'@1.0.0',f.skill.id+'@1.0.0']);
    assert.deepEqual(binaryCalls(f),[old.delivery.artifacts[0].url]);
    for(const entry of f.index.assets)assert.deepEqual(await readFile(entryFile(f,entry)),f.payloads.get(f.raw+entry.path));
    assert.deepEqual(await readFile(path.join(metadata(f),next.recipe.sha256+'.json')),recipe);
    assert.equal((await readdir(metadata(f))).length,f.index.assets.length+2);
    assert.deepEqual(await readdir(path.dirname(f.blob(downloadArtifacts(old)[0].sha256))),[downloadArtifacts(old)[0].sha256+'.blob']);
});
test('Default preparation keeps unselected metadata lazy; offline-ready metadata-only fetches no binary payloads',async t=>{
    const f=await assetFixture(t),initial=await f.run({ids:[f.skill.id]});assert.equal(initial.offlineReady,undefined);
    assert.equal((await readdir(metadata(f))).length,2);
    const report=await f.run({offlineReady:true,metadataOnly:true,ids:[f.skill.id]});assert.equal(report.offlineReady,true);assert.equal(report.mode,'metadata');
    assert.equal((await readdir(metadata(f))).length,f.index.assets.length+1);assert.deepEqual(binaryCalls(f),[]);
    assert.deepEqual(await readdir(path.join(f.root,'data/runtime-artifacts/.asset-source-blobs')),[]);
});
test('without-models keeps complete model metadata while omitting unselected model binaries',async t=>{
    const f=await assetFixture(t),report=await f.run({offlineReady:true,withoutModels:true});
    assert.equal(report.withoutModels,true);assert.equal(report.assets.some(item=>item.kind==='model'),false);
    assert.equal(report.downloaded,2);assert.equal((await readdir(metadata(f))).length,f.index.assets.length+1);
    assert.equal(binaryCalls(f).some(url=>url.includes('/models-v1.0.0/')),false);
});
test('Offline-ready verification is cache-only and leaves every file unchanged; it requires unselected metadata too',async t=>{
    const f=await assetFixture(t);await f.run({offlineReady:true,ids:[f.skill.id]});
    const before=await snapshot(f.root);f.calls.length=0;
    assert.equal((await f.run({offlineReady:true,verifyOnly:true,ids:[f.skill.id]})).offlineReady,true);
    assert.deepEqual(f.calls,[]);assert.deepEqual(await snapshot(f.root),before);
    const unselected=f.index.assets.find(entry=>entry.id===f.bridge.id);await rm(entryFile(f,unselected));
    const missing=await snapshot(f.root);await assert.rejects(f.run({offlineReady:true,verifyOnly:true,ids:[f.skill.id]}),/опись.*кэше/);
    assert.deepEqual(f.calls,[]);assert.deepEqual(await snapshot(f.root),missing);
});
test('Offline-ready verification on a clean checkout performs no network or writes',async t=>{
    const f=await assetFixture(t),before=await snapshot(f.root);
    await assert.rejects(f.run({offlineReady:true,verifyOnly:true,ids:[f.skill.id]}),/опись.*кэше/);
    assert.deepEqual(f.calls,[]);assert.deepEqual(await snapshot(f.root),before);
});
test('ASSET_SOURCE_MODE=offline cannot fall back to metadata or binary network, and complete cached selections work',async t=>{
    const environment={ASSET_SOURCE_MODE:'offline'},f=await assetFixture(t);
    await assert.rejects(f.run({offlineReady:true,environment,ids:[f.tool.id]}),/опись.*кэше/);assert.deepEqual(f.calls,[]);
    await f.run({offlineReady:true,metadataOnly:true,ids:[f.tool.id]});f.calls.length=0;
    await assert.rejects(f.run({offlineReady:true,environment,ids:[f.tool.id]}),/offline.*SHA-кэше/);assert.deepEqual(f.calls,[]);
    await f.run({offlineReady:true,ids:[f.tool.id]});f.calls.length=0;
    assert.equal((await f.run({offlineReady:true,environment,ids:[f.tool.id]})).downloaded,0);assert.deepEqual(f.calls,[]);
    const artifact=downloadArtifacts(f.bridge)[0];await assert.rejects(lstat(f.blob(artifact.sha256)),{code:'ENOENT'});
    await assert.rejects(f.run({environment,ids:[f.bridge.id]}),/offline.*SHA-кэше/);assert.deepEqual(f.calls,[]);
    const complete=await assetFixture(t);await complete.run({offlineReady:true});complete.calls.length=0;
    assert.equal((await complete.run({environment})).downloaded,0);
    assert.equal((await complete.run({environment,withoutModels:true})).assets.some(asset=>asset.kind==='model'),false);
    assert.deepEqual(complete.calls,[]);
});
test('Invalid ASSET_SOURCE_MODE never silently enables online downloads',async t=>{
    const f=await assetFixture(t);await assert.rejects(f.run({environment:{ASSET_SOURCE_MODE:'offine'},ids:[f.tool.id]}),/ASSET_SOURCE_MODE/);
    assert.deepEqual(f.calls,[]);await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});
test('Actual CLI forwards --offline-ready into cache-only verification',async t=>{
    const f=await assetFixture(t);await f.run({offlineReady:true,ids:[f.skill.id]});
    const hook=path.join(f.root,'deny-network.mjs');await writeFile(hook,"globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN')};\n");
    const before=await snapshot(f.root),result=await execute(process.execPath,[cli,'--root',f.root,'--offline-ready','--verify-only','--asset',f.skill.id],
        {timeout:20000,env:{...process.env,NODE_BIN:process.execPath,RUNTIME_ARTIFACT_DIR:'data/runtime-artifacts',NODE_OPTIONS:'--import='+pathToFileURL(hook).href}});
    const report=JSON.parse(result.stdout);assert.equal(report.offlineReady,true);assert.equal(report.verifyOnly,true);
    assert.deepEqual(await snapshot(f.root),before);
});
test('Offline-ready allows 300 descriptors and rejects 301 before descriptor or binary requests',async t=>{
    const f=await assetFixture(t),allowed=skills(f,300);await f.publish(allowed);
    await f.run({offlineReady:true,ids:[allowed[0].id]});assert.equal((await readdir(metadata(f))).length,301);
    const g=await assetFixture(t),excessive=skills(g,301);await g.publish(excessive);
    await assert.rejects(g.run({offlineReady:true,ids:[excessive[0].id]}),/300/);
    assert.deepEqual(g.calls,[g.raw+'index.json']);await assert.rejects(lstat(g.receipt),{code:'ENOENT'});
});
test('Unknown explicit asset IDs fail before prefetching unselected metadata',async t=>{
    const f=await assetFixture(t);await assert.rejects(f.run({offlineReady:true,ids:['missing-asset']}),/отсутствует.*описи/);
    assert.deepEqual(f.calls,[f.raw+'index.json']);await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});
test('The 32 MiB metadata boundary includes the index and remains valid from cache',async t=>{
    const f=await assetFixture(t),records=skills(f,2);await f.publish(records);
    const indexBytes=f.payloads.get(f.raw+'index.json').length;
    for(const [index,entry] of f.index.assets.entries()){
        const bytes=f.payloads.get(f.raw+entry.path),size=16*1024**2-(index?indexBytes:0);
        descriptor(f,entry,Buffer.concat([bytes,Buffer.alloc(size-bytes.length,32)]));
    }
    await repin(f);assert.equal(f.payloads.get(f.raw+'index.json').length,indexBytes);
    await f.run({offlineReady:true,metadataOnly:true,ids:[records[0].id]});f.calls.length=0;
    await f.run({offlineReady:true,verifyOnly:true,ids:[records[0].id]});assert.deepEqual(f.calls,[]);
    const sizes=await Promise.all((await readdir(metadata(f))).map(async name=>(await lstat(path.join(metadata(f),name))).size));
    assert.equal(sizes.reduce((sum,size)=>sum+size,0),32*1024**2);
});
test('The complete metadata bound counts raw whitespace and refuses to cache more than 32 MiB',async t=>{
    const f=await assetFixture(t),records=skills(f,3);await f.publish(records);
    for(const entry of f.index.assets){const bytes=f.payloads.get(f.raw+entry.path);descriptor(f,entry,Buffer.concat([bytes,Buffer.alloc(11*1024**2-bytes.length,32)]));}
    await repin(f);await assert.rejects(f.run({offlineReady:true,ids:[records[0].id]}),/32 МиБ/);
    assert.equal((await readdir(metadata(f))).length,3);assert.deepEqual(binaryCalls(f),[]);
    await assert.rejects(lstat(entryFile(f,f.index.assets[2])),{code:'ENOENT'});await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});
for(const failure of ['sha','schema','header','missing-dependency','dependency-pin'])test('Unselected metadata invalidity blocks readiness and all binary fetches: '+failure,async t=>{
    const f=await assetFixture(t);
    if(failure==='missing-dependency')f.bridge.dependencies=[{id:'missing-asset',version:'1.0.0',sha256:'f'.repeat(64)}];
    if(failure==='dependency-pin')f.bridge.dependencies=[{id:f.tool.id,version:f.tool.version,sha256:'f'.repeat(64)}];
    await f.publish();const unselected=f.index.assets.find(entry=>entry.id===f.bridge.id);
    if(['sha','schema','header'].includes(failure)){
        const bytes=Buffer.from(failure==='schema'?'{"unexpected":true}':failure==='header'?JSON.stringify({...f.bridge,version:'2.0.0'}):'wrong SHA');
        if(failure==='sha')f.payloads.set(f.raw+unselected.path,bytes);else{descriptor(f,unselected,bytes);await repin(f);}
    }
    await assert.rejects(f.run({offlineReady:true,ids:[f.tool.id]}));assert.deepEqual(binaryCalls(f),[]);await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});
test('Corrupt unselected cached metadata is preserved and fails verification without network or writes',async t=>{
    const f=await assetFixture(t);await f.run({offlineReady:true,ids:[f.skill.id]});
    const entry=f.index.assets.find(entry=>entry.id===f.bridge.id),filename=entryFile(f,entry);await chmod(filename,0o600);await writeFile(filename,Buffer.from('corrupt'));
    f.calls.length=0;const before=await snapshot(f.root);await assert.rejects(f.run({offlineReady:true,verifyOnly:true,ids:[f.skill.id]}));
    assert.deepEqual(f.calls,[]);assert.deepEqual(await snapshot(f.root),before);
});
