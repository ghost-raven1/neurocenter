import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {adoptModelBundleFromGit} from '../models/bundle-git-adoption.mjs';
import {sha256} from '../models/bundle-manifest.mjs';
import {hydrateModelBundle} from '../models/bundle.mjs';

const execute=promisify(execFile),base='https://github.com/ghost-raven1/neurocenter/releases/download/models-fixture.1';

/** Предыдущая поставка берётся из настоящих Git objects, файлы рабочего дерева ей не доверяются. */
async function fixture(action,{registry=false,symlinkManifest=false,invalidRegistry=false}={}) {
    const temporary=await realpath(await mkdtemp(path.join(tmpdir(),'nc-model-git-adoption-'))),root=path.join(temporary,'repo'),directory=path.join(temporary,'data');
    await mkdir(root);await mkdir(directory);
    const git=async(...args)=>(await execute('git',args,{cwd:root,encoding:'utf8'})).stdout.trim();
    const json=async(filename,value)=>{await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(value));};
    function bundle(version) {
        const locks=[],files=[],blobs=new Map(),config=Buffer.from('fixture config'),configDigest=sha256(config);blobs.set(configDigest,config);
        for(const [index,name] of ['fixture-embedding','fixture-vision',...(registry?['public/fixture-chat']:[])].entries()) {
            const weights=Buffer.from(name+' '+version),digest=sha256(weights);blobs.set(digest,weights);
            const manifest={schemaVersion:2,config:{digest:'sha256:'+configDigest,size:config.length},layers:[{digest:'sha256:'+digest,size:weights.length}]};
            const bytes=Buffer.from(JSON.stringify(manifest));
            locks.push({schemaVersion:1,model:name+':1',manifest,manifestSha256:sha256(bytes)});
            files.push({path:`models/manifests/registry.ollama.ai/${name.includes('/')?name:'library/'+name}/1`,size:bytes.length,sha256:sha256(bytes),inlineBase64:bytes.toString('base64')});
        }
        for(const [digest,bytes] of blobs)files.push({path:'models/blobs/sha256-'+digest,size:bytes.length,sha256:digest,parts:[{name:`model-${digest}-001.bin`,size:bytes.length,sha256:digest}]});
        return {locks,manifest:{schemaVersion:1,kind:'neurocenter-model-bundle',releaseBaseUrl:base,files},blobs};
    }
    async function metadata(bundle) {
        const lockPaths=['scripts/embedding/model.lock.json','scripts/vision/model.lock.json','scripts/models/locks/model-fixture-chat.lock.json'];
        for(const [index,lock] of bundle.locks.entries())await json(path.join(root,lockPaths[index]),lock);
        if(registry)await json(path.join(root,'scripts/models/model-registry.json'),{schemaVersion:1,models:bundle.locks.map((lock,index)=>({
            id:['model-fixture-embedding','model-fixture-vision','model-fixture-chat'][index],name:lock.model,
            lock:['../embedding/model.lock.json','../vision/model.lock.json','./locks/model-fixture-chat.lock.json'][index],
            descriptor:{description:'Public fixture',capability:['embedding','vision','chat'][index],runtime:'ollama',model:lock.model,manifestSha256:lock.manifestSha256,dimension:index===0?4:null,source:'builtin'},
        }))});
        await json(path.join(root,'scripts/models/bundle-release.json'),bundle.manifest);
    }
    await git('init','--quiet','--initial-branch=main');
    const commit=async message=>{await git('add','scripts');await git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m',message);return git('rev-parse','HEAD');};
    const first=bundle('old'),second=bundle('new');await metadata(first);
    if(invalidRegistry)await json(path.join(root,'scripts/models/model-registry.json'),null);
    if(symlinkManifest) {const filename=path.join(root,'scripts/models/bundle-release.json');await rm(filename);await symlink('../embedding/model.lock.json',filename);}
    const previous=await commit('Previous pinned public models');
    await metadata(second);const head=await commit('New pinned public models');await git('update-ref','ORIG_HEAD',previous);
    for(const file of first.manifest.files) {
        await mkdir(path.dirname(path.join(directory,file.path)),{recursive:true});
        await writeFile(path.join(directory,file.path),file.inlineBase64?Buffer.from(file.inlineBase64,'base64'):first.blobs.get(file.sha256));
    }
    const adopt=reference=>adoptModelBundleFromGit({root,directory,reference});
    const tags=()=>Promise.all(first.manifest.files.filter(file=>file.inlineBase64).map(file=>readFile(path.join(directory,file.path),'utf8')));
    try{await action({root,directory,first,second,previous,head,git,json,metadata,commit,adopt,tags});}
    finally{await rm(temporary,{recursive:true,force:true});}
}

