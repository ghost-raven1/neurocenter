import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {prepareModelSupply,modelSupplyRecipe} from '../models/publish.mjs';
import {parseModelPublishArguments,runModelPublishCli} from '../models/publish-cli.mjs';
import {sha256,modelLocks,modelBundleSummary,validateModelBundle} from '../models/bundle-manifest.mjs';
import {validateModelRegistry,registryModelLocks} from '../models/model-registry.mjs';

const json=value=>JSON.stringify(value,null,2)+'\n';
const disk=async()=>({bavail:100n*1024n**3n,bsize:1n});
const release='models-fixture.2';

async function fixture(action) {
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc-model-supply-'))),directory=path.join(root,'data/embedding'),output=path.join(root,'.run/bundle');
    await mkdir(path.join(root,'scripts/models/locks'),{recursive:true});await mkdir(path.join(directory,'models/blobs'),{recursive:true});
    async function local(model,text) {
        const config=Buffer.from('{}'),weights=Buffer.from(text),manifest={schemaVersion:2,config:{digest:'sha256:'+sha256(config),size:config.length},
            layers:[{digest:'sha256:'+sha256(weights),size:weights.length}]};
        const [name,tag]=model.split(':'),relative=`models/manifests/registry.ollama.ai/${name.includes('/')?name:'library/'+name}`;
        await mkdir(path.join(directory,relative),{recursive:true});const bytes=Buffer.from(JSON.stringify(manifest));
        await writeFile(path.join(directory,relative,tag),bytes);
        for(const blob of [config,weights])await writeFile(path.join(directory,'models/blobs/sha256-'+sha256(blob)),blob);
        return {schemaVersion:1,model,manifest,manifestSha256:sha256(bytes)};
    }
    const lock=await local('fixture:1','first-model'),nextLock=await local('team/custom:2','another-model');
    const descriptor={description:'Модель поставки',capability:'chat',runtime:'ollama',model:lock.model,manifestSha256:lock.manifestSha256,dimension:null,source:'builtin'};
    const registry={schemaVersion:1,models:[{id:'model-fixture',name:'Первая',descriptor,lock:'./locks/model-fixture.lock.json'}]};
    await writeFile(path.join(root,'scripts/models/model-registry.json'),json(registry));
    await writeFile(path.join(root,'scripts/models/locks/model-fixture.lock.json'),json(lock));
    await writeFile(path.join(root,'scripts/models/bundle-release.json'),'OLD SUPPLY\n');
    const recipe=path.join(root,'recipe.json');await writeFile(recipe,json({schemaVersion:1,id:'model-custom',name:'Вторая',
        descriptor:{...descriptor,model:nextLock.model,source:'custom',manifestSha256:null}}));
    await writeFile(path.join(directory,'id_ed25519'),'PRIVATE KEY');
    const options={root,directory,output,recipe,release};
    const registryPath=path.join(root,'scripts/models/model-registry.json'),manifestPath=path.join(root,'scripts/models/bundle-release.json');
    try {await action({root,directory,output,recipe,registry,registryPath,manifestPath,lock,nextLock,options,local});}
    finally {await rm(root,{recursive:true,force:true});}
}

test('Произвольная модель с namespace пакуется вместе с прежними, без изменения Git и чтения ключей',async()=>fixture(async f=>{
    const before=await readFile(f.registryPath),result=await prepareModelSupply(f.options,{readDisk:disk});
    assert.equal(result.published,false);assert.equal(result.models,2);
    assert.deepEqual(await readFile(f.registryPath),before);assert.equal(await readFile(f.manifestPath,'utf8'),'OLD SUPPLY\n');
    const manifest=JSON.parse(await readFile(path.join(f.output,'bundle-release.json'),'utf8'));
    validateModelBundle(manifest,[f.lock,f.nextLock]);
    assert.ok(manifest.files.some(file=>file.path==='models/manifests/registry.ollama.ai/team/custom/2'));
    assert.deepEqual(modelBundleSummary(manifest,[f.lock,f.nextLock]),{models:2,files:5,bytes:manifest.files.reduce((n,file)=>n+file.size,0)});
    assert.ok(!(await readdir(f.output)).includes('id_ed25519'));assert.ok(!JSON.stringify(manifest).includes('PRIVATE'));
}));

