import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {packModelBundle,hydrateModelBundle,readModelBundle} from '../models/bundle.mjs';
import {sha256,validateModelBundle} from '../models/bundle-manifest.mjs';
import {runModelBundleCli} from '../models/bundle-cli.mjs';

const baseUrl='https://github.com/ghost-raven1/neurocenter/releases/download/models-fixture.1';
const ampleDisk=async()=>({bavail:64n*1024n**3n,bsize:1n});

async function fixture(action,{expanded=false}={}) {
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc-model-bundle-'))),directory=path.join(root,'source'),output=path.join(root,'bundle'),destination=path.join(root,'target');
    const locks=[];await mkdir(path.join(directory,'models/blobs'),{recursive:true});
    const config=Buffer.from('{"public":true}'),configDigest=sha256(config);
    await writeFile(path.join(directory,'models/blobs/sha256-'+configDigest),config);
    for(const [name,text] of [['fixture-embedding','abcdefghijklmnopqrstuv'],['fixture-vision','UVWXYZ0123456789']]) {
        const weights=Buffer.from(text),digest=sha256(weights),item={digest:'sha256:'+digest,size:weights.length};
        await writeFile(path.join(directory,'models/blobs/sha256-'+digest),weights);
        const layers=[item];
        if(expanded&&name==='fixture-vision')for(let index=0;index<4;index++) {
            const extra=Buffer.from('additional-public-weight-'+index),digest=sha256(extra);
            await writeFile(path.join(directory,'models/blobs/sha256-'+digest),extra);layers.push({digest:'sha256:'+digest,size:extra.length});
        }
        const manifest={schemaVersion:2,config:{digest:'sha256:'+configDigest,size:config.length},layers};
        const bytes=Buffer.from(JSON.stringify(manifest));
        await mkdir(path.join(directory,'models/manifests/registry.ollama.ai/library',name),{recursive:true});
        await writeFile(path.join(directory,'models/manifests/registry.ollama.ai/library',name,'1'),bytes);
        locks.push({schemaVersion:1,model:name+':1',manifest,manifestSha256:sha256(bytes)});
    }
    await writeFile(path.join(directory,'id_ed25519'),'PRIVATE USER KEY');await writeFile(path.join(directory,'readiness.json'),'PRIVATE RECEIPT');
    const manifest=await packModelBundle({directory,output,baseUrl,locks,partBytes:8});
    const calls=[];
    const fetch=async(url,input)=>{
        calls.push(url);assert.equal(input.redirect,'manual');
        const filename=path.basename(new URL(url).pathname);const bytes=await readFile(path.join(output,filename));
        return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
    };
    const hydrate=options=>hydrateModelBundle({directory:destination,manifest,locks,fetch,readDisk:ampleDisk,...options});
    try {await action({root,directory,output,destination,locks,manifest,fetch,calls,hydrate});}
    finally {await rm(root,{recursive:true,force:true});}
}

test('Упаковка содержит все закреплённые веса и не читает ключи или квитанции',async()=>fixture(async({output,manifest,locks})=>{
    validateModelBundle(manifest,locks);
    assert.equal(manifest.files.length,5);assert.ok(manifest.files.filter(file=>file.parts).every(file=>file.parts.every(part=>part.size<=8)));
    assert.ok(!JSON.stringify(manifest).includes('PRIVATE'));
    const names=await readdir(output);assert.ok(names.every(name=>name==='bundle-release.json'||/^model-[a-f0-9]{64}-\d{3}\.bin$/.test(name)));
}));

test('Чистый импорт восстанавливает обе модели; повтор и verify не требуют сети',async()=>fixture(async({hydrate,calls,manifest,destination})=>{
    const report=await hydrate();assert.deepEqual(report,{ok:true,downloadOnly:false,verifyOnly:false,models:2,files:5,bytes:manifest.files.reduce((sum,file)=>sum+file.size,0)});
    const count=calls.length;await hydrate();await hydrate({verifyOnly:true});assert.equal(calls.length,count);
    for(const file of manifest.files)assert.equal(sha256(await readFile(path.join(destination,file.path))),file.sha256);
}));

test('Повторная SHA-проверка сообщает реальные байты и готовность без обращения к сети',async()=>fixture(async({hydrate,calls,root,manifest})=>{
    await hydrate();const count=calls.length;
    for(const options of [{},{verifyOnly:true}]) {
        const progress=[];await hydrate({...options,onProgress:value=>progress.push(value)});
        assert.equal(calls.length,count);
        assert.equal(progress[0].stage,'inspecting');
        const verified=progress.filter(value=>value.stage==='verifying');
        assert.equal(verified[0].completed,0);
        assert.equal(verified.at(-1).completed,manifest.files.reduce((sum,file)=>sum+file.size,0));
        assert.ok(verified.every((value,index)=>index===0||value.completed>=verified[index-1].completed));
        assert.equal(progress.at(-1).stage,'ready');
        assert.equal(progress.at(-1).completed,progress.at(-1).total);
        assert.ok(!JSON.stringify(progress).includes(root));
    }
}));

