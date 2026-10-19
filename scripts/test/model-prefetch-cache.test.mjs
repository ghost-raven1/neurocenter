import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile,writeFile,mkdir,readdir,symlink,copyFile,cp} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {assetFixture,ampleDisk,sha} from './assets-sync.fixture.mjs';
import {copyPrefetchedModels} from '../models/prefetch-cache.mjs';
import {hydrateModelBundle} from '../models/bundle.mjs';

async function fixture(t) {
    const f=await assetFixture(t),result=await f.run(),source=result.directories.models,directory=path.join(f.root,'production-volume');
    const copy=options=>copyPrefetchedModels({source,directory,manifest:f.bundle,locks:f.locks,readDisk:ampleDisk,...options});
    return {...f,source,directory,copy};
}

test('Предзагрузка переносит SHA-blobs в отдельный том без сети, тегов, ключей и квитанций',async t=>{
    const f=await fixture(t),privateFile=path.join(f.source,'id_ed25519');await writeFile(privateFile,'PRIVATE KEY');
    const progress=[],report=await f.copy({onProgress:value=>progress.push(value)}),blobs=f.bundle.files.filter(file=>file.parts);
    assert.equal(report.copied,blobs.length);assert.equal(report.bytes,blobs.reduce((sum,file)=>sum+file.size,0));
    for(const file of blobs) {
        assert.equal(sha(await readFile(path.join(f.directory,'.bundle-cache/blobs',file.sha256))),file.sha256);
        assert.equal(sha(await readFile(path.join(f.source,'.bundle-cache/blobs',file.sha256))),file.sha256);
    }
    for(const file of f.bundle.files.filter(file=>file.inlineBase64))await assert.rejects(access(path.join(f.directory,file.path)),{code:'ENOENT'});
    await assert.rejects(access(path.join(f.directory,'id_ed25519')),{code:'ENOENT'});assert.equal(await readFile(privateFile,'utf8'),'PRIVATE KEY');
    await assert.rejects(access(path.join(f.directory,'.bundle-receipt.json')),{code:'ENOENT'});
    assert.ok(progress.some(value=>value.stage==='verifying'));assert.equal(progress.filter(value=>value.stage==='copying').at(-1).completed,report.bytes);
    // Обычная активация использует скопированный кэш и не требует второй загрузки GitHub.
    await hydrateModelBundle({directory:f.directory,manifest:f.bundle,locks:f.locks,readDisk:ampleDisk,fetch:()=>assert.fail('Сеть не нужна после seed')});
    for(const file of f.bundle.files)assert.equal(sha(await readFile(path.join(f.directory,file.path))),file.sha256);
});

test('Повтор не переписывает кэш; активные SHA-blobs также подходят как источник',async t=>{
    const f=await fixture(t);await f.copy();assert.deepEqual(await f.copy(),{copied:0,bytes:0});
    const other=path.join(f.root,'another-volume');
    const report=await f.copy({source:path.join(f.root,'source'),directory:other});assert.equal(report.copied,2);
});

test('Отсутствующая предзагрузка допускает штатное скачивание и не создаёт лишних файлов',async t=>{
    const f=await fixture(t);assert.deepEqual(await f.copy({source:path.join(f.root,'absent')}),{copied:0,bytes:0});
    await assert.rejects(access(f.directory),{code:'ENOENT'});
});

test('Повреждённый известный blob не игнорируется и не изменяет источник или том',async t=>{
    const f=await fixture(t),file=f.bundle.files.find(item=>item.parts),filename=path.join(f.source,'.bundle-cache/blobs',file.sha256);
    await writeFile(filename,Buffer.alloc(file.size));await assert.rejects(f.copy(),/SHA существующего/);
    assert.deepEqual(await readFile(filename),Buffer.alloc(file.size));await assert.rejects(access(f.directory),{code:'ENOENT'});
});