test('Обновление прежнего тега пересобирает SHA и сохраняет закреплённый runtime в старом lock',async()=>fixture(async f=>{
    const existingLock=path.join(f.root,'scripts/models/locks/model-fixture.lock.json');
    await writeFile(existingLock,json({...f.lock,image:'ollama/ollama@sha256:'+'a'.repeat(64)}));
    const updated=await f.local('fixture:1','updated-public-model');
    const previous=f.registry.models[0];
    await writeFile(f.recipe,json({schemaVersion:1,id:previous.id,name:previous.name,descriptor:{...previous.descriptor,source:'custom',manifestSha256:null}}));
    await prepareModelSupply(f.options,{readDisk:disk});
    const staged=JSON.parse(await readFile(path.join(f.output,'model.lock.json'),'utf8'));
    assert.equal(staged.manifestSha256,updated.manifestSha256);assert.equal(staged.image,'ollama/ollama@sha256:'+'a'.repeat(64));
    assert.equal(JSON.parse(await readFile(existingLock,'utf8')).manifestSha256,f.lock.manifestSha256);
}));

test('Третья модель входит в полный комплект без правок кода или счётчиков',async()=>fixture(async f=>{
    const calls=[],run=await releaseMock(f,calls);await prepareModelSupply({...f.options,publish:true},{readDisk:disk,run});
    await f.local('team/third:3','third-public-model');
    await writeFile(f.recipe,json({schemaVersion:1,id:'model-third',name:'Третья',descriptor:{...f.registry.models[0].descriptor,model:'team/third:3',source:'custom',manifestSha256:null}}));
    const result=await prepareModelSupply({...f.options,release:'models-fixture.3',output:path.join(f.root,'.run/third')},{readDisk:disk});
    assert.equal(result.models,3);assert.equal(result.files,7);
}));

test('Сбой upload сохраняет старую опись и реестр, новый lock не попадает в Git',async()=>fixture(async f=>{
    const before=await readFile(f.registryPath),calls=[];
    await assert.rejects(prepareModelSupply({...f.options,publish:true},{readDisk:disk,run:async args=>{
        calls.push(args);if(args[0]==='api')throw Object.assign(new Error('NOT FOUND'),{stderr:'Not Found (HTTP 404)'});
        if(args[1]==='upload')throw new Error('UPLOAD FAILED');return '';
    }}),/UPLOAD FAILED/);
    assert.deepEqual(await readFile(f.registryPath),before);assert.equal(await readFile(f.manifestPath,'utf8'),'OLD SUPPLY\n');
    await assert.rejects(readFile(path.join(f.root,'scripts/models/locks/model-custom.lock.json')),{code:'ENOENT'});
    assert.deepEqual(calls.filter(args=>args[0]==='release').map(args=>args.slice(0,2)),[['release','create'],['release','upload']]);
}));

async function releaseMock(f,calls,{badDigest=false,onPublished,existing=false,published=false,partial}={}) {
    let created=existing,draft=!published,reads=0;
    return async args=>{
        calls.push(args);
        if(args[1]==='create')created=true;
        if(args[0]==='api') {
            if(!created)throw Object.assign(new Error('NOT FOUND'),{stderr:'Not Found (HTTP 404)'});
            const names=(await readdir(f.output)).filter(name=>name==='bundle-release.json'||name.endsWith('.bin'));
            const assets=await Promise.all(names.map(async name=>{const bytes=await readFile(path.join(f.output,name));
                return {name,size:bytes.length,digest:'sha256:'+(badDigest?'0'.repeat(64):sha256(bytes))};}));
            return JSON.stringify({tag_name:release,draft,assets:partial!==undefined&&++reads===1?assets.slice(0,partial):assets});
        }
        if(args[1]==='edit') {draft=false;await onPublished?.();}
        return '';
    };
}