test('После обрыва прогресс учитывает проверенные части и достигает полного объёма',async()=>fixture(async({hydrate,fetch,manifest})=>{
    let requests=0;
    await assert.rejects(hydrate({fetch:async(...args)=>{if(++requests===2)throw new Error('INTERRUPTED');return fetch(...args);}}));
    const progress=[];let completedBeforeNetwork;
    await hydrate({onProgress:value=>progress.push(value),fetch:async(...args)=>{
        completedBeforeNetwork??=progress.filter(value=>value.stage==='downloading').at(-1)?.completed;
        return fetch(...args);
    }});
    assert.equal(completedBeforeNetwork,manifest.files.find(file=>file.parts).parts[0].size);
    const downloading=progress.filter(value=>value.stage==='downloading');
    const expected=manifest.files.filter(file=>file.parts).reduce((sum,file)=>sum+file.size,0);
    assert.equal(downloading.at(-1).completed,expected);assert.equal(downloading.at(-1).total,expected);
    assert.ok(downloading.every(value=>value.completed<=value.total));
    assert.ok(downloading.every((value,index)=>index===0||value.completed>=downloading[index-1].completed));
    for(const stage of ['inspecting','verifying','assembling','activating','ready'])assert.ok(progress.some(value=>value.stage===stage));
}));

test('Предварительный расчёт после обрыва не резервирует место повторно для проверенных частей',async()=>fixture(async({hydrate,fetch,manifest,calls})=>{
    let requests=0;
    await assert.rejects(hydrate({downloadOnly:true,fetch:async(...args)=>{
        if(++requests===2)throw new Error('INTERRUPTED');return fetch(...args);
    }}));
    const first=manifest.files.find(file=>file.parts).parts[0];
    const blobs=manifest.files.filter(file=>file.parts);
    const coldBudget=blobs.reduce((sum,file)=>sum+file.size,0)+Math.max(...blobs.map(file=>file.size))+1024**3;
    let diskChecks=0;
    // Проверяем предварительный расчёт после сохранения части; последующие потоковые проверки имеют запас.
    const report=await hydrate({downloadOnly:true,readDisk:async()=>++diskChecks===1
        ? {bavail:BigInt(coldBudget-first.size),bsize:1n}:ampleDisk()});
    assert.equal(report.ok,true);assert.ok(diskChecks>1);
    assert.equal(calls.filter(url=>url.endsWith('/'+first.name)).length,1);
}));

test('Предзагрузка не публикует теги, а импорт использует готовый кэш без повторного скачивания',async()=>fixture(async({hydrate,calls,destination,manifest})=>{
    await hydrate({downloadOnly:true});const count=calls.length;
    await assert.rejects(access(path.join(destination,manifest.files.find(file=>file.inlineBase64).path)));
    await hydrate();assert.equal(calls.length,count);
    assert.deepEqual(await readdir(path.join(destination,'.bundle-cache/blobs')),[]);
}));

test('Импорт сохраняет пользовательские ключи и другую модель',async()=>fixture(async({hydrate,destination})=>{
    await mkdir(path.join(destination,'models/blobs'),{recursive:true});
    await writeFile(path.join(destination,'id_ed25519'),'USER PRIVATE KEY');await writeFile(path.join(destination,'models/blobs/other-model'),'CUSTOM WEIGHTS');
    await hydrate();assert.equal(await readFile(path.join(destination,'id_ed25519'),'utf8'),'USER PRIVATE KEY');
    assert.equal(await readFile(path.join(destination,'models/blobs/other-model'),'utf8'),'CUSTOM WEIGHTS');
}));

test('Конфликтующий тег сохраняется и останавливает загрузку до обращения к сети',async()=>fixture(async({destination,manifest,hydrate,calls})=>{
    const tag=manifest.files.find(file=>file.inlineBase64);await mkdir(path.dirname(path.join(destination,tag.path)),{recursive:true});
    await writeFile(path.join(destination,tag.path),'CUSTOM TAG');
    await assert.rejects(hydrate(),/существующего файла/);assert.equal(calls.length,0);
    assert.equal(await readFile(path.join(destination,tag.path),'utf8'),'CUSTOM TAG');
}));

