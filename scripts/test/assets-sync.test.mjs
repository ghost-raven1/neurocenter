import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,readdir,symlink,chmod} from 'node:fs/promises';
import path from 'node:path';
import {serializeAsset,assetDigest,downloadArtifacts} from '@neurocenter/asset-contract';
import {assetFixture,sha,clone} from './assets-sync.fixture.mjs';
import {assetDirectories} from '../assets/sync.mjs';
const binaryCalls=f=>f.calls.filter(url=>url.includes('/releases/download/'));

test('Все kinds нового source contract попадают только в общий SHA-кэш, без карточек и tags',async t=>{
    const f=await assetFixture(t),report=await f.run();assert.equal(report.ok,true);assert.equal(report.mode,'prefetch');assert.equal(report.downloaded,3);
    assert.deepEqual(new Set(report.assets.map(item=>item.kind)),new Set(['plugin','bridge','skill','model']));
    assert.equal(binaryCalls(f).length,3);assert.equal(JSON.parse(await readFile(f.receipt)).schemaVersion,2);
    await assert.rejects(lstat(path.join(f.root,'data/embedding')),{code:'ENOENT'});
    await assert.rejects(lstat(path.join(f.root,'bridge-dist')),{code:'ENOENT'});
    assert.equal((await readdir(path.join(f.root,'data/runtime-artifacts'))).some(name=>!name.startsWith('.asset-source-')),false);
});
test('metadata-only читает index и descriptors; гигабайтные payload не запрашивает',async t=>{
    const f=await assetFixture(t),report=await f.run({metadataOnly:true});assert.equal(report.mode,'metadata');assert.equal(report.downloaded,0);assert.equal(binaryCalls(f).length,0);
    await assert.rejects(lstat(path.join(f.root,'data/runtime-artifacts/.asset-source-blobs')),{code:'ENOENT'});
});
test('standard исключает модели; явный выбор skill не скачивает соседние tools',async t=>{
    const f=await assetFixture(t);const report=await f.run({withoutModels:true});assert.equal(report.withoutModels,true);assert.equal(report.assets.some(item=>item.kind==='model'),false);assert.equal(report.downloaded,2);
    const g=await assetFixture(t);assert.equal((await g.run({ids:['fixture-skill']})).downloaded,0);assert.equal(binaryCalls(g).length,0);
    await assert.rejects(g.run({ids:['model-fixture'],withoutModels:true}),/--without-models/);
});
test('Точная историческая зависимость не заменяется current и не добавляет незапрошенный current',async t=>{
    const f=await assetFixture(t),old=structuredClone(f.tool),next=structuredClone(old);next.version='2.0.0';next.card.revision='2.0.0';
    next.delivery.artifacts[0].descriptor.sha256=sha('new runtime');next.delivery.artifacts[0].descriptor.compressedBytes=Buffer.byteLength('new runtime');
    next.delivery.artifacts[0].url='https://github.com/example/assets/releases/download/v2.0.0/new.tar.gz';f.payloads.set(next.delivery.artifacts[0].url,Buffer.from('new runtime'));
    f.skill.dependencies=[{id:old.id,version:old.version,sha256:assetDigest(serializeAsset(old))}];await f.publish([{asset:old,current:false},next,f.skill]);
    const report=await f.run({ids:['fixture-skill']});assert.deepEqual(report.assets.map(item=>item.id+'@'+item.version),['fixture-tool@1.0.0','fixture-skill@1.0.0']);assert.equal(f.calls.includes(next.delivery.artifacts[0].url),false);
});
test('Повтор и offline verify используют exact SHA cache и ничего не запрашивают',async t=>{
    const f=await assetFixture(t);await f.run();f.calls.length=0;
    assert.equal((await f.run()).downloaded,0);assert.equal(f.calls.length,0);
    const before=await readFile(f.receipt);await f.run({verifyOnly:true,fetch:async()=>{throw new Error('network forbidden');}});assert.deepEqual(await readFile(f.receipt),before);
});

test('Content-only source uses verified cached bytes without a network transport',async t=>{
    const f=await assetFixture(t);await f.run({ids:[f.tool.id]});
    const local=clone(f.tool);local.source={type:'archive',sha256:sha('local source archive'),bytes:20};
    delete local.delivery.artifacts[0].url;await f.publish([local]);f.calls.length=0;
    const report=await f.run({ids:[local.id]});assert.equal(report.downloaded,0);assert.deepEqual(binaryCalls(f),[]);
    f.calls.length=0;await f.run({ids:[local.id],verifyOnly:true});assert.deepEqual(f.calls,[]);
});

test('Missing content-only bytes fail before unrelated binary downloads and receipt creation',async t=>{
    const f=await assetFixture(t),local=clone(f.tool);local.source={type:'archive',sha256:sha('local source archive'),bytes:20};
    delete local.delivery.artifacts[0].url;await f.publish([local,f.bridge]);
    await assert.rejects(f.run(),/Локальные файлы выбранного ассета отсутствуют/);
    assert.deepEqual(binaryCalls(f),[]);await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
    await assert.rejects(lstat(path.join(f.root,'data/runtime-artifacts/.asset-source-blobs')),{code:'ENOENT'});
});