test('Реестр меняется только после проверки серверных SHA и публикации нового release',async()=>fixture(async f=>{
    const calls=[];let published=false;
    const run=await releaseMock(f,calls,{onPublished:async()=>{
        assert.equal(await readFile(f.manifestPath,'utf8'),'OLD SUPPLY\n');published=true;
    }});
    const result=await prepareModelSupply({...f.options,publish:true},{readDisk:disk,run});
    assert.equal(published,true);assert.equal(result.published,true);
    assert.ok(!calls.some(args=>args.includes('--clobber')));
    const locks=await modelLocks(f.registryPath);assert.equal(locks.length,2);
    assert.deepEqual(locks.map(item=>item.model),['fixture:1','team/custom:2']);
    const manifest=JSON.parse(await readFile(f.manifestPath,'utf8'));validateModelBundle(manifest,locks);
    assert.ok(calls.findIndex(args=>args[1]==='upload')<calls.findIndex(args=>args[1]==='edit'));
}));

test('Подмена SHA на GitHub не публикует draft и не обновляет файлы Git',async()=>fixture(async f=>{
    const calls=[],before=await readFile(f.registryPath),run=await releaseMock(f,calls,{badDigest:true});
    await assert.rejects(prepareModelSupply({...f.options,publish:true},{readDisk:disk,run}),/не подтвердил/);
    assert.deepEqual(await readFile(f.registryPath),before);assert.ok(!calls.some(args=>args[1]==='edit'));
}));

test('После локальной упаковки публикация повторно использует части и не требует места на новую копию',async()=>fixture(async f=>{
    await prepareModelSupply(f.options,{readDisk:disk});const calls=[],run=await releaseMock(f,calls);
    const result=await prepareModelSupply({...f.options,publish:true},{run,pack:()=>{throw new Error('REPACK');},readDisk:()=>{throw new Error('NEW SPACE');}});
    assert.equal(result.published,true);assert.equal((await modelLocks(f.registryPath)).length,2);
}));

test('Повреждённую готовую часть нельзя повторно использовать для публикации',async()=>fixture(async f=>{
    await prepareModelSupply(f.options,{readDisk:disk});const manifest=JSON.parse(await readFile(path.join(f.output,'bundle-release.json'),'utf8'));
    const part=manifest.files.flatMap(file=>file.parts||[])[0];await writeFile(path.join(f.output,part.name),'CORRUPT');
    let calls=0;await assert.rejects(prepareModelSupply({...f.options,publish:true},{readDisk:disk,run:async()=>{calls++;}}),/размер|SHA/);
    assert.equal(calls,0);
}));

test('Прерванный draft дополняется только недостающими частями без перезаписи проверенной',async()=>fixture(async f=>{
    await prepareModelSupply(f.options,{readDisk:disk});const calls=[],run=await releaseMock(f,calls,{existing:true,partial:1});
    await prepareModelSupply({...f.options,publish:true},{readDisk:disk,run});
    assert.ok(!calls.some(args=>args[1]==='create'||args.includes('--clobber')));
    const assets=(await readdir(f.output)).filter(name=>name==='bundle-release.json'||name.endsWith('.bin'));
    const uploaded=calls.filter(args=>args[1]==='upload').flatMap(args=>args.slice(5).map(filename=>path.basename(filename)));
    assert.equal(uploaded.length,assets.length-1);assert.ok(!uploaded.includes(assets[0]));
}));

test('Идентичный опубликованный release не загружается снова и завершает только локальные метаданные',async()=>fixture(async f=>{
    await prepareModelSupply(f.options,{readDisk:disk});const calls=[],run=await releaseMock(f,calls,{existing:true,published:true});
    const result=await prepareModelSupply({...f.options,publish:true},{readDisk:disk,run});
    assert.equal(result.published,true);assert.ok(calls.every(args=>args[0]==='api'));
}));

