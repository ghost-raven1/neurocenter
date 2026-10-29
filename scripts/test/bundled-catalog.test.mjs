import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import * as contract from '@neurocenter/asset-contract';
import bundleReader from '../../services/shared/bundled-catalog.cjs';
import sourceReader from '../../services/shared/asset-source-client.cjs';
import {syncAssets} from '../assets/sync.mjs';
import {parseAssetsArguments} from '../assets/cli.mjs';
import {pinCatalogSource} from '../assets/catalog-source-pin.mjs';
import {PREPARED_SOURCE_INPUTS,capturePreparedSource} from '../catalog-plugins/prepared-source-snapshot.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const forbidden=async()=>{throw Error('Unexpected network');};
async function fixture(t){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc bundled catalog ')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    await fs.cp(path.join(root,'catalog-source'),path.join(directory,'catalog-source'),{recursive:true});
    await fs.mkdir(path.join(directory,'services/shared'),{recursive:true});
    await fs.copyFile(path.join(root,'services/shared/bundled-catalog.lock.json'),path.join(directory,'services/shared/bundled-catalog.lock.json'));
    const producer=JSON.parse(await fs.readFile(path.join(root,'catalog-source/producer.json'),'utf8'));
    for(const file of producer.files){const target=path.join(directory,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(root,file.path),target);}
    return directory;
}
test('Git bundle separates 21 ready inline assets from 13 current source plans and carries no runtime binaries or model weights',async()=>{
    const bundle=await bundleReader.readBundledCatalog(),source=new sourceReader.AssetSourceClient(bundle.pin,{contract,fetch:forbidden,offline:true});
    const index=await source.index(),selected=await source.select(index.assets.filter(entry=>entry.current).map(entry=>entry.id));
    assert.equal(selected.assets.length,21);assert.ok(selected.assets.every(record=>['agent','skill'].includes(record.asset.kind)));
    assert.equal(bundle.plans.length,13);assert.equal(bundle.plans.filter(plan=>plan.kind==='model').length,2);
    assert.equal(bundle.pin.commit,'sha256:'+bundle.pin.index.sha256);assert.equal(bundle.pin.repository,'app-bundled');
    assert.ok(!bundle.manifest.files.some(file=>/\.(?:tgz|tar|gz|zip|gguf|blob|exe|node|dylib|bin)$/i.test(file.path)));
    for(const file of bundle.manifest.files)assert.equal(contract.assetDigest(await bundle.read(file.path)),file.sha256);
});
test('Every historical index and exact descriptor remains readable after retiring the repository, with zero HTTP calls',async()=>{
    const bundle=await bundleReader.readBundledCatalog();assert.equal(bundle.historicalPins.length,22);
    for(const pin of bundle.historicalPins){
        const source=new sourceReader.AssetSourceClient(pin,{contract,fetch:forbidden});const index=await source.index();
        for(const entry of index.assets)assert.equal((await source.descriptor(entry)).sha256,entry.sha256);
    }
});
test('Unknown retired metadata fails closed without a network fallback; malformed content pins never become Git commits',async()=>{
    const bundle=await bundleReader.readBundledCatalog(),old=bundle.historicalPins[0];
    await assert.rejects(new sourceReader.AssetSourceClient({...old,index:{...old.index,sha256:'0'.repeat(64)}},{contract,fetch:forbidden}).index(),{code:'ASSET_METADATA_MISSING'});
    assert.throws(()=>sourceReader.validateSourcePin({...bundle.pin,commit:'a'.repeat(40)}),{code:'INVALID_PIN'});
    assert.throws(()=>sourceReader.validateSourcePin({...old,schemaVersion:2}),{code:'INVALID_PIN'});
});
test('Preparation pins exact RAG 2.12.2 and source identity; stale revision, path injection and manual archive cannot enqueue a substitute',async()=>{
    const bundle=await bundleReader.readBundledCatalog(),source={type:'bundled',id:'plugin-opencode-rag-plugin',revision:bundle.revision};
    const result=await bundleReader.bundledBuildRecipe(source);assert.equal(result.recipe.revision,'2.12.2-plugin.pack.1');
    assert.equal(result.recipe.key,source.id);assert.equal(result.recipe.source.adapter,'opencode-rag-plugin');
    await assert.rejects(bundleReader.bundledBuildRecipe({...source,revision:'0'.repeat(64)}),{code:'BUNDLED_SOURCE_CHANGED'});
    await assert.rejects(bundleReader.bundledBuildRecipe({...source,id:'plugin-opencode-snip'}),{code:'BUNDLED_ARCHIVE_REQUIRED'});
    assert.throws(()=>bundleReader.validateBundledBuildSource({...source,path:'../../secret'}),{code:'BUNDLED_CATALOG_INVALID'});
});
test('Corrupted or symlinked bundled metadata fails before any fallback or rewrite',async t=>{
    const directory=await fixture(t),bundle=await bundleReader.readBundledCatalog(directory),file=bundle.manifest.files.find(row=>row.path.startsWith('metadata/'));
    const filename=path.join(directory,'catalog-source',file.path),original=await fs.readFile(filename);await fs.writeFile(filename,'corrupt');
    await assert.rejects(bundle.read(file.path),{code:'BUNDLED_CATALOG_INVALID'});assert.equal(await fs.readFile(filename,'utf8'),'corrupt');
    await fs.unlink(filename);const sibling=path.join(directory,'original.json');await fs.writeFile(sibling,original);await fs.symlink(sibling,filename);
    await assert.rejects(bundle.read(file.path));assert.deepEqual(await fs.readFile(sibling),original);
});
test('Default offline sync from a fresh Git source publishes only metadata/inline receipts and never requests binary or model URLs',async t=>{
    const directory=await fixture(t),report=await syncAssets({root:directory,environment:{ASSET_SOURCE_MODE:'offline'},fetch:forbidden});
    assert.equal(report.downloaded,0);assert.equal(report.files,0);assert.equal(report.assets.length,21);assert.equal(report.sourcePlans.length,13);
    assert.ok(report.sourcePlans.every(plan=>plan.state!=='ready'));assert.ok(report.sourceCommit.startsWith('sha256:'));
    assert.equal((await syncAssets({root:directory,environment:{ASSET_SOURCE_MODE:'offline'},fetch:forbidden,verifyOnly:true})).ok,true);
});
test('A file growing after fstat cannot force the reader beyond its admitted byte budget',async t=>{
    const directory=await fixture(t),filename=path.join(directory,'growing.json'),original=Buffer.from('{"ok":true}');await fs.writeFile(filename,original);
    const open=fs.open;let readBytes=0,largestBuffer=0,grown=false;
    fs.open=async(...args)=>{
        const handle=await open(...args);if(args[0]!==filename)return handle;
        return {close:()=>handle.close(),stat:async()=>{const stat=await handle.stat();if(!grown){grown=true;await fs.appendFile(filename,Buffer.alloc(1024*1024));}return stat;},
            read:async(buffer,offset,length,position)=>{largestBuffer=Math.max(largestBuffer,buffer.length);const result=await handle.read(buffer,offset,length,position);readBytes+=result.bytesRead;return result;},
            readFile:async()=>{throw Error('Unbounded readFile must never be used');}};
    };
    try{await assert.rejects(bundleReader.checkedFile(directory,'growing.json',contract.assetDigest(original),original.length),{code:'BUNDLED_CATALOG_INVALID'});
        assert.equal(readBytes,original.length);assert.equal(largestBuffer,original.length);assert.equal((await fs.stat(filename)).size,original.length+1024*1024);
    }finally{fs.open=open;}
});
test('A producer adapter changed without a new approved source pin cannot reuse catalog readiness',async t=>{
    const directory=await fixture(t),file=path.join(directory,'scripts/catalog-plugins/recipes/adapters/rag-plugin.mjs');
    await fs.appendFile(file,'\n// unapproved changed adapter\n');
    await assert.rejects(bundleReader.readBundledCatalog(directory),{code:'BUNDLED_CATALOG_INVALID'});
});
test('The checked-in producer approval covers every retained input except its own descriptor and manifest lock',async()=>{
    const pinned=await pinCatalogSource(),producer=JSON.parse(await fs.readFile(path.join(root,'catalog-source/producer.json')));
    assert.equal(pinned.files,158);assert.deepEqual(producer.files.map(file=>file.path),PREPARED_SOURCE_INPUTS.filter(name=>!['catalog-source/producer.json','services/shared/bundled-catalog.lock.json'].includes(name)));
});
test('The Docker public-source layout can verify the server bundle and retain its producer without following service directory links',async t=>{
    const directory=await fixture(t),tools=path.join(directory,'tools');await fs.mkdir(tools);
    for(const relative of PREPARED_SOURCE_INPUTS){const target=path.join(tools,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(root,relative),target);}
    await fs.rm(path.join(directory,'scripts'),{recursive:true});
    const bundle=await bundleReader.readBundledCatalog(directory);assert.equal(bundle.plans.length,13);
    assert.equal((await capturePreparedSource(tools)).files.length,160);
});
test('Every retained producer input is covered by an actual Docker COPY into its public /tools path',async()=>{
    const dockerfile=await fs.readFile(path.join(root,'services/catalog-service/Dockerfile'),'utf8');
    const copies=[...dockerfile.matchAll(/^COPY (\S+) (\/tools\/\S*|\/tools\/)$/gm)].map(([,from,to])=>({from,to}));
    for(const input of PREPARED_SOURCE_INPUTS){
        const delivered=copies.some(({from,to})=>{
            let tail;
            if(from.endsWith('/')&&input.startsWith(from))tail=input.slice(from.length);
            else if(from.includes('*')){const pattern=new RegExp('^'+from.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')+'$');if(pattern.test(input))tail=path.posix.basename(input);}
            else if(from===input)tail=path.posix.basename(input);
            if(tail===undefined)return false;return (to.endsWith('/')?to+tail:to)==='/tools/'+input;
        });
        assert.ok(delivered,'Missing real Docker COPY for '+input);
    }
});
test('Vendored runtime closures match their pins and ordinary registry dependency locks; Codex source matches the existing source pin',async()=>{
    const fetch=await bundleReader.readBundledComponent('fetch-mcp'),codex=await bundleReader.readBundledComponent('codex-connector');
    assert.equal(fetch.provenance.commit,'1ddb1a59cb09a2d38e759f2d7a97829680cbe514');
    const npmLock=JSON.parse(fetch.files.get('source/package-lock.json'));assert.equal(npmLock.lockfileVersion,3);
    for(const item of Object.values(npmLock.packages))if(item.resolved)assert.ok(item.resolved.startsWith('https://registry.npmjs.org/'));
    const pin=JSON.parse(await fs.readFile(path.join(root,'services/shared/codex-connector-pin.json')));
    for(const [name,sha]of Object.entries(pin.files))assert.equal(contract.assetDigest(codex.files.get('source/'+name)),sha);
});
test('Expected source CLI accepts explicit SHA content identities while legacy Git input remains exact',()=>{
    const bundle={repository:'app-bundled',commit:'sha256:'+'a'.repeat(64),revision:'b'.repeat(64)};
    assert.equal(parseAssetsArguments(['--expected-repository',bundle.repository,'--expected-commit',bundle.commit,'--expected-revision',bundle.revision]).expectedCommit,bundle.commit);
    assert.throws(()=>parseAssetsArguments(['--expected-repository',bundle.repository,'--expected-commit','fake','--expected-revision',bundle.revision]));
});
