import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'node:test';
import {publicationKey,readyManifest} from '../catalog-plugins/manifest.mjs';
import {parseArguments,publishCatalog} from '../catalog-plugins/publish.mjs';
import {builtAssetFixture} from '../catalog-plugins/test/built-asset.fixture.mjs';

test('Source ID/version deterministically identifies native publication intent',()=>{
    const key=publicationKey('tool','1.0.0');assert.match(key,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(publicationKey('tool','1.0.0'),key);assert.notEqual(publicationKey('tool','2.0.0'),key);assert.notEqual(publicationKey('other','1.0.0'),key);
});
test('New envelope resolves SHA archives relative to itself; dry-run is read-only and offline',async t=>{
    const f=await builtAssetFixture(t),before=await fs.readdir(f.root),fetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('No network in validation');
    try{const [tool]=await readyManifest(f.filename);assert.equal(tool.artifacts[0].archivePath,f.archive);assert.equal(tool.asset.id,f.asset.id);
        const result=await publishCatalog({asset:f.filename,dryRun:true});assert.equal(result.dryRun,true);assert.deepEqual(result.tools[0].targets,['darwin-arm64']);assert.deepEqual(await fs.readdir(f.root),before);
    }finally{globalThis.fetch=fetch;}
});
test('Old ready/tools manifests and native IDs cannot masquerade as source envelopes',async t=>{
    const f=await builtAssetFixture(t);for(const value of [{schemaVersion:1,tools:[{publication:f.publication}]},{...f.asset,catalogId:'ai-plug-private'}]){await fs.writeFile(f.filename,JSON.stringify(value));await assert.rejects(readyManifest(f.filename));}
});
test('A missing or corrupt SHA archive fails structural and native checks before import',async t=>{
    const f=await builtAssetFixture(t);await fs.rename(f.archive,f.archive+'.original');await assert.rejects(readyManifest(f.filename),{code:'ENOENT'});
    await fs.writeFile(f.archive,Buffer.alloc(f.descriptor.compressedBytes,0));await assert.rejects(readyManifest(f.filename),/SHA|архив|gzip|tar/i);
});
test('Descriptor symlink and duplicate native targets are rejected',async t=>{
    const f=await builtAssetFixture(t),original=f.filename+'.original';await fs.rename(f.filename,original);await fs.symlink(original,f.filename);await assert.rejects(readyManifest(f.filename));
    await fs.unlink(f.filename);await fs.writeFile(f.filename,JSON.stringify({...f.asset,delivery:{...f.asset.delivery,artifacts:[...f.asset.delivery.artifacts,...f.asset.delivery.artifacts]}}));await assert.rejects(readyManifest(f.filename),/duplicate/i);
});
test('Operator import CLI accepts only source asset and local Gateway origin without credentials',()=>{
    assert.deepEqual(parseArguments(['--asset','asset.json','--dry-run']),{asset:'asset.json',baseUrl:'http://localhost:5173',dryRun:true});
    for(const args of [['--manifest','ready.json'],['--asset','x','--base-url','https://example.com'],['--asset','x','--base-url','http://token@localhost:5173'],['--asset','x','--asset','y'],['constructor','x']])assert.throws(()=>parseArguments(args));
});
