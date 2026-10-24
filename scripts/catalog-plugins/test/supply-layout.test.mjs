import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assetDigest} from '@neurocenter/asset-contract';
import {builtAssetFixture} from './built-asset.fixture.mjs';
import {readyManifest,publicationKey} from '../manifest.mjs';
import {publishCatalog} from '../publish.mjs';
import {retainSupplyFiles} from '../retain-supply.mjs';
import {exportCatalogRelease} from '../release.mjs';
import {toolSourcePath,toolRuntimePath,TOOL_SOURCE_MAX_BYTES} from '../supply-layout.mjs';
import {exportBuiltAsset} from '../source-envelope.mjs';
import {preparedSourceFiles} from '../prepared-source-snapshot.mjs';
import {validateRecipe} from '../recipe-schema.mjs';
import {RAG_PLUGIN_SOURCE} from '../../../services/shared/opencode-rag-source.cjs';

async function sourceFixture(t){
 const f=await builtAssetFixture(t),bytes=Buffer.alloc(17*1024**2,173);bytes[0]=0;bytes[1]=255;
 f.asset.source={type:'archive',sha256:assetDigest(bytes),bytes:bytes.length};await f.save();
 const source=path.join(f.root,toolSourcePath(f.asset.source.sha256));await fs.mkdir(path.dirname(source));await fs.writeFile(source,bytes);
 return {...f,source,sourceBytes:bytes};
}
async function recipeFixture(f,relative='recipes/public.mjs'){
 const bytes=Buffer.from('export const build = "portable exact recipe";\r\n');
 f.asset.recipe={path:relative,sha256:assetDigest(bytes)};await f.save();
 const filename=path.join(f.root,relative);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes);return {bytes,filename};
}
test('Canonical supply validates 17MiB opaque source without base64 or JSON parsing and dry-run never writes or calls a network',async t=>{
 const f=await sourceFixture(t),before=(await fs.readdir(f.root,{recursive:true})).sort(),request=globalThis.fetch;
 globalThis.fetch=()=>assert.fail('Supply dry-run must be offline');
 try{const [tool]=await readyManifest(f.filename);assert.equal(tool.sourceSnapshotPath,f.source);assert.equal(Object.hasOwn(tool,'sourceSnapshot'),false);assert.deepEqual(tool.retainedFiles.map(({sha256,bytes})=>({sha256,bytes})),[{sha256:f.asset.source.sha256,bytes:17*1024**2}]);
  const report=await publishCatalog({asset:f.filename,dryRun:true});assert.equal(report.ok,true);assert.equal(report.dryRun,true);assert.deepEqual((await fs.readdir(f.root,{recursive:true})).sort(),before);
 }finally{globalThis.fetch=request;}
});
test('Operator retention passes checked source and recipe files directly to the SHA store, without transporting file content in JSON',async t=>{
 const f=await sourceFixture(t),recipe=await recipeFixture(f),retained=[];
 const pool={end:()=>assert.fail('Caller owns the pool')},blobs={ingestLocal:async(files,key)=>{assert.equal(key,publicationKey(f.asset.id,f.asset.version));for(const file of files){const bytes=await fs.readFile(file.archivePath);assert.equal(bytes.length,file.bytes);assert.equal(assetDigest(bytes),file.sha256);retained.push({sha256:file.sha256,bytes:file.bytes});}return files;}};
 const result=await retainSupplyFiles(f.filename,publicationKey(f.asset.id,f.asset.version),{pool,blobs});assert.deepEqual(result.retained,retained);assert.equal(retained.length,2);assert.equal(retained[1].sha256,assetDigest(recipe.bytes));assert.ok(!JSON.stringify(result).includes(f.root));
});
test('Public release export preserves canonical source and recipe bytes at the same paths and leaves the input descriptor untouched',async t=>{
 const f=await sourceFixture(t),recipe=await recipeFixture(f),original=await fs.readFile(f.filename),output=path.join(f.root,'public-export');
 const result=await exportCatalogRelease({asset:f.filename,release:'supply-v2',output});const [tool]=await readyManifest(result.asset);
 assert.equal(tool.asset.source.sha256,f.asset.source.sha256);assert.deepEqual(tool.asset.recipe,f.asset.recipe);assert.equal(assetDigest(await fs.readFile(path.join(output,toolSourcePath(f.asset.source.sha256)))),f.asset.source.sha256);
 assert.equal(assetDigest(await fs.readFile(path.join(output,f.asset.recipe.path))),assetDigest(recipe.bytes));assert.equal(assetDigest(await fs.readFile(f.filename)),assetDigest(original));
});
for(const mode of ['missing','corrupt','size','symlink','hardlink','directory-symlink','oversize','old-layout'])test('Source negative case fails closed before operator writes: '+mode,async t=>{
 const f=await sourceFixture(t);
 if(mode==='missing')await fs.unlink(f.source);if(mode==='corrupt')await fs.writeFile(f.source,Buffer.alloc(f.sourceBytes.length,0));if(mode==='size')await fs.truncate(f.source,f.sourceBytes.length-1);
 if(mode==='symlink'){await fs.rename(f.source,f.source+'.original');await fs.symlink(f.source+'.original',f.source);}
 if(mode==='hardlink')await fs.link(f.source,path.join(f.root,'aliased-source'));
 if(mode==='directory-symlink'){await fs.rename(path.dirname(f.source),path.join(f.root,'outside'));await fs.symlink(path.join(f.root,'outside'),path.dirname(f.source));}
 if(mode==='oversize'){await fs.truncate(f.source,TOOL_SOURCE_MAX_BYTES+1);f.asset.source.bytes=TOOL_SOURCE_MAX_BYTES+1;await f.save();}
 if(mode==='old-layout')await fs.rename(f.source,path.join(f.root,'source-snapshot.json'));
 const blobs={ingestLocal:()=>assert.fail('Invalid source must not reach mutation')};await assert.rejects(retainSupplyFiles(f.filename,publicationKey(f.asset.id,f.asset.version),{pool:{},blobs}));
});
for(const mode of ['missing','corrupt','symlink','escape','descriptor','readme','source-role','runtime-role','ancestor','case-role'])test('Recipe negative case rejects missing, unsafe or conflicting exact bytes: '+mode,async t=>{
 const f=await sourceFixture(t),recipe=await recipeFixture(f);
 if(mode==='missing')await fs.unlink(recipe.filename);if(mode==='corrupt')await fs.writeFile(recipe.filename,Buffer.alloc(recipe.bytes.length,0));
 if(mode==='symlink'){await fs.rename(recipe.filename,recipe.filename+'.original');await fs.symlink(recipe.filename+'.original',recipe.filename);}
 if(mode==='escape')f.asset.recipe.path='../outside.mjs';if(mode==='descriptor')f.asset.recipe.path='asset.json';if(mode==='readme')f.asset.recipe.path='README.md';
 if(mode==='source-role')f.asset.recipe.path=toolSourcePath(f.asset.source.sha256);if(mode==='runtime-role')f.asset.recipe.path=toolRuntimePath(f.descriptor.sha256);if(mode==='ancestor')f.asset.recipe.path='artifacts';
 if(mode==='case-role'){f.asset.recipe.path=toolSourcePath(f.asset.source.sha256).replace('source/','SOURCE/');f.asset.recipe.sha256=f.asset.source.sha256;}
 if(['escape','descriptor','readme','source-role','runtime-role','ancestor','case-role'].includes(mode))await fs.writeFile(f.filename,JSON.stringify(f.asset));
 await assert.rejects(readyManifest(f.filename));
});
test('Runtime layout cannot escape through a symlink directory or silently use an old root archive',async t=>{
 const f=await builtAssetFixture(t);await fs.rename(path.join(f.root,'artifacts'),path.join(f.root,'outside'));await fs.symlink(path.join(f.root,'outside'),path.join(f.root,'artifacts'));await assert.rejects(readyManifest(f.filename));
 await fs.unlink(path.join(f.root,'artifacts'));await fs.rename(path.join(f.root,'outside',path.basename(f.archive)),path.join(f.root,path.basename(f.archive)));await assert.rejects(readyManifest(f.filename));
});
test('Recipe reuse of the same exact runtime path and SHA is verified without conflicting roles',async t=>{
 const f=await builtAssetFixture(t);f.asset.recipe={path:toolRuntimePath(f.descriptor.sha256),sha256:f.descriptor.sha256};await f.save();const [tool]=await readyManifest(f.filename);assert.equal(tool.retainedFiles[0].archivePath,f.archive);assert.equal(tool.retainedFiles[0].sha256,f.descriptor.sha256);
});
test('Adapted producer source supply retains its versioned recipe and exact bytes through export and rejects tampering before retention',async t=>{
 const f=await builtAssetFixture(t),recipe=validateRecipe({schemaVersion:1,key:'portable-adapted-rag',name:'Portable RAG',kind:'plugin',description:'Source transfer fixture',revision:'git-'+RAG_PLUGIN_SOURCE.commit,
  source:{type:'repository',url:RAG_PLUGIN_SOURCE.url,commit:RAG_PLUGIN_SOURCE.commit,entrypoint:RAG_PLUGIN_SOURCE.entrypoint},targets:['darwin-arm64']});
 const destination=path.join(f.root,'adapted');await fs.mkdir(path.join(destination,'artifacts'),{recursive:true});await fs.copyFile(f.archive,path.join(destination,toolRuntimePath(f.descriptor.sha256)));
 const asset=await exportBuiltAsset({recipe,recipeDirectory:f.root,destination,publication:{...f.publication,origin:recipe.source.url},descriptors:[f.descriptor],sources:[],locks:[],preparedInputs:await preparedSourceFiles()});
 const [built]=await readyManifest(asset),sourceBytes=await fs.readFile(built.sourceSnapshotPath),original=await fs.readFile(asset),retained=[];
 const blobs={ingestLocal:async files=>{for(const file of files)retained.push(await fs.readFile(file.archivePath));return files;}};
 await retainSupplyFiles(asset,publicationKey(built.asset.id,built.asset.version),{pool:{},blobs});assert.deepEqual(retained,[sourceBytes]);
 const output=path.join(f.root,'exported'),result=await exportCatalogRelease({asset,release:'portable-rag-source-v2',output}),[exported]=await readyManifest(result.asset);
 assert.deepEqual(await fs.readFile(exported.sourceSnapshotPath),sourceBytes);assert.deepEqual(await fs.readFile(asset),original);
 assert.deepEqual(JSON.parse(sourceBytes).recipe,recipe);assert.equal(exported.asset.source.sha256,built.asset.source.sha256);
 await fs.appendFile(exported.sourceSnapshotPath,'tampered');let writes=0;
 await assert.rejects(retainSupplyFiles(result.asset,publicationKey(exported.asset.id,exported.asset.version),{pool:{},blobs:{ingestLocal:async()=>{writes++;}}}));assert.equal(writes,0);
});