test('Изменение checkout во время публикации не затирается',async()=>fixture(async f=>{
    const calls=[],changed=Buffer.from('CONCURRENT CHANGE\n');
    const run=await releaseMock(f,calls,{onPublished:()=>writeFile(f.registryPath,changed)});
    await assert.rejects(prepareModelSupply({...f.options,publish:true},{readDisk:disk,run}),/Метаданные поставки изменились/);
    assert.deepEqual(await readFile(f.registryPath),changed);assert.equal(await readFile(f.manifestPath,'utf8'),'OLD SUPPLY\n');
}));

test('Повреждённые локальные веса останавливают упаковку до вызова gh',async()=>fixture(async f=>{
    const layer=f.nextLock.manifest.layers[0];await writeFile(path.join(f.directory,'models/blobs/'+layer.digest.replace(':','-')),'BAD');
    let calls=0;await assert.rejects(prepareModelSupply({...f.options,publish:true},{readDisk:disk,run:async()=>{calls++;}}),/размер|SHA/);
    assert.equal(calls,0);
}));

test('Явный SHA рецепта не позволяет опубликовать другой локальный тег',async()=>fixture(async f=>{
    const receipt=JSON.parse(await readFile(f.recipe));receipt.descriptor.manifestSha256='0'.repeat(64);await writeFile(f.recipe,json(receipt));
    let calls=0;await assert.rejects(prepareModelSupply({...f.options,publish:true},{readDisk:disk,run:async()=>{calls++;}}),/SHA рецепта/);
    assert.equal(calls,0);await assert.rejects(readFile(path.join(f.output,'bundle-release.json')),{code:'ENOENT'});
}));

test('Символическая ссылка локального манифеста не экспортируется',async()=>fixture(async f=>{
    const target=path.join(f.directory,'models/manifests/registry.ollama.ai/team/custom/2');await rm(target);await symlink(f.recipe,target);
    await assert.rejects(prepareModelSupply(f.options,{readDisk:disk}),/обычный файл/);
}));

test('Реестр требует уникальные ID и модели, замкнутые lock-пути и совпадение SHA карточки',async()=>fixture(async f=>{
    assert.equal((await registryModelLocks(f.registryPath)).length,1);
    for(const changes of [{lock:'../../secret.json'},{id:'../model'},{descriptor:{...f.registry.models[0].descriptor,model:'fixture:1\n'}}]) {
        assert.throws(()=>validateModelRegistry({...f.registry,models:[{...f.registry.models[0],...changes}]}));
    }
    assert.throws(()=>validateModelRegistry({...f.registry,models:[...f.registry.models,...f.registry.models]}),/Повторяющаяся/);
    f.registry.models[0].descriptor.manifestSha256='0'.repeat(64);await writeFile(f.registryPath,json(f.registry));
    await assert.rejects(registryModelLocks(f.registryPath),/отличается/);
}));

test('Рецепт и CLI отклоняют исполняемые команды, дубли параметров и неполную публикацию',async()=>{
    assert.throws(()=>modelSupplyRecipe({schemaVersion:1,id:'model-x',name:'Модель',descriptor:{source:'custom',model:'$(touch x)'}}));
    assert.throws(()=>parseModelPublishArguments(['--recipe','one','--release','models-1','--tag','models-2']),/повторно/);
    assert.throws(()=>parseModelPublishArguments(['--publish']),/--recipe/);
    assert.equal(parseModelPublishArguments(['--recipe','one.json','--release','models-1']).publish,false);
    const lines=[],original=console.log;console.log=value=>lines.push(value);
    try {await runModelPublishCli(['—help']);} finally {console.log=original;}
    assert.match(lines.join('\n'),/--publish/);
});