test('Старая поставка без реестра регистрируется по ORIG_HEAD и обновляется без смены checkout',async()=>fixture(async({directory,first,second,previous,head,git,adopt,tags})=>{
    const before=await tags(),result=await adopt('ORIG_HEAD');assert.equal(result.sourceCommit,previous);assert.equal(result.models,2);
    assert.deepEqual(await tags(),before);assert.equal(await git('rev-parse','HEAD'),head);assert.equal(await git('status','--porcelain'),'');
    const pointer=JSON.parse(await readFile(path.join(directory,'.bundle-managed/active.json'),'utf8'));
    const proof=JSON.parse(await readFile(path.join(directory,`.bundle-managed/adoptions/${pointer.revision}.json`),'utf8'));assert.equal(proof.sourceCommit,previous);
    for(const [digest,bytes] of second.blobs)await writeFile(path.join(directory,'models/blobs/sha256-'+digest),bytes);
    await hydrateModelBundle({directory,manifest:second.manifest,locks:second.locks,fetch:()=>{throw new Error('NETWORK MUST NOT RUN');}});
    assert.notDeepEqual(await tags(),before);await hydrateModelBundle({directory,manifest:second.manifest,locks:second.locks,verifyOnly:true});
}));

test('Прежний динамический реестр подтверждает все модели, включая namespaced тег',async()=>fixture(async({directory,adopt,previous})=>{
    const result=await adopt(previous);assert.equal(result.models,3);assert.equal(result.sourceCommit,previous);
    assert.ok((await readdir(path.join(directory,'.bundle-managed/revisions'))).length===1);
},{registry:true}));

test('Commit не из истории HEAD и опасные ссылки отклоняются до регистрации',async()=>fixture(async({git,adopt,directory})=>{
    await git('checkout','--quiet','--orphan','unrelated');await git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','Unrelated');
    const unrelated=await git('rev-parse','HEAD');await git('checkout','--quiet','main');
    for(const ref of [unrelated,'--help','HEAD~1','main:private','a'.repeat(40)])await assert.rejects(adopt(ref),{code:'MODEL_GIT_ADOPTION'});
    await assert.rejects(readFile(path.join(directory,'.bundle-managed/active.json')),{code:'ENOENT'});
}));

test('Пользовательский тег не становится управляемым по факту существования старого commit',async()=>fixture(async({directory,first,adopt,tags})=>{
    const file=first.manifest.files.find(file=>file.inlineBase64);await writeFile(path.join(directory,file.path),'USER CUSTOM TAG');const before=await tags();
    await assert.rejects(adopt('ORIG_HEAD'));assert.deepEqual(await tags(),before);await assert.rejects(readFile(path.join(directory,'.bundle-managed/active.json')),{code:'ENOENT'});
}));

test('Повреждённые старые веса блокируют регистрацию без изменения тегов',async()=>fixture(async({directory,first,adopt,tags})=>{
    const file=first.manifest.files.find(file=>file.parts);await writeFile(path.join(directory,file.path),Buffer.alloc(file.size));const before=await tags();
    await assert.rejects(adopt('ORIG_HEAD'),/SHA/);assert.deepEqual(await tags(),before);await assert.rejects(readFile(path.join(directory,'.bundle-managed/active.json')),{code:'ENOENT'});
}));

test('Подмена tracked описи и символьные ссылки в Git не принимаются',async()=>fixture(async({adopt})=>{
    await assert.rejects(adopt('ORIG_HEAD'),{code:'MODEL_GIT_ADOPTION'});
},{symlinkManifest:true}));

test('Изменённый рабочий реестр не меняет подтверждение старой immutable поставки',async()=>fixture(async({root,adopt,json,previous})=>{
    await json(path.join(root,'scripts/models/model-registry.json'),{PRIVATE:'not executed'});
    const result=await adopt(previous.slice(0,12));assert.equal(result.sourceCommit,previous);
}));


test('Повреждённый реестр из Git не подменяется legacy fallback',async()=>fixture(async({adopt,directory})=>{
    await assert.rejects(adopt('ORIG_HEAD'),{code:'MODEL_GIT_ADOPTION'});
    await assert.rejects(readFile(path.join(directory,'.bundle-managed/active.json')),{code:'ENOENT'});
},{invalidRegistry:true}));
