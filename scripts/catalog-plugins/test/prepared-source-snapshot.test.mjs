import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {PREPARED_SOURCE_INPUTS,PREPARED_SOURCE_MAX_FILES,preparedSourceFiles,capturePreparedSource} from '../prepared-source-snapshot.mjs';
import {exportBuiltAsset} from '../source-envelope.mjs';
import {readyManifest} from '../manifest.mjs';
import {builtAssetFixture} from './built-asset.fixture.mjs';
import {toolRuntimePath,toolSourcePath} from '../supply-layout.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url)),adapter='scripts/catalog-plugins/recipes/adapters/rag-reindex.mjs';
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-public-producer-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    for(const relative of PREPARED_SOURCE_INPUTS){const filename=path.join(root,relative);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.copyFile(path.join(repository,relative),filename);}
    return root;
}
test('Prepared snapshots retain actual adapters, producers, shared helpers and locks, without private paths or directory scans',async t=>{
    const root=await fixture(t);await fs.writeFile(path.join(root,'.env'),'private fixture must never be retained');await fs.mkdir(path.join(root,'node_modules'));await fs.writeFile(path.join(root,'node_modules','secret'),'private');
    const records=await preparedSourceFiles(root),text=JSON.stringify(records);
    assert.deepEqual(records.map(file=>file.path),PREPARED_SOURCE_INPUTS);assert.ok(records.length<=PREPARED_SOURCE_MAX_FILES);assert.ok(records.reduce((sum,file)=>sum+Buffer.byteLength(file.content),0)<=5*1048576);
    assert.equal(records.find(file=>file.path===adapter).content,await fs.readFile(path.join(repository,adapter),'utf8'));
    assert.ok(records.some(file=>file.path==='services/shared/rag-index-contract.cjs'));assert.ok(records.some(file=>file.path==='scripts/catalog-plugins/locks/opencode-rag-plugin.json'));
    assert.ok(records.some(file=>file.path==='services/shared/skill-source.mjs'),'The retained manifest must resolve its skill preflight without the original checkout.');
    assert.equal(records.find(file=>file.path==='scripts/catalog-plugins/payload-description.mjs')?.content,await fs.readFile(path.join(repository,'scripts/catalog-plugins/payload-description.mjs'),'utf8'),'Release/upload preflight retains its public description helper.');
    assert.ok(!text.includes(root));assert.ok(!text.includes(repository));assert.ok(!text.includes('private fixture must never be retained'));assert.ok(!records.some(file=>/node_modules|\/test\/|\/examples\/|\.env$/.test(file.path)));
});
test('Retained producer modules resolve without the original checkout and its expanded snapshot still round-trips',async t=>{
    const root=await fixture(t),records=await preparedSourceFiles(root),require=createRequire(path.join(root,'package.json')),loaded=new Set(Object.keys(require.cache));
    const memory=require('./services/shared/project-learning-memory-sync.cjs'),learning=require('./services/shared/project-learning.cjs'),quirks=require('./services/shared/project-learning-quirks.cjs');
    assert.equal(memory.MEMORY_RECIPE.package,'@modelcontextprotocol/server-memory');assert.equal(typeof learning.normalizeLearningContext,'function');assert.equal(typeof quirks.supportsLearningQuirks,'function');
    const transport=await import(pathToFileURL(path.join(root,'scripts/catalog-plugins/tool-import-request.mjs')).href);assert.equal(typeof transport.requestToolImport,'function');
    for(const filename of Object.keys(require.cache).filter(filename=>!loaded.has(filename)))assert.ok(filename.startsWith(root+path.sep),`Retained module resolved outside its snapshot: ${filename}`);
    const built=await builtAssetFixture(t),destination=path.join(root,'retained-supply');await fs.mkdir(path.join(destination,'artifacts'),{recursive:true});await fs.copyFile(built.archive,path.join(destination,toolRuntimePath(built.descriptor.sha256)));
    const filename=await exportBuiltAsset({recipe:{key:'retained-producer-closure',source:{type:'prepared',adapter:'memory'}},recipeDirectory:root,destination,publication:built.publication,descriptors:[built.descriptor],sources:[],locks:[],preparedInputs:records});
    const [roundtrip]=await readyManifest(filename),snapshot=JSON.parse(await fs.readFile(path.join(destination,toolSourcePath(roundtrip.asset.source.sha256)),'utf8'));
    assert.ok(snapshot.files.length>100);assert.deepEqual(snapshot.files,records);
});
test('Prepared producer budget cannot increase the separate limit for arbitrary user-source files',async t=>{
    const root=await fixture(t),directory=path.join(root,'untrusted-source');await fs.mkdir(directory);
    for(let index=0;index<101;index++)await fs.writeFile(path.join(directory,String(index).padStart(3,'0')+'.mjs'),'export default {};');
    const built=await builtAssetFixture(t);
    await assert.rejects(exportBuiltAsset({recipe:{key:'user-source-limit',source:{type:'files',directory:'untrusted-source',entrypoint:'000.mjs',prepared:true}},recipeDirectory:root,destination:path.join(root,'output'),publication:built.publication,descriptors:[built.descriptor],sources:[],locks:[],preparedInputs:await preparedSourceFiles(root)}),/до 100 публичных файлов/);
});
test('Prepared source allowlist retains the local import closure of producer and shared modules',async()=>{
    const included=new Set(PREPARED_SOURCE_INPUTS);
    for(const relative of PREPARED_SOURCE_INPUTS){
        const content=await fs.readFile(path.join(repository,relative),'utf8');
        for(const match of content.matchAll(/(?:from\s*|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/g)){
            const target=path.normalize(path.join(path.dirname(relative),match[1]));
            for(const candidate of [target,target+'.ts',target+'.mjs',target+'.cjs',path.join(target,'index.ts')]){
                try{if(!(await fs.stat(path.join(repository,candidate))).isFile())continue;}catch(error){if(error.code==='ENOENT')continue;throw error;}
                assert.ok(included.has(candidate),`${relative} imports missing retained source ${candidate}`);break;
            }
        }
    }
});
test('Retained sources rebuild and execute the publication validator in isolation, including declaration inputs',async t=>{
    const root=await fixture(t),service=path.join(root,'services/catalog-service'),dependencies=path.join(repository,'services/catalog-service/node_modules');
    await fs.symlink(dependencies,path.join(service,'node_modules'),'dir');
    const compiler=path.join(dependencies,'typescript/bin/tsc'),built=spawnSync(process.execPath,[compiler,'-p',path.join(service,'tsconfig.build.json')],{cwd:root,encoding:'utf8',timeout:30000});
    assert.equal(built.status,0,built.stdout+built.stderr);
    const require=createRequire(path.join(service,'package.json')),loaded=new Set(Object.keys(require.cache)),{validatePublication}=require('./dist/publication/publication-validation.js');
    const publication={kind:'plugin',name:'Retained producer',description:'Isolated source fixture',revision:'1.0.0',config:{entrypoint:'entrypoint.mjs'},files:[{path:'entrypoint.mjs',content:'export default async()=>({});'}]};
    assert.equal(validatePublication(publication).name,publication.name);
    assert.throws(()=>validatePublication({...publication,config:{entrypoint:'missing.mjs'}}));
    for(const filename of Object.keys(require.cache).filter(filename=>!loaded.has(filename))){assert.ok(filename.startsWith(root+path.sep)||filename.includes(path.sep+'node_modules'+path.sep),`Validator imported source outside the retained snapshot: ${filename}`);}
});
test('An adapter mutation changes source SHA and the native asset tuple while preserving the checked archive pin',async t=>{
    const root=await fixture(t),built=await builtAssetFixture(t),recipe={key:'retained-prepared',source:{type:'prepared',adapter:'opencode-rag-plugin'}};
    const publish=async(name,inputs)=>{
        const destination=path.join(root,name);await fs.mkdir(path.join(destination,'artifacts'),{recursive:true});await fs.copyFile(built.archive,path.join(destination,toolRuntimePath(built.descriptor.sha256)));
        const filename=await exportBuiltAsset({recipe,recipeDirectory:root,destination,publication:built.publication,descriptors:[built.descriptor],sources:[],locks:[],preparedInputs:inputs});
        return (await readyManifest(filename))[0].asset;
    };
    const before=await publish('before',await preparedSourceFiles(root));await fs.appendFile(path.join(root,adapter),'\n// Different managed reindex adapter.\n');
    const after=await publish('after',await preparedSourceFiles(root));
    assert.notEqual(before.source.sha256,after.source.sha256);assert.notEqual(before.version,after.version);assert.deepEqual(before.delivery.artifacts,after.delivery.artifacts);
    const snapshot=JSON.parse(await fs.readFile(path.join(root,'after',toolSourcePath(after.source.sha256)),'utf8'));assert.ok(snapshot.files.find(file=>file.path===adapter).content.includes('Different managed reindex adapter.'));
});
test('A transient edit restored to the same bytes still invalidates an in-flight producer capture',async t=>{
    const root=await fixture(t),before=await capturePreparedSource(root),filename=path.join(root,adapter),content=await fs.readFile(filename);
    await fs.writeFile(filename,'temporary adapter edit');await fs.writeFile(filename,content);const after=await capturePreparedSource(root);
    assert.deepEqual(after.files,before.files);assert.notEqual(after.revision,before.revision);
});
for(const mode of ['NUL','oversize','hardlink','symlink'])test(`Prepared source rejects ${mode} instead of publishing an incomplete snapshot`,async t=>{
    const root=await fixture(t),filename=path.join(root,adapter);
    if(mode==='NUL')await fs.writeFile(filename,Buffer.from([0]));
    if(mode==='oversize')await fs.writeFile(filename,'x'.repeat(1048577));
    if(mode==='hardlink')await fs.link(filename,path.join(root,'aliased-adapter'));
    if(mode==='symlink'){await fs.rename(filename,path.join(root,'actual-adapter'));await fs.symlink(path.join(root,'actual-adapter'),filename);}
    await assert.rejects(preparedSourceFiles(root));
});
