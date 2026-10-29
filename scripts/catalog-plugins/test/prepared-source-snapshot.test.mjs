import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {PREPARED_SOURCE_INPUTS,PREPARED_SOURCE_MAX_FILES,preparedSourceFiles,capturePreparedSource} from '../prepared-source-snapshot.mjs';
import {exportBuiltAsset} from '../source-envelope.mjs';
import {readyManifest} from '../manifest.mjs';
import {builtAssetFixture} from './built-asset.fixture.mjs';
import {toolRuntimePath,toolSourcePath} from '../supply-layout.mjs';
import {validateRecipe} from '../recipe-schema.mjs';
import {RAG_PLUGIN_SOURCE} from '../../../services/shared/opencode-rag-source.cjs';

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

const canonicalRecipe=()=>validateRecipe({schemaVersion:1,key:'retained-rag',name:'Retained RAG',kind:'plugin',description:'Public producer fixture',revision:'git-'+RAG_PLUGIN_SOURCE.commit,
    source:{type:'repository',url:RAG_PLUGIN_SOURCE.url,commit:RAG_PLUGIN_SOURCE.commit,entrypoint:RAG_PLUGIN_SOURCE.entrypoint},targets:['darwin-arm64']});
const upstream={version:'2.12.2',archiveSha256:'a92207b01fa04df1ac4df45ead1f8bbca3e556b38f002e6dd94902ec09d609ee',repository:RAG_PLUGIN_SOURCE.url,commit:RAG_PLUGIN_SOURCE.commit};
/** Only dependency modules and already-built public validators are borrowed; producer source resolves inside the fixture. */
async function producerDependencies(root){
    const service=path.join(root,'services/catalog-service');
    await fs.symlink(path.join(repository,'node_modules'),path.join(root,'node_modules'),'dir');
    await fs.symlink(path.join(repository,'services/catalog-service/node_modules'),path.join(service,'node_modules'),'dir');
    await fs.cp(path.join(repository,'services/catalog-service/dist/publication'),path.join(service,'dist/publication'),{recursive:true});
    await fs.mkdir(path.join(service,'dist/devices'),{recursive:true});
    await fs.copyFile(path.join(repository,'services/catalog-service/dist/devices/mcp-config-schema.js'),path.join(service,'dist/devices/mcp-config-schema.js'));
}
/** The upstream preparation boundary emits a tiny checked runtime; build/capture/export/pack stay real. */
async function controlledProducer(t){
    const root=await fixture(t);await producerDependencies(root);
    await fs.writeFile(path.join(root,'scripts/catalog-plugins/recipes/opencode-rag-plugin.mjs'),`
        import fs from 'node:fs/promises';import path from 'node:path';
        export async function prepareOpenCodeRagPlugin(context){
            await fs.appendFile(path.join(context.recipeDirectory,'preparation-invocations.jsonl'),'prepared\\n');
            await fs.writeFile(path.join(context.directory,'entrypoint.mjs'),'export default async()=>({});\\n');
            await fs.copyFile(new URL('../locks/opencode-rag-plugin.json',import.meta.url),path.join(context.directory,'package-lock.json'));
            return {entrypoint:'entrypoint.mjs',config:{entrypoint:'entrypoint.mjs'},upstream:${JSON.stringify(upstream)}};
        }
    `);
    return {root,...await import(pathToFileURL(path.join(root,'scripts/catalog-plugins/build.mjs')).href)};
}
test('Adapted producer canonical build retains full recipe, Git identity, actual material provenance and target lock bytes',async t=>{
    const producer=await controlledProducer(t),recipe=canonicalRecipe(),output=path.join(producer.root,'output');
    const result=await producer.buildRecipe({recipe,recipePath:path.join(producer.root,'recipe.json'),output});
    const [built]=await readyManifest(result.manifest);assert.equal(built.asset.source.type,'archive');
    const bytes=await fs.readFile(built.sourceSnapshotPath,'utf8'),snapshot=JSON.parse(bytes);
    assert.equal(snapshot.schemaVersion,1);assert.equal(snapshot.type,'neurocenter-prepared-producer');assert.equal(snapshot.adapter,'opencode-rag-plugin');
    assert.deepEqual(snapshot.recipe,recipe);assert.deepEqual(snapshot.declaration,recipe.source);assert.equal(built.publication.origin,recipe.source.url);
    assert.deepEqual(snapshot.sources[0].upstream,upstream);
    assert.equal(snapshot.files.find(file=>file.path==='scripts/catalog-plugins/recipes/adapters/rag-index-corpus.mjs')?.content,await fs.readFile(path.join(repository,'scripts/catalog-plugins/recipes/adapters/rag-index-corpus.mjs'),'utf8'));
    assert.equal(snapshot.locks.length,1);assert.equal(snapshot.locks[0].content,await fs.readFile(path.join(producer.root,'scripts/catalog-plugins/locks/opencode-rag-plugin.json'),'utf8'));
    assert.equal(createHash('sha256').update(snapshot.locks[0].content).digest('hex'),snapshot.locks[0].sha256);
    assert.ok(!bytes.includes(producer.root));assert.ok(!bytes.includes(repository));
    assert.equal(await fs.readFile(path.join(producer.root,'preparation-invocations.jsonl'),'utf8'),'prepared\n');
});
test('Adapted producer source-only mutation changes source and asset identity with an unchanged runtime pin',async t=>{
    const root=await fixture(t),built=await builtAssetFixture(t),recipe=canonicalRecipe(),sources=[{target:'darwin-arm64',upstream,entrypoint:built.descriptor.entrypoint}];
    const publish=async(name,inputs)=>{
        const destination=path.join(root,name);await fs.mkdir(path.join(destination,'artifacts'),{recursive:true});await fs.copyFile(built.archive,path.join(destination,toolRuntimePath(built.descriptor.sha256)));
        return (await readyManifest(await exportBuiltAsset({recipe,recipeDirectory:root,destination,publication:{...built.publication,origin:recipe.source.url},descriptors:[built.descriptor],sources,locks:[],preparedInputs:inputs??await preparedSourceFiles(root)})))[0];
    };
    const before=await publish('before'),relocated=await publish('relocated',await preparedSourceFiles(await fixture(t)));
    assert.equal(relocated.asset.source.sha256,before.asset.source.sha256);assert.equal(relocated.asset.version,before.asset.version);
    await fs.appendFile(path.join(root,adapter),'\n// Public source-only adapter fixture.\n');const after=await publish('after');
    assert.equal(before.asset.source.type,'archive');assert.notEqual(before.asset.source.sha256,after.asset.source.sha256);assert.notEqual(before.asset.version,after.asset.version);
    assert.deepEqual(before.asset.delivery,after.asset.delivery);assert.equal(after.publication.origin,recipe.source.url);
    const snapshot=JSON.parse(await fs.readFile(after.sourceSnapshotPath,'utf8'));assert.deepEqual(snapshot.declaration,recipe.source);assert.deepEqual(snapshot.sources,sources);
    assert.ok(snapshot.files.find(file=>file.path===adapter).content.includes('Public source-only adapter fixture.'));
});
test('Adapted producer transient edits abort the actual canonical build before export even when bytes are restored',async t=>{
    const producer=await controlledProducer(t),recipe=canonicalRecipe(),output=path.join(producer.root,'output'),filename=path.join(producer.root,adapter),bytes=await fs.readFile(filename);let changed=false;
    await assert.rejects(producer.buildRecipe({recipe,recipePath:path.join(producer.root,'recipe.json'),output,onProgress:async event=>{
        if(event.completed===1&&!changed){changed=true;await fs.writeFile(filename,'transient fixture edit');await fs.writeFile(filename,bytes);}
    }}),/producer изменились/);
    assert.equal(changed,true);assert.equal(await fs.readFile(path.join(producer.root,'preparation-invocations.jsonl'),'utf8'),'prepared\n');
    assert.deepEqual(await fs.readFile(filename),bytes);await assert.rejects(fs.access(path.join(output,'asset.json')),{code:'ENOENT'});
    assert.ok(!(await fs.readdir(output)).some(name=>name.startsWith('.build-')||name==='.source-cache'));
});
test('Adapted producer snapshot materializes the real managed adapter copy closure in an isolated source tree',async t=>{
    const root=await fixture(t),records=await preparedSourceFiles(root),restored=path.join(root,'restored');
    for(const record of records){const target=path.join(restored,record.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,record.content);}
    // Upstream patch contracts are outside this copy-closure test; helpers and their import rewrites execute unchanged.
    await fs.writeFile(path.join(restored,'scripts/catalog-plugins/recipes/rag-web-ui.mjs'),'export const RAG_LOCAL_UI={};export async function applyManagedWebUiCompatibility(){return {fixture:true};}\n');
    const recipeFile=path.join(restored,'scripts/catalog-plugins/recipes/opencode-rag.mjs'),recipeSource=await fs.readFile(recipeFile,'utf8');
    const start=recipeSource.indexOf('export async function applyManagedQuirksCompatibility(directory) {'),end=recipeSource.indexOf('/** Общие управляемые команды',start);
    assert.ok(start>0&&end>start);await fs.writeFile(recipeFile,recipeSource.slice(0,start)+'export async function applyManagedQuirksCompatibility(){return {fixture:true};}\n\n'+recipeSource.slice(end));
    const output=path.join(root,'runtime'),core=path.join(output,'upstream/dist/core');await fs.mkdir(core,{recursive:true});await fs.writeFile(path.join(core,'runtime-overrides.js'),'export function merge(){\n    return merged;\n}\n');
    const {prepareManagedRagCommands}=await import(pathToFileURL(path.join(restored,'scripts/catalog-plugins/recipes/opencode-rag.mjs')).href);
    await prepareManagedRagCommands(output);
    const helper='scripts/catalog-plugins/recipes/adapters/rag-index-corpus.mjs';assert.equal(await fs.readFile(path.join(output,'rag-index-corpus.mjs'),'utf8'),records.find(file=>file.path===helper).content);
    const {indexCorpusConfiguration}=await import(pathToFileURL(path.join(output,'rag-index-corpus.mjs')).href);assert.equal(typeof indexCorpusConfiguration,'function');
    assert.match(await fs.readFile(path.join(output,'rag-index-profile.mjs'),'utf8'),/from '\.\/rag-index-corpus\.mjs'/);
    assert.ok(!(await fs.readFile(path.join(output,'rag-index-profile.mjs'),'utf8')).includes('../../../../services/shared/'));
    const guard=await import(pathToFileURL(path.join(output,'rag-quirks-guard.mjs')).href),journal=path.join(output,'quirks.jsonl');
    await fs.writeFile(journal,'{broken}\n');assert.throws(()=>guard.assertManagedQuirksSource(output));
    assert.equal(await fs.readFile(journal,'utf8'),'{broken}\n');
});
test('Source snapshot privacy uses the actual project public selection without root or nested npm credentials',async t=>{
    const producer=await controlledProducer(t),source=path.join(producer.root,'source'),output=path.join(producer.root,'output');
    for(const directory of ['nested','case'])await fs.mkdir(path.join(source,directory),{recursive:true});
    const files={'index.mjs':'export default async()=>({});\n','package.json':'{"name":"source-fixture","type":"module"}\n','package-lock.json':'{"lockfileVersion":3,"packages":{}}\n',
        '.npmrc':'//registry.npmjs.org/:_authToken=synthetic-private-root','nested/.npmrc':'//registry.npmjs.org/:_authToken=synthetic-private-nested',
        '.env':'synthetic-private-env','nested/.env.production':'synthetic-private-nested-env','case/.NPMRC':'synthetic-private-case-npmrc','nested/public.txt':'Public nested fixture\n'};
    for(const [relative,content] of Object.entries(files))await fs.writeFile(path.join(source,relative),content);
    const recipe={...canonicalRecipe(),source:{type:'project',directory:'source',entrypoint:'index.mjs'}};
    const result=await producer.buildRecipe({recipe,recipePath:path.join(producer.root,'recipe.json'),output}),[built]=await readyManifest(result.manifest);
    const snapshot=JSON.parse(await fs.readFile(built.sourceSnapshotPath,'utf8'));
    assert.deepEqual(snapshot.files.map(file=>file.path).sort(),['index.mjs','nested/public.txt','package-lock.json','package.json']);
    assert.ok(!snapshot.files.some(file=>file.content.includes('synthetic-private-')));
    for(const [relative,content] of Object.entries(files))assert.equal(await fs.readFile(path.join(source,relative),'utf8'),content);
});
test('Source snapshot privacy keeps files-source credential rejection and prepared secret-env rejection before publication',async t=>{
    const producer=await controlledProducer(t),source=path.join(producer.root,'source');await fs.mkdir(source);
    await fs.writeFile(path.join(source,'index.mjs'),'export default async()=>({});\n');await fs.writeFile(path.join(source,'.npmrc'),'synthetic-private-files-token');
    for(const [name,recipe] of [
        ['files',{...canonicalRecipe(),source:{type:'files',directory:'source',entrypoint:'index.mjs'}}],
        ['secret-env',{...canonicalRecipe(),kind:'mcp',source:{type:'prepared',adapter:'memory'},config:{env:{API_TOKEN:'synthetic-private-token'}}}],
    ]){
        const output=path.join(producer.root,name);await assert.rejects(producer.buildRecipe({recipe,recipePath:path.join(producer.root,'recipe.json'),output}),/путь|секрет/i);
        await assert.rejects(fs.access(path.join(output,'asset.json')),{code:'ENOENT'});
    }
});
test('Adapted producer keeps approved public args, env literals and secret references unchanged in its full recipe',async t=>{
    const root=await fixture(t),built=await builtAssetFixture(t,{kind:'mcp'}),recipe=validateRecipe({...canonicalRecipe(),kind:'mcp',source:{type:'prepared',adapter:'opencode-rag'},
        config:{transport:'stdio',command:'node',args:['--fixture-value=keep'],env:{FIXTURE_MODE:'public',API_TOKEN:'{env:FIXTURE_API_TOKEN}'}}});
    const destination=path.join(root,'output');await fs.mkdir(path.join(destination,'artifacts'),{recursive:true});await fs.copyFile(built.archive,path.join(destination,toolRuntimePath(built.descriptor.sha256)));
    const filename=await exportBuiltAsset({recipe,recipeDirectory:root,destination,publication:{...built.publication,config:{...built.publication.config,...recipe.config}},descriptors:[built.descriptor],sources:[],locks:[],preparedInputs:await preparedSourceFiles(root)});
    const [tool]=await readyManifest(filename),snapshot=JSON.parse(await fs.readFile(tool.sourceSnapshotPath,'utf8'));assert.deepEqual(snapshot.recipe,recipe);
    assert.deepEqual(tool.publication.config.args,recipe.config.args);assert.deepEqual(tool.publication.config.env,recipe.config.env);
});
test('Adapted producer matching never turns a different repository, commit, entrypoint or subdirectory into a prepared source',async t=>{
    const root=await fixture(t),built=await builtAssetFixture(t),canonical=canonicalRecipe();
    for(const [index,change] of [{url:'https://github.com/fixture/example'},{commit:'a'.repeat(40)},{entrypoint:'src/other.ts'},{subdirectory:'src'}].entries()){
        const recipe=validateRecipe({...canonical,source:{...canonical.source,...change}}),destination=path.join(root,String(index));
        await fs.mkdir(path.join(destination,'artifacts'),{recursive:true});await fs.copyFile(built.archive,path.join(destination,toolRuntimePath(built.descriptor.sha256)));
        const filename=await exportBuiltAsset({recipe,recipeDirectory:root,destination,publication:{...built.publication,origin:recipe.source.url},descriptors:[built.descriptor],sources:[],locks:[],preparedInputs:await preparedSourceFiles(root)});
        const [tool]=await readyManifest(filename);assert.deepEqual(tool.asset.source,{type:'git',repository:recipe.source.url,commit:recipe.source.commit,...recipe.source.subdirectory?{path:recipe.source.subdirectory}:{}});
        assert.equal(tool.sourceSnapshotPath,undefined);assert.equal(tool.publication.origin,recipe.source.url);
    }
});
test('Adapted producer target locks must retain exact bounded regular UTF-8 bytes before source publication',async t=>{
    const root=await fixture(t),built=await builtAssetFixture(t),recipe=canonicalRecipe(),records=await preparedSourceFiles(root);
    for(const mode of ['hash','symlink','oversize']){
        const destination=path.join(root,mode);await fs.mkdir(destination);const filename=path.join(destination,'lock-darwin-arm64.json');
        await fs.writeFile(filename,mode==='oversize'?'x'.repeat(1048577):'{}');
        if(mode==='symlink'){await fs.rename(filename,filename+'.original');await fs.symlink(filename+'.original',filename);}
        await assert.rejects(exportBuiltAsset({recipe,recipeDirectory:root,destination,publication:built.publication,descriptors:[built.descriptor],sources:[],locks:[{target:'darwin-arm64',file:path.basename(filename),sha256:'0'.repeat(64)}],preparedInputs:records}));
        await assert.rejects(fs.access(path.join(destination,'asset.json')),{code:'ENOENT'});
    }
});