test('Повреждённый blob не заменяется и не скрывается исправной копией',async()=>fixture(async({destination,manifest,hydrate,calls})=>{
    const blob=manifest.files.find(file=>file.parts);await mkdir(path.dirname(path.join(destination,blob.path)),{recursive:true});
    await writeFile(path.join(destination,blob.path),Buffer.alloc(blob.size));
    await assert.rejects(hydrate(),/SHA существующего файла/);assert.equal(calls.length,0);
    assert.deepEqual(await readFile(path.join(destination,blob.path)),Buffer.alloc(blob.size));
}));

test('Оборванная загрузка сохраняет проверенные части и не активирует неполный комплект',async()=>fixture(async({hydrate,fetch,calls,destination,manifest})=>{
    let requests=0;const failed=[];
    await assert.rejects(hydrate({fetch:async(...args)=>{if(++requests===2)throw new Error('INTERRUPTED');failed.push(args[0]);return fetch(...args);}}));
    assert.ok((await readdir(path.join(destination,'.bundle-cache/parts'))).length>0);
    await assert.rejects(access(path.join(destination,manifest.files.find(file=>file.inlineBase64).path)));
    await hydrate();assert.equal(calls.filter(url=>url===failed[0]).length,1);
}));

test('Неверная SHA или размер ответа не попадает в canonical blobs',async()=>fixture(async({hydrate,destination,manifest})=>{
    const blob=manifest.files.find(file=>file.parts);
    await assert.rejects(hydrate({fetch:async()=>new Response('BROKEN')}),/SHA|размер/);
    await assert.rejects(access(path.join(destination,blob.path)));
    await assert.rejects(access(path.join(destination,manifest.files.find(file=>file.inlineBase64).path)));
}));

test('Ссылки хранилища и готового файла не позволяют писать за пределы проекта',async()=>fixture(async({root,destination,manifest,hydrate})=>{
    const outside=path.join(root,'outside');await mkdir(outside);await mkdir(destination);await symlink(outside,path.join(destination,'models'));
    await assert.rejects(hydrate(),/символической ссылкой/);assert.deepEqual(await readdir(outside),[]);
    await rm(path.join(destination,'models'));await mkdir(path.join(destination,'models/blobs'),{recursive:true});
    const blob=manifest.files.find(file=>file.parts),outsideFile=path.join(outside,'weight');await writeFile(outsideFile,'UNCHANGED');
    await symlink(outsideFile,path.join(destination,blob.path));await assert.rejects(hydrate(),/существующего файла/);
    assert.equal(await readFile(outsideFile,'utf8'),'UNCHANGED');
}));

test('Ссылка в предках отсутствующего корня не позволяет создать каталог за пределами хранилища',async()=>fixture(async({root,hydrate,calls})=>{
    const outside=path.join(root,'outside');await mkdir(outside);
    const alias=path.join(root,'alias');await symlink(outside,alias);
    await assert.rejects(hydrate({directory:path.join(alias,'missing','models')}),/символической ссылкой/);
    assert.deepEqual(await readdir(outside),[]);assert.equal(calls.length,0);
}));

test('Ссылка в предках существующего корня также отклоняется до чтения и загрузки',async()=>fixture(async({root,hydrate,calls})=>{
    const outside=path.join(root,'outside');await mkdir(path.join(outside,'existing'),{recursive:true});
    const alias=path.join(root,'alias');await symlink(outside,alias);
    await assert.rejects(hydrate({directory:path.join(alias,'existing')}),/символической ссылкой/);
    assert.deepEqual(await readdir(path.join(outside,'existing')),[]);assert.equal(calls.length,0);
}));

test('Упаковка не читает источник через символическую ссылку в предках',async()=>fixture(async({root,directory,locks})=>{
    const alias=path.join(root,'alias');await symlink(root,alias);
    const output=path.join(root,'rejected-source-pack');
    await assert.rejects(packModelBundle({directory:path.join(alias,path.basename(directory)),output,baseUrl,locks}),/символической ссылкой/);
    await assert.rejects(access(output));
}));

test('Упаковка не создаёт вывод через символическую ссылку в предках',async()=>fixture(async({root,directory,locks})=>{
    const outside=path.join(root,'outside');await mkdir(path.join(outside,'existing'),{recursive:true});
    const alias=path.join(root,'alias');await symlink(outside,alias);
    await assert.rejects(packModelBundle({directory,output:path.join(alias,'existing','new-output'),baseUrl,locks}),/символической ссылкой/);
    assert.deepEqual(await readdir(path.join(outside,'existing')),[]);
}));

test('Опись не читается через символическую ссылку в родительском пути',async()=>fixture(async({root,output})=>{
    const alias=path.join(root,'alias');await symlink(root,alias);
    await assert.rejects(readModelBundle(path.join(alias,path.basename(output),'bundle-release.json')),/символической ссылкой/);
}));