test('A content-only neighbour cannot hide the declared transport for the same SHA',async t=>{
    const f=await assetFixture(t),local=clone(f.tool);local.id='fixture-content-tool';local.card.name='Content tool';
    local.source={type:'archive',sha256:sha('local source archive'),bytes:20};delete local.delivery.artifacts[0].url;
    await f.publish([f.tool,local]);const report=await f.run({ids:[f.tool.id,local.id]});
    assert.equal(report.files,1);assert.equal(report.downloaded,1);assert.equal(binaryCalls(f).length,1);
});
test('Verify-only на чистом checkout не пишет metadata, receipt или lock',async t=>{
    const f=await assetFixture(t);await assert.rejects(f.run({verifyOnly:true}),/опись.*кэше/);assert.equal(f.calls.length,0);
    await assert.rejects(lstat(path.join(f.root,'.run')),{code:'ENOENT'});await assert.rejects(lstat(path.join(f.root,'data')),{code:'ENOENT'});
});
for(const mode of ['hash','truncated','HTTP500','redirect'])test('Неуспешный binary fetch не оставляет stage и готовность: '+mode,async t=>{
    const f=await assetFixture(t),url=f.tool.delivery.artifacts[0].url;
    const fetch=async(address,options)=>{
        if(String(address)!==url)return f.fetch(address,options);
        if(mode==='HTTP500')return new Response('private',{status:500});
        if(mode==='redirect')return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
        const bytes=f.payloads.get(url);return new Response(mode==='hash'?Buffer.alloc(bytes.length):bytes.subarray(1));
    };
    await assert.rejects(f.run({fetch}));await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
    assert.deepEqual(await readdir(path.join(f.root,'data/runtime-artifacts/.asset-source-blobs')),[]);
});
test('Повреждённый существующий blob не удаляется, не заменяется и не считается cache hit',async t=>{
    const f=await assetFixture(t);await f.run();const artifact=downloadArtifacts(f.tool)[0],file=f.blob(artifact.sha256);
    await chmod(file,0o600);await writeFile(file,Buffer.alloc(artifact.bytes));f.calls.length=0;
    await assert.rejects(f.run(),/SHA/);assert.deepEqual(await readFile(file),Buffer.alloc(artifact.bytes));assert.equal(binaryCalls(f).length,0);
});
test('Symlink вместо SHA файла и каталога отклоняется без чтения чужих bytes',async t=>{
    for(const kind of ['file','directory']){
        const f=await assetFixture(t),artifact=downloadArtifacts(f.tool)[0],directory=path.dirname(f.blob(artifact.sha256));await mkdir(path.dirname(directory),{recursive:true});
        const target=path.join(f.root,'foreign');await mkdir(target);
        if(kind==='directory')await symlink(target,directory);else{await mkdir(directory);await symlink(path.join(target,'secret'),f.blob(artifact.sha256));}
        await assert.rejects(f.run());assert.deepEqual(await readdir(target),[]);assert.equal(binaryCalls(f).length,0);
    }
});
test('Недостаток диска останавливает до binary network и не оставляет готовность',async t=>{
    const f=await assetFixture(t);await assert.rejects(f.run({readDisk:async()=>({bavail:1n,bsize:1n})}),{code:'ENOSPC'});assert.equal(binaryCalls(f).length,0);
    await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});
test('Отмена до подготовки и в середине потока сохраняет проверенные bytes и очищает свой stage',async t=>{
    const f=await assetFixture(t),before=new AbortController();before.abort();await assert.rejects(f.run({signal:before.signal}));assert.equal(f.calls.length,0);
    const abort=new AbortController(),url=f.tool.delivery.artifacts[0].url;
    await assert.rejects(f.run({signal:abort.signal,fetch:async(address,options)=>{
        if(String(address)!==url)return f.fetch(address,options);
        return new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from('partial'));abort.abort();controller.close();}}));
    }}));assert.deepEqual(await readdir(path.join(f.root,'data/runtime-artifacts/.asset-source-blobs')),[]);
});
test('Изменение lock во время загрузки не получает старую квитанцию',async t=>{
    const f=await assetFixture(t);let changed=false;
    await assert.rejects(f.run({fetch:async(url,options)=>{
        if(!changed&&String(url).includes('/releases/download/')){changed=true;await f.json('services/shared/asset-source.lock.json',{...f.pin,commit:'b'.repeat(40)});}
        return f.fetch(url,options);
    }}),/Источник изменился/);await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});
test('Две подготовки сериализованы; второй процесс использует проверенный результат первой',async t=>{
    const f=await assetFixture(t),reports=await Promise.all([f.run(),f.run()]);assert.equal(binaryCalls(f).length,3);assert.deepEqual(reports.map(item=>item.downloaded).sort(),[0,3]);
    assert.equal((await readdir(path.join(f.root,'.run'))).some(name=>name.startsWith('assets-sync.lock')),false);
});
test('Кэш берётся из единого RUNTIME_ARTIFACT_DIR, отдельного каталога весов у prefetch нет',()=>{
    assert.deepEqual(assetDirectories({root:'/checkout',environment:{RUNTIME_ARTIFACT_DIR:'runtime'}}),{catalog:'/checkout/runtime',blobs:'/checkout/runtime/.asset-source-blobs',metadata:'/checkout/runtime/.asset-source-metadata'});
});
