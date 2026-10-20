import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assetDigest,serializeAsset,toToolPublication} from '@neurocenter/asset-contract';
import {exportCatalogRelease,parseReleaseArguments} from '../release.mjs';
import {builtAssetFixture} from './built-asset.fixture.mjs';
import {toolRuntimePath,toolSourcePath} from '../supply-layout.mjs';

const options=f=>({asset:f.filename,output:path.join(f.root,'export'),release:'catalog-fixture-v2'});
test('Public export uses the same source envelope, a new immutable version and exact native bytes',async t=>{
    const f=await builtAssetFixture(t),result=await exportCatalogRelease(options(f)),asset=JSON.parse(await fs.readFile(result.asset,'utf8'));
    assert.equal(result.published,false);assert.equal(asset.version,'release-catalog-fixture-v2');assert.notEqual(asset.version,f.asset.version);
    assert.deepEqual(toToolPublication(asset),toToolPublication(f.asset));
    assert.match(asset.delivery.artifacts[0].url,/github.com\/ghost-raven1\/neurocenter-assets\/releases\/download\/catalog-fixture-v2\//);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(result.asset),toolRuntimePath(f.descriptor.sha256))),await fs.readFile(f.archive));
    assert.doesNotMatch(await fs.readFile(result.asset,'utf8'),/publicationKey|legacyOrigins|legacyPackages|archivePath/);
    assert.deepEqual((await fs.readdir(path.dirname(result.asset))).sort(),['artifacts','asset.json'].sort());
});
test('Dry-run validates every native archive without output or network',async t=>{
    const f=await builtAssetFixture(t),fetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('No network during export');
    try{assert.equal((await exportCatalogRelease({...options(f),dryRun:true})).dryRun,true);await assert.rejects(fs.access(options(f).output),{code:'ENOENT'});}finally{globalThis.fetch=fetch;}
});
test('Missing bytes, changed SHA and old source envelope fail before export',async t=>{
    const f=await builtAssetFixture(t);await fs.writeFile(f.archive,'corrupt');await assert.rejects(exportCatalogRelease(options(f)));await assert.rejects(fs.access(options(f).output),{code:'ENOENT'});
    await fs.writeFile(f.filename,JSON.stringify({schemaVersion:1,tools:[]}));await assert.rejects(exportCatalogRelease(options(f)));
});
test('Existing output and invalid versions preserve unrelated files',async t=>{
    const f=await builtAssetFixture(t);await fs.mkdir(options(f).output);await fs.writeFile(path.join(options(f).output,'private'),'preserve');
    await assert.rejects(exportCatalogRelease(options(f)),/новой или пустой/);assert.equal(await fs.readFile(path.join(options(f).output,'private'),'utf8'),'preserve');
    for(const release of ['latest','main','../v1','v1?token=secret'])await assert.rejects(exportCatalogRelease({...options(f),release}));
});
test('CLI rejects the old manifest interface, repeated flags and inherited property names',()=>{
    assert.deepEqual(parseReleaseArguments(['--asset','asset.json','--release','v2','--output','out','--dry-run']),{asset:'asset.json',release:'v2',output:'out',dryRun:true});
    for(const args of [['--manifest','ready.json'],['--asset','x'],['--asset','x','--release','v1','--output','out','--release','v2'],['constructor','x']])assert.throws(()=>parseReleaseArguments(args));
});

test('Archive source export retains checked source bytes and refuses changed, linked or oversized snapshots before output',async t=>{
    const f=await builtAssetFixture(t),source=Buffer.from('exact checked source snapshot'),snapshot=path.join(path.dirname(f.filename),toolSourcePath(assetDigest(source)));
    f.asset.source={type:'archive',sha256:assetDigest(source),bytes:source.length};await fs.writeFile(f.filename,serializeAsset(f.asset));await fs.mkdir(path.dirname(snapshot));await fs.writeFile(snapshot,source);
    const result=await exportCatalogRelease(options(f));assert.deepEqual(await fs.readFile(path.join(path.dirname(result.asset),toolSourcePath(assetDigest(source)))),source);
    await fs.rm(options(f).output,{recursive:true});await fs.writeFile(snapshot,Buffer.alloc(source.length,0));await assert.rejects(exportCatalogRelease(options(f)),/snapshot SHA/);await assert.rejects(fs.access(options(f).output),{code:'ENOENT'});
    await fs.unlink(snapshot);await fs.writeFile(snapshot+'.original',source);await fs.symlink(snapshot+'.original',snapshot);await assert.rejects(exportCatalogRelease(options(f)));assert.deepEqual(await fs.readFile(snapshot+'.original'),source);
    await fs.unlink(snapshot);await fs.writeFile(snapshot,source);await fs.truncate(snapshot,256*1024*1024+1);f.asset.source.bytes=256*1024*1024+1;await fs.writeFile(f.filename,serializeAsset(f.asset));await assert.rejects(exportCatalogRelease(options(f)),/предел/);await assert.rejects(fs.access(options(f).output),{code:'ENOENT'});
});