test('Опись не принимает обход путей, подменённую SHA, лишний файл или внешний release',async()=>fixture(async({manifest,locks})=>{
    const edits=[value=>{value.files[0].path='../private';},value=>{value.files[0].sha256='a'.repeat(64);},
        value=>{value.files.push({...value.files[0],path:'id_ed25519'});},value=>{value.releaseBaseUrl='https://evil.invalid/release';},
        value=>{value.files.find(file=>file.parts).parts[0].name='../evil';},value=>{value.files.find(file=>file.inlineBase64).inlineBase64='Zm9v';}];
    for(const edit of edits) {const candidate=structuredClone(manifest);edit(candidate);assert.throws(()=>validateModelBundle(candidate,locks));}
}));

test('Недостаток физического места содержит безопасные объёмы и отклоняется до первой загрузки',async()=>fixture(async({hydrate,calls,manifest,root})=>{
    const blobs=manifest.files.filter(file=>file.parts),tags=manifest.files.filter(file=>file.inlineBase64);
    const required=blobs.reduce((sum,file)=>sum+file.size,0)+Math.max(...blobs.map(file=>file.size))
        +tags.reduce((sum,file)=>sum+file.size,0)+1024**3;
    await assert.rejects(hydrate({readDisk:async()=>({bavail:2n,bsize:4096n})}),error=>{
        assert.equal(error.code,'ENOSPC');assert.equal(error.requiredBytes,required);assert.equal(error.availableBytes,8192);
        assert.match(error.message,/Недостаточно места/);assert.match(error.message,/резервом 1 ГиБ/);
        assert.ok(!error.message.includes(root));return true;
    });assert.equal(calls.length,0);
}));

test('Перенаправление на внешний или локальный сервер отклоняется до второго запроса',async()=>fixture(async({hydrate})=>{
    for(const location of ['http://127.0.0.1/private','https://evil.invalid/model']) {
        let calls=0;
        await assert.rejects(hydrate({fetch:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}}),/пределы GitHub/);
        assert.equal(calls,1);
    }
}));

test('Упаковка не использует существующий каталог вывода и сохраняет его файлы',async()=>fixture(async({directory,output,locks})=>{
    const before=await readdir(output);await assert.rejects(packModelBundle({directory,output,baseUrl,locks}));assert.deepEqual(await readdir(output),before);
}));

test('Некорректные аргументы CLI отклоняются до чтения данных или загрузки',async()=>{
    for(const args of [['--unknown'],['--pack'],['--download-only','--verify-only'],['--directory'],['--download-only','--download-only']])await assert.rejects(runModelBundleCli(args));
});

test('Два импорта переживают очистку общего кэша и завершаются с девятью правильными файлами',{timeout:10000},async()=>fixture(async({hydrate,fetch,destination,manifest})=>{
    assert.equal(manifest.files.length,9);
    assert.ok(manifest.files.find(file=>file.parts).parts.length>1);
    await mkdir(destination);await writeFile(path.join(destination,'user-key'),'UNRELATED PRIVATE KEY');
    const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
    const started=deferred(),secondFetch=deferred(),firstFinished=deferred();let firstRequests=0,secondRequests=0;
    const first=hydrate({fetch:async(...args)=>{
        if(++firstRequests===1) {started.resolve();await secondFetch.promise;}
        return fetch(...args);
    }}).finally(()=>{firstFinished.resolve();});
    await started.promise;
    const second=hydrate({fetch:async(...args)=>{
        if(++secondRequests===2) {secondFetch.resolve();await firstFinished.promise;}
        return fetch(...args);
    }});
    const reports=await Promise.all([first,second]);assert.ok(reports.every(report=>report.ok&&report.files===9));
    // Первая проверенная часть уже удалена первым импортом; повтор не скачивает следующие blob-файлы.
    assert.equal(secondRequests,manifest.files.find(file=>file.parts).parts.length);
    for(const file of manifest.files)assert.equal(sha256(await readFile(path.join(destination,file.path))),file.sha256);
    assert.equal(await readFile(path.join(destination,'user-key'),'utf8'),'UNRELATED PRIVATE KEY');
    assert.ok((await readdir(path.join(destination,'.bundle-cache'))).every(name=>!name.startsWith('stage-')));
},{expanded:true}));

test('HTTP 404 и пользовательские ошибки загрузки не запускают повтор импорта',async()=>fixture(async({hydrate})=>{
    for(const failure of [()=>new Response(null,{status:404}),()=>{throw new Error('CUSTOM FAILURE');},
        ()=>{throw Object.assign(new Error('CUSTOM ENOENT'),{code:'ENOENT'});},
        ()=>{throw Object.assign(new Error('EXTERNAL FILE ENOENT'),{code:'ENOENT',syscall:'open',path:'/external/source'});}]) {
        let count=0;
        await assert.rejects(hydrate({fetch:async()=>{count++;return failure();}}));assert.equal(count,1);
    }
}));
