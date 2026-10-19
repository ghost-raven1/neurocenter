import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,chmod,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {packModelBundle,hydrateModelBundle} from '../models/bundle.mjs';
import {sha256} from '../models/bundle-manifest.mjs';
import {preflightModelTargets} from '../models/bundle-preflight.mjs';

const permissionTest=process.platform==='win32'||process.getuid?.()===0
    ? {skip:'Проверка ограничений POSIX требует пользователя без прав root.'}:{};

/** Синтетические веса занимают несколько байт; сеть заменена чтением из отдельного временного каталога. */
async function fixture(t) {
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc-model-preflight-')));
    const source=path.join(root,'source'),output=path.join(root,'bundle'),directory=path.join(root,'target');
    const restricted=[];
    t.after(async()=>{
        for(const filename of restricted)await chmod(filename,0o700).catch(()=>{});
        await rm(root,{recursive:true,force:true});
    });
    await mkdir(path.join(source,'models/blobs'),{recursive:true});
    const config=Buffer.from('{}'),weights=Buffer.from('SYNTHETIC WEIGHTS');
    for(const bytes of [config,weights])await writeFile(path.join(source,'models/blobs/sha256-'+sha256(bytes)),bytes);
    const model={schemaVersion:2,config:{digest:'sha256:'+sha256(config),size:config.length},layers:[{digest:'sha256:'+sha256(weights),size:weights.length}]};
    const tag=Buffer.from(JSON.stringify(model)),tagParent='models/manifests/registry.ollama.ai/library/fixture';
    await mkdir(path.join(source,tagParent),{recursive:true});await writeFile(path.join(source,tagParent,'1'),tag);
    const locks=[{model:'fixture:1',manifest:model,manifestSha256:sha256(tag)}];
    const manifest=await packModelBundle({directory:source,output,baseUrl:'https://github.com/ghost-raven1/neurocenter/releases/download/models-fixture.1',locks,partBytes:8});
    let requests=0;
    const hydrate=options=>hydrateModelBundle({directory,manifest,locks,readDisk:async()=>({bavail:64n*1024n**3n,bsize:1n}),fetch:async url=>{
        requests++;const bytes=await readFile(path.join(output,path.basename(new URL(url).pathname)));return new Response(bytes);
    },...options});
    const restrict=async relative=>{
        const filename=path.join(directory,relative);await mkdir(filename,{recursive:true});await chmod(filename,0o500);restricted.push(filename);return filename;
    };
    return {root,directory,tagParent,manifest,hydrate,restrict,requests:()=>requests};
}

test('Недоступный для записи каталог весов отклоняется до загрузки и допускает повтор после исправления прав',permissionTest,async t=>{
    const f=await fixture(t),restricted=await f.restrict('models/blobs');
    await writeFile(path.join(f.directory,'user-key'),'UNRELATED USER KEY');
    await assert.rejects(f.hydrate(),error=>error.code==='EACCES'||error.code==='EPERM');
    assert.equal(f.requests(),0);assert.deepEqual(await readdir(restricted),[]);
    assert.equal(await readFile(path.join(f.directory,'user-key'),'utf8'),'UNRELATED USER KEY');
    await chmod(restricted,0o700);assert.equal((await f.hydrate()).ok,true);
    for(const file of f.manifest.files)assert.equal(sha256(await readFile(path.join(f.directory,file.path))),file.sha256);
    assert.ok((await readdir(restricted)).every(name=>!name.startsWith('.neurocenter-write-')));
});

test('Недоступный для записи каталог существующего тега отклоняется до загрузки',permissionTest,async t=>{
    const f=await fixture(t),restricted=await f.restrict(f.tagParent);
    await assert.rejects(f.hydrate(),error=>error.code==='EACCES'||error.code==='EPERM');
    assert.equal(f.requests(),0);assert.deepEqual(await readdir(restricted),[]);
    assert.deepEqual(await readdir(path.join(f.directory,'models/blobs')),[]);
});

test('Отсутствующий каталог тега не скачивает веса, если его родитель закрыт для записи',permissionTest,async t=>{
    const f=await fixture(t);await f.restrict(path.posix.dirname(f.tagParent));
    await assert.rejects(f.hydrate(),error=>error.code==='EACCES'||error.code==='EPERM');assert.equal(f.requests(),0);
});

test('Предзагрузка не требует записи в каталоги активации моделей',permissionTest,async t=>{
    const f=await fixture(t);await f.restrict('models/blobs');await f.restrict(f.tagParent);
    const result=await f.hydrate({downloadOnly:true});assert.equal(result.ok,true);assert.equal(result.downloadOnly,true);
    assert.ok(f.requests()>0);assert.deepEqual(await readdir(path.join(f.directory,'models/blobs')),[]);
    assert.deepEqual(await readdir(path.join(f.directory,f.tagParent)),[]);
});

test('Готовый комплект и проверка SHA не требуют записи в каталоги моделей',permissionTest,async t=>{
    const f=await fixture(t);await f.hydrate();const requests=f.requests();
    await f.restrict('models/blobs');await f.restrict(f.tagParent);
    assert.equal((await f.hydrate()).ok,true);assert.equal((await f.hydrate({verifyOnly:true})).ok,true);
    assert.equal(f.requests(),requests);
});