test('Конфликтующий blob назначения не перезаписывается проверенной предзагрузкой',async t=>{
    const f=await fixture(t),file=f.bundle.files.find(item=>item.parts),filename=path.join(f.directory,'.bundle-cache/blobs',file.sha256);
    await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,Buffer.alloc(file.size));
    await assert.rejects(f.copy(),/SHA существующего/);assert.deepEqual(await readFile(filename),Buffer.alloc(file.size));
});

test('Копирование заранее проверяет свободное место отдельного тома',async t=>{
    const f=await fixture(t);await assert.rejects(f.copy({readDisk:async()=>({bavail:0n,bsize:1n})}),{code:'ENOSPC'});
    await assert.rejects(access(path.join(f.directory,'.bundle-cache')),{code:'ENOENT'});
});

test('Отмена локального копирования удаляет staging, сохраняя исходные SHA-blobs',async t=>{
    const f=await fixture(t),cancellation=new AbortController();
    await assert.rejects(f.copy({signal:cancellation.signal,onProgress:value=>{
        if(value.stage==='copying')cancellation.abort(new Error('Остановлено тестом'));
    }}),/Остановлено тестом/);
    assert.deepEqual(await readdir(path.join(f.directory,'.bundle-cache/blobs')),[]);
    assert.ok((await readdir(path.join(f.directory,'.bundle-cache'))).every(name=>!name.startsWith('prefetch-')));
    assert.equal((await f.copy()).copied,2);
});

test('Символическая ссылка источника отклоняется до записи тома',async t=>{
    const f=await fixture(t),source=path.join(f.root,'linked-prefetch');await symlink(f.source,source);
    await assert.rejects(f.copy({source}),/ссылк/);await assert.rejects(access(f.directory),{code:'ENOENT'});
});

test('Настоящий CLI использует предзагрузку offline и активирует комплект в отдельном томе без npm',async t=>{
    const f=await fixture(t),scripts=fileURLToPath(new URL('../models/',import.meta.url));
    for(const filename of await readdir(scripts))if(filename.endsWith('.mjs'))await copyFile(path.join(scripts,filename),path.join(f.root,'scripts/models',filename));
    await copyFile(fileURLToPath(new URL('../release-request.mjs',import.meta.url)),path.join(f.root,'scripts/release-request.mjs'));
    const preload=path.join(f.root,'deny-network.mjs');await writeFile(preload,'globalThis.fetch=()=>{throw new Error("Сетевой запрос запрещён проверкой")};');
    const entry=path.join(f.root,'scripts/models/bundle-cli.mjs');
    for(const downloadOnly of [true,false]) {
        const result=spawnSync(process.execPath,['--import',preload,entry,'--directory',f.directory,'--source-directory',f.source,...(downloadOnly?['--download-only']:[])],
            {encoding:'utf8',timeout:30000});
        assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.ok,true);assert.equal(report.downloadOnly,downloadOnly);
        for(const file of f.bundle.files.filter(file=>file.inlineBase64)) {
            if(downloadOnly)await assert.rejects(access(path.join(f.directory,file.path)),{code:'ENOENT'});
            else assert.equal(sha(await readFile(path.join(f.directory,file.path))),file.sha256);
        }
    }
});

test('Production COPY включает зависимости операторского CLI без npm и запуска контейнеров',async t=>{
    const f=await assetFixture(t),repository=fileURLToPath(new URL('../../',import.meta.url)),image=path.join(f.root,'image');
    const dockerfile=await readFile(path.join(repository,'services/catalog-service/Dockerfile'),'utf8');
    for(const [,source,destination] of dockerfile.matchAll(/^COPY (scripts\/\S+) (\/tools\/scripts\/\S+)$/gm)) {
        const target=path.join(image,destination);await mkdir(path.dirname(target),{recursive:true});
        await cp(path.join(repository,source),target,{recursive:true});
    }
    const result=spawnSync(process.execPath,[path.join(image,'tools/scripts/models/bundle-cli.mjs'),'--help'],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Использование/);
});
