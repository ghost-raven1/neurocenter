import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assetDigest,serializeAsset,validateAsset} from '@neurocenter/asset-contract';
import {readyManifest,publicationKey} from '../manifest.mjs';
import {publishCatalog} from '../publish.mjs';
import {retainSupplyFiles} from '../retain-supply.mjs';
import {exportCatalogRelease} from '../release.mjs';
import {toolSourcePath} from '../supply-layout.mjs';

async function fixture(t,{archive=false}={}){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-skill-supply-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const sourceBytes=Buffer.from(JSON.stringify({schemaVersion:1,files:[{path:'SKILL.md',content:'---\nname: fixture\ndescription: Полезная инструкция\n---\n# Инструкция\n'},{path:'references/deep/guide.md',content:'日本語 ресурс'}]})+'\n');
    const source=archive?{type:'archive',sha256:assetDigest(sourceBytes),bytes:sourceBytes.length}:{type:'git',repository:'https://github.com/example/skills',commit:'a'.repeat(40),path:'skills/fixture'};
    const asset=validateAsset({schemaVersion:1,id:'skill-fixture',version:'source-fixture',kind:'skill',source,license:{spdx:'MIT'},compatibility:{packageFormat:5},card:{path:'common',slug:'fixture',name:'Полезный скилл 日本語',body:'# Инструкция\n',meta:{description:'Полезная инструкция',tags:['fixture'],mcp:[],plugins:[]},resources:[{path:'references/deep/guide.md',content:'日本語 ресурс'}]},delivery:{type:'inline'}});
    const filename=path.join(root,'asset.json'),save=()=>fs.writeFile(filename,serializeAsset(asset));await save();
    let sourceFile;if(archive){sourceFile=path.join(root,toolSourcePath(source.sha256));await fs.mkdir(path.dirname(sourceFile));await fs.writeFile(sourceFile,sourceBytes);}
    return {root,filename,asset,sourceFile,sourceBytes,save};
}