for(const relative of ['.bundle-cache/parts','.bundle-cache/blobs'])test(`Закрытый для записи ${relative} отклоняется до загрузки и допускает повтор после исправления прав`,permissionTest,async t=>{
    const f=await fixture(t);await mkdir(path.join(f.directory,relative),{recursive:true});
    await writeFile(path.join(f.directory,relative,'user-file'),'UNRELATED CACHE FILE');
    const restricted=await f.restrict(relative);
    await assert.rejects(f.hydrate(),error=>error.code==='EACCES'||error.code==='EPERM');
    assert.equal(f.requests(),0);assert.deepEqual(await readdir(restricted),['user-file']);
    await chmod(restricted,0o700);assert.equal((await f.hydrate()).ok,true);
    assert.equal(await readFile(path.join(restricted,'user-file'),'utf8'),'UNRELATED CACHE FILE');
    assert.ok((await readdir(restricted)).every(name=>!name.startsWith('.neurocenter-write-')));
});

test('Закрытый родитель staging отклоняется до первого сетевого запроса',permissionTest,async t=>{
    const f=await fixture(t);
    for(const relative of ['.bundle-cache/parts','.bundle-cache/blobs'])await mkdir(path.join(f.directory,relative),{recursive:true});
    const restricted=await f.restrict('.bundle-cache');
    await assert.rejects(f.hydrate(),error=>error.code==='EACCES'||error.code==='EPERM');assert.equal(f.requests(),0);
    assert.deepEqual((await readdir(restricted)).sort(),['blobs','parts']);
    await chmod(restricted,0o700);assert.equal((await f.hydrate()).ok,true);
});

test('Повторная предзагрузка готового кэша не требует записи в кэш и не создаёт staging',permissionTest,async t=>{
    const f=await fixture(t);await f.hydrate({downloadOnly:true});const requests=f.requests();
    for(const relative of ['.bundle-cache/parts','.bundle-cache/blobs','.bundle-cache'])await f.restrict(relative);
    const before=await readdir(path.join(f.directory,'.bundle-cache'));
    assert.equal((await f.hydrate({downloadOnly:true})).ok,true);assert.equal(f.requests(),requests);
    assert.deepEqual(await readdir(path.join(f.directory,'.bundle-cache')),before);
});

test('Активация готового кэша не требует записи в ненужный каталог частей',permissionTest,async t=>{
    const f=await fixture(t);await f.hydrate({downloadOnly:true});const requests=f.requests();
    const restricted=await f.restrict('.bundle-cache/parts');
    assert.equal((await f.hydrate()).ok,true);assert.equal(f.requests(),requests);
    assert.deepEqual(await readdir(restricted),[]);
});

test('Активация без новых тегов не требует создания staging в закрытом родителе',permissionTest,async t=>{
    const f=await fixture(t);await f.hydrate({downloadOnly:true});const requests=f.requests();
    for(const file of f.manifest.files.filter(file=>file.inlineBase64)) {
        await mkdir(path.dirname(path.join(f.directory,file.path)),{recursive:true});
        await writeFile(path.join(f.directory,file.path),Buffer.from(file.inlineBase64,'base64'));
    }
    const restricted=await f.restrict('.bundle-cache');
    assert.equal((await f.hydrate()).ok,true);assert.equal(f.requests(),requests);
    assert.deepEqual((await readdir(restricted)).sort(),['blobs','parts']);
});

test('Активация готового кэша проверяет право удаления источника до публикации файлов',permissionTest,async t=>{
    const f=await fixture(t);await f.hydrate({downloadOnly:true});const requests=f.requests();
    const restricted=await f.restrict('.bundle-cache/blobs'),before=await readdir(restricted);
    await assert.rejects(f.hydrate(),error=>error.code==='EACCES'||error.code==='EPERM');assert.equal(f.requests(),requests);
    assert.deepEqual(await readdir(restricted),before);assert.deepEqual(await readdir(path.join(f.directory,'models/blobs')),[]);
});

test('Проверка записи не следует символической ссылке и не создаёт файлы снаружи',async t=>{
    const f=await fixture(t),outside=path.join(f.root,'outside');
    await mkdir(outside);await mkdir(f.directory);await symlink(outside,path.join(f.directory,'models'));
    await assert.rejects(preflightModelTargets(f.directory,f.manifest.files),/символической ссылкой/);
    assert.deepEqual(await readdir(outside),[]);assert.equal(f.requests(),0);
});

test('Параллельные проверки используют разные пробы и сохраняют существующие файлы',async t=>{
    const f=await fixture(t);await mkdir(path.join(f.directory,'models/blobs'),{recursive:true});
    await writeFile(path.join(f.directory,'models/blobs','user-model'),'UNRELATED WEIGHTS');
    await Promise.all([preflightModelTargets(f.directory,f.manifest.files),preflightModelTargets(f.directory,f.manifest.files)]);
    assert.deepEqual(await readdir(path.join(f.directory,'models/blobs')),['user-model']);
    assert.equal(await readFile(path.join(f.directory,'models/blobs','user-model'),'utf8'),'UNRELATED WEIGHTS');
    assert.deepEqual(await readdir(path.join(f.directory,f.tagParent)),[]);
});