for(const archive of [false,true])test('Skill canonical supply validates native payload and offline dry-run without a runtime: '+(archive?'archive':'git'),async t=>{
    const f=await fixture(t,{archive}),before=await fs.readdir(f.root,{recursive:true}),request=globalThis.fetch;globalThis.fetch=()=>assert.fail('Skill dry-run must stay offline');
    try{
        const [skill]=await readyManifest(f.filename);assert.deepEqual(skill.artifacts,[]);assert.equal(skill.publication.kind,'skill');assert.equal(skill.publication.slug,'fixture');assert.equal(skill.publication.body,f.asset.card.body);assert.deepEqual(skill.publication.resources,f.asset.card.resources);
        const result=await publishCatalog({asset:f.filename,dryRun:true});assert.equal(result.ok,true);assert.equal(result.tools[0].kind,'skill');assert.deepEqual(result.tools[0].targets,[]);assert.equal(result.tools[0].publicationKey,publicationKey(f.asset.id,f.asset.version));
        assert.deepEqual(await fs.readdir(f.root,{recursive:true}),before);
    }finally{globalThis.fetch=request;}
});
test('Operator retains the original skill snapshot with exact SHA and no runtime importer',async t=>{
    const f=await fixture(t,{archive:true}),retained=[];
    const result=await retainSupplyFiles(f.filename,publicationKey(f.asset.id,f.asset.version),{pool:{},blobs:{ingestLocal:async(files,key)=>{
        assert.equal(key,publicationKey(f.asset.id,f.asset.version));for(const file of files){assert.deepEqual(await fs.readFile(file.archivePath),f.sourceBytes);retained.push(file);}return files;
    }}});
    assert.equal(retained.length,1);assert.deepEqual(result.retained,[{sha256:assetDigest(f.sourceBytes),bytes:f.sourceBytes.length}]);assert.ok(!JSON.stringify(result).includes(f.root));
});
test('Nested binary skill resources preserve canonical base64 through native CLI validation',async t=>{
    const f=await fixture(t),bytes=Buffer.from([0,255,1,128,64]);f.asset.card.resources.push({path:'assets/nested/example.png',content:bytes.toString('base64'),encoding:'base64'});await f.save();
    const [skill]=await readyManifest(f.filename),resource=skill.publication.resources.find(file=>file.path==='assets/nested/example.png');assert.equal(resource.encoding,'base64');assert.deepEqual(Buffer.from(resource.content,'base64'),bytes);
});
test('Skill CLI allows exact delivered resource links, fragments and remote documentation',async t=>{
    const f=await fixture(t);f.asset.card.body='# Инструкция\n[Ресурс](references/deep/guide.md#details) [Документация](https://example.test/guide) [Раздел](#section)';await f.save();
    const [skill]=await readyManifest(f.filename);assert.equal(skill.publication.body,f.asset.card.body);
    const result=await publishCatalog({asset:f.filename,dryRun:true});assert.equal(result.ok,true);
});
for(const link of ['references/missing.md','../private.md','%2e%2e/private.md','file:///tmp/private.md','/tmp/private.md','references\\private.md','bad%ZZ'])test('Skill CLI rejects missing or unsafe local link before operator mutation: '+link,async t=>{
    const f=await fixture(t);f.asset.card.body='# Инструкция\n[Ссылка]('+link+')';await f.save();
    const request=globalThis.fetch;globalThis.fetch=()=>assert.fail('Invalid skill must fail before authentication or import');
    try{await assert.rejects(readyManifest(f.filename));await assert.rejects(publishCatalog({asset:f.filename,dryRun:true}));}
    finally{globalThis.fetch=request;}
});
test('Skill operator publish sends the unchanged envelope through the ordinary Gateway imports API',async t=>{
    const f=await fixture(t),cookieFile=path.join(f.root,'session');await fs.writeFile(cookieFile,'synthetic-session=operator');const request=globalThis.fetch,calls=[];
    globalThis.fetch=async(url,options)=>{
        calls.push({url:String(url),options});
        if(String(url).endsWith('/auth/me'))return Response.json({user:{activeRole:'Главный админ',userRoles:['Главный админ']}});
        assert.equal(String(url),'http://localhost:5173/api/tool-builds/imports');assert.equal(options.method,'POST');const input=JSON.parse(options.body);assert.deepEqual(input.asset,f.asset);assert.equal(input.requestKey,publicationKey(f.asset.id,f.asset.version));
        return Response.json({catalogId:'common/fixture',name:f.asset.card.name,version:1,assetId:f.asset.id,sourceVersion:f.asset.version,sourceSha256:assetDigest(serializeAsset(f.asset))});
    };
    try{const result=await publishCatalog({asset:f.filename,baseUrl:'http://localhost:5173',cookieFile,dryRun:false});assert.equal(result.tools[0].id,'common/fixture');assert.equal(calls.length,2);}
    finally{globalThis.fetch=request;}
});
test('Public skill export preserves inline resources and exact original snapshot without rewriting input',async t=>{
    const f=await fixture(t,{archive:true}),original=await fs.readFile(f.filename),output=path.join(f.root,'public-release');
    const exported=await exportCatalogRelease({asset:f.filename,release:'skill-fixture-v1',output});const [ready]=await readyManifest(exported.asset);
    assert.equal(exported.archives,0);assert.equal(ready.asset.version,'release-skill-fixture-v1');assert.deepEqual(ready.asset.card,f.asset.card);assert.deepEqual(ready.asset.source,f.asset.source);
    assert.deepEqual(await fs.readFile(path.join(output,toolSourcePath(f.asset.source.sha256))),f.sourceBytes);assert.deepEqual(await fs.readFile(f.filename),original);
});
test('Catalog container layout validates and dry-runs Skill supply without any Skills service or compiled sibling',async t=>{
    const f=await fixture(t,{archive:true}),repository=fileURLToPath(new URL('../../../',import.meta.url)),layout=path.join(f.root,'container');
    const app=path.join(layout,'app'),shared=path.join(layout,'shared'),tools=path.join(layout,'tools'),scripts=path.join(tools,'scripts/catalog-plugins');
    await fs.mkdir(app,{recursive:true});await fs.mkdir(scripts,{recursive:true});await fs.mkdir(path.join(tools,'services'),{recursive:true});
    await fs.copyFile(path.join(repository,'services/catalog-service/package.json'),path.join(app,'package.json'));
    await fs.symlink(path.join(repository,'services/catalog-service/node_modules'),path.join(app,'node_modules'));
    await fs.cp(path.join(repository,'services/shared'),shared,{recursive:true,verbatimSymlinks:true,filter:source=>path.basename(source)!=='node_modules'});
    await fs.symlink(path.join(app,'node_modules'),path.join(shared,'node_modules'));
    await fs.symlink(app,path.join(tools,'services/catalog-service'));await fs.symlink(shared,path.join(tools,'services/shared'));await fs.symlink(path.join(app,'node_modules'),path.join(tools,'node_modules'));
    for(const file of ['manifest.mjs','supply-layout.mjs','publish.mjs'])await fs.copyFile(new URL('../'+file,import.meta.url),path.join(scripts,file));
    await assert.rejects(fs.access(path.join(tools,'services/skills-service')),{code:'ENOENT'});await assert.rejects(fs.access(path.join(app,'dist')),{code:'ENOENT'});
    const entry=`import {pathToFileURL} from 'node:url';
        globalThis.fetch=()=>{throw Error('Container validation must stay offline');};
        const script=process.argv[1],asset=process.argv[2];process.argv[1]='container-layout-test.mjs';
        const {publishCatalog}=await import(pathToFileURL(script).href);
        console.log(JSON.stringify(await publishCatalog({asset,dryRun:true})));`;
    const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',entry,path.join(scripts,'publish.mjs'),f.filename],{cwd:tools,timeout:15000,maxBuffer:1024*1024});
    const result=JSON.parse(stdout);assert.equal(result.ok,true);assert.equal(result.tools[0].kind,'skill');assert.deepEqual(result.tools[0].targets,[]);
});
for(const mode of ['missing','corrupt','symlink','unsafe-native','recipe'])test('Invalid skill supply is rejected before publication: '+mode,async t=>{
    const f=await fixture(t,{archive:true});
    if(mode==='missing')await fs.unlink(f.sourceFile);
    if(mode==='corrupt')await fs.writeFile(f.sourceFile,Buffer.alloc(f.sourceBytes.length,0));
    if(mode==='symlink'){await fs.rename(f.sourceFile,f.sourceFile+'.original');await fs.symlink(f.sourceFile+'.original',f.sourceFile);}
    if(mode==='unsafe-native'){f.asset.card.resources=[{path:'../escape',content:'bad'}];await fs.writeFile(f.filename,JSON.stringify(f.asset));}
    if(mode==='recipe'){f.asset.recipe={path:'README.md',sha256:assetDigest(f.sourceBytes)};await fs.writeFile(f.filename,JSON.stringify(f.asset));}
    await assert.rejects(readyManifest(f.filename));
});
