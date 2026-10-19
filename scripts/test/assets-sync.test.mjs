import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile,writeFile,lstat,readdir,mkdir,symlink,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {assetFixture,clone} from './assets-sync.fixture.mjs';
import {readAssetSupply,assetDirectories} from '../assets/sync.mjs';
import {parseAssetsArguments} from '../assets/cli.mjs';
import {withAssetsLock} from '../assets/lock.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Полная поставка готовится без npm и БД; предзагрузка не активирует теги моделей',async t=>{
    const f=await assetFixture(t),progress=[],result=await f.run({onProgress:value=>progress.push(value)});
    assert.equal(result.ok,true);assert.equal(result.mode,'prefetch');assert.equal(result.models.models,2);
    const receipt=JSON.parse(await readFile(f.receipt));assert.equal(receipt.revision,result.revision);
    assert.equal(receipt.verifyOnly,false);assert.equal(receipt.schemaVersion,1);
    assert.ok(progress.some(item=>item.section==='bridge'&&item.stage==='downloading'));
    assert.ok(progress.some(item=>item.section==='catalog'&&item.stage==='downloading'));
    assert.ok(progress.some(item=>item.section==='models'&&item.stage==='downloading'));
    assert.equal(progress.at(-1).stage,'ready');
    for(const file of f.bundle.files.filter(item=>item.inlineBase64))await assert.rejects(access(path.join(result.directories.models,file.path)),{code:'ENOENT'});
});

test('Повтор и verify выполняют SHA без сети; verify не меняет квитанцию и список файлов',async t=>{
    const f=await assetFixture(t);await f.run();const count=f.calls.length;
    await f.run();assert.equal(f.calls.length,count);
    const before=await readFile(f.receipt),stat=await lstat(f.receipt),files=await readdir(path.join(f.root,'.run'));
    const verified=await f.run({verifyOnly:true,fetch:()=>assert.fail('Сеть в verify запрещена')});
    assert.equal(verified.verifyOnly,true);assert.deepEqual(await readFile(f.receipt),before);assert.equal((await lstat(f.receipt)).mtimeMs,stat.mtimeMs);
    assert.deepEqual(await readdir(path.join(f.root,'.run')),files);
});

test('После аварии активации offline recovery снимает блокировку предзагрузки всей поставки',async t=>{
    const f=await assetFixture(t),prepared=await f.run(),directory=prepared.directories.models,before=await readFile(f.receipt);
    for(const file of f.bundle.files.filter(item=>item.parts)) {
        await mkdir(path.dirname(path.join(directory,file.path)),{recursive:true});
        await copyFile(path.join(directory,'.bundle-cache/blobs',file.sha256),path.join(directory,file.path));
    }
    const module=fileURLToPath(new URL('../models/bundle-managed.mjs',import.meta.url)),tags=f.bundle.files.filter(item=>item.inlineBase64);
    const crashed=spawnSync(process.execPath,['--input-type=module','-e',`
        const {activateManagedModelBundle}=await import(process.argv[1]);
        await activateManagedModelBundle(process.argv[2],JSON.parse(process.argv[3]),{onBytes:()=>process.exit(83)});
    `,module,directory,JSON.stringify(tags)],{encoding:'utf8',timeout:5000});
    assert.equal(crashed.status,83,crashed.stderr);const requests=f.calls.length;
    await assert.rejects(f.run(),{code:'MODEL_RECOVERY_REQUIRED'});assert.deepEqual(await readFile(f.receipt),before);
    // Verify подтверждает только prefetch SHA-blobs; оно не устраняет незавершённую активацию.
    assert.equal((await f.run({verifyOnly:true})).mode,'prefetch');await access(path.join(directory,'.bundle-managed/pending.json'));
    const preload=path.join(f.root,'deny-network.mjs');await writeFile(preload,'globalThis.fetch=()=>{throw new Error("Сеть при восстановлении запрещена")};');
    const cli=fileURLToPath(new URL('../models/bundle-cli.mjs',import.meta.url));
    const recovered=spawnSync(process.execPath,['--import',preload,cli,'--recover-only','--directory',directory],{encoding:'utf8',timeout:5000});
    assert.equal(recovered.status,0,recovered.stderr);assert.deepEqual(JSON.parse(recovered.stdout),{ok:true,recovered:true});
    for(const tag of tags)await assert.rejects(access(path.join(directory,tag.path)),{code:'ENOENT'});
    assert.equal((await f.run()).ok,true);assert.equal(f.calls.length,requests);
});

test('Проверка отсутствующей поставки не создаёт файлы и не обращается к сети',async t=>{
    const f=await assetFixture(t);await assert.rejects(f.run({verifyOnly:true}));assert.equal(f.calls.length,0);
    await assert.rejects(access(path.join(f.root,'.run')),{code:'ENOENT'});
});

for(const section of ['bridge','catalog','models'])test(`Некорректная опись ${section} останавливает всю поставку до записи и HTTP`,async t=>{
    const f=await assetFixture(t),files={bridge:'scripts/bridge-runtime-release.json',catalog:'scripts/catalog-plugins/catalog-release.json',models:'scripts/models/bundle-release.json'};
    const value=clone(section==='models'?f.bundle:f[section]);value.schemaVersion=99;await f.json(files[section],value);
    await assert.rejects(f.run());assert.equal(f.calls.length,0);await assert.rejects(access(path.join(f.root,'.run')),{code:'ENOENT'});
});

test('Несогласованная версия моста отклоняется до скачивания любых моделей и инструментов',async t=>{
    const f=await assetFixture(t);await f.json('mcp/neurocenter-asset-sync/package.json',{version:'9.8.8'});
    await assert.rejects(f.run(),/Версия моста/);assert.equal(f.calls.length,0);
});

test('Подмена URL каталога отвергается до первой загрузки моста',async t=>{
    const f=await assetFixture(t),catalog=clone(f.catalog);catalog.tools[0].artifacts[0].url='https://example.invalid/payload';
    await f.json('scripts/catalog-plugins/catalog-release.json',catalog);await assert.rejects(f.run(),/GitHub release/);assert.equal(f.calls.length,0);
});

test('Переадресация каталога за пределы GitHub не выполняется',async t=>{
    const f=await assetFixture(t),seen=[];
    await assert.rejects(f.run({fetch:async(url,options)=>{
        seen.push(url);return url.includes('/catalog-')?new Response(null,{status:302,headers:{location:'https://example.invalid/payload'}}):f.fetch(url,options);
    }}),/пределы GitHub/);
    assert.ok(seen.every(url=>new URL(url).hostname==='github.com'));await assert.rejects(access(f.receipt),{code:'ENOENT'});
});

test('Нехватка места останавливает HTTP и сохраняет прежнюю квитанцию',async t=>{
    const f=await assetFixture(t);await mkdir(path.dirname(f.receipt));await writeFile(f.receipt,'previous');
    await assert.rejects(f.run({readDisk:async()=>({bavail:0n,bsize:1n})}),{code:'ENOSPC'});
    assert.equal(f.calls.length,0);assert.equal(await readFile(f.receipt,'utf8'),'previous');
    await assert.rejects(access(path.join(f.root,'.run/assets-sync.lock')),{code:'ENOENT'});
});

test('Отказ каталога не создаёт квитанцию; повтор использует уже проверенный мост',async t=>{
    const f=await assetFixture(t);
    await assert.rejects(f.run({fetch:async(url,options)=>url.includes('/catalog-')?new Response(null,{status:503}):f.fetch(url,options)}),/HTTP 503/);
    await assert.rejects(access(f.receipt),{code:'ENOENT'});const bridgeCalls=f.calls.filter(url=>url.includes('bridge-v')).length;
    await f.run();assert.equal(f.calls.filter(url=>url.includes('bridge-v')).length,bridgeCalls);
});

test('Повреждённый архив immutable-кэша сохраняется и не получает квитанцию готовности',async t=>{
    const f=await assetFixture(t);await f.run();const before=await readFile(f.receipt),artifact=f.catalog.tools[0].artifacts[0];
    const filename=path.join(f.root,'data/runtime-artifacts',artifact.descriptor.sha256+'.tar.gz');
    // Имитируем повреждение хранилища; каталог не может тихо заменить файл с тем же SHA-именем.
    const {chmod}=await import('node:fs/promises');await chmod(filename,0o600);await writeFile(filename,Buffer.alloc(artifact.descriptor.compressedBytes));
    const calls=f.calls.length;await assert.rejects(f.run({verifyOnly:true}),/SHA-256/);await assert.rejects(f.run(),/SHA-256/);
    assert.equal(f.calls.length,calls);assert.deepEqual(await readFile(f.receipt),before);assert.deepEqual(await readFile(filename),Buffer.alloc(artifact.descriptor.compressedBytes));
});

test('Повреждение файла модели обнаруживается даже при прежней квитанции готовности',async t=>{
    const f=await assetFixture(t);await f.run();const file=f.bundle.files.find(item=>item.parts),before=await readFile(f.receipt);
    const filename=path.join(f.root,'data/embedding/.bundle-cache/blobs',file.sha256);await writeFile(filename,Buffer.alloc(file.size));
    await assert.rejects(f.run({verifyOnly:true}),/SHA существующего/);assert.deepEqual(await readFile(f.receipt),before);
});

test('Отмена передачи освобождает блокировку без квитанции; повтор восстанавливает поставку',async t=>{
    const f=await assetFixture(t),cancellation=new AbortController();
    await assert.rejects(f.run({signal:cancellation.signal,onProgress:value=>{
        if(value.section==='bridge'&&value.stage==='downloading')cancellation.abort(new Error('Отмена теста'));
    }}),/Отмена теста/);
    await assert.rejects(access(f.receipt),{code:'ENOENT'});await assert.rejects(access(path.join(f.root,'.run/assets-sync.lock')),{code:'ENOENT'});
    assert.equal((await f.run()).ok,true);
});

test('Параллельные команды ждут общей блокировки и не скачивают файлы повторно',async t=>{
    const f=await assetFixture(t);let release,entered;
    const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});let paused=false;
    const first=f.run({fetch:async(...args)=>{if(!paused){paused=true;entered();await gate;}return f.fetch(...args);}});
    await ready;const second=f.run();release();const [one,two]=await Promise.all([first,second]);
    assert.equal(one.revision,two.revision);assert.equal(f.calls.length,new Set(f.calls).size);
});

test('Изменение описи в ходе загрузки не получает квитанцию готовности',async t=>{
    const f=await assetFixture(t);let changed=false;
    await assert.rejects(f.run({fetch:async(...args)=>{
        if(!changed){changed=true;await writeFile(path.join(f.root,'scripts/models/model-registry.json'),(await readFile(path.join(f.root,'scripts/models/model-registry.json'),'utf8'))+'\n');}
        return f.fetch(...args);
    }}),/Опись изменилась/);await assert.rejects(access(f.receipt),{code:'ENOENT'});
});

test('Digest учитывает реестр моделей и каждый закреплённый lock',async t=>{
    const f=await assetFixture(t),before=await readAssetSupply({root:f.root});
    const filename=path.join(f.root,'scripts/embedding/model.lock.json');await writeFile(filename,(await readFile(filename,'utf8'))+'\n');
    assert.notEqual((await readAssetSupply({root:f.root})).revision,before.revision);
});

test('Хранилища уважают явные native-настройки; production volume не считается host-кэшем автоматически',()=>{
    const root='/checkout';
    assert.deepEqual(assetDirectories({root,environment:{}}),{models:'/checkout/data/embedding',catalog:'/checkout/data/runtime-artifacts',bridge:'/checkout/bridge-dist/runtime'});
    assert.equal(assetDirectories({root,environment:{MODEL_STORAGE_PATH:'/native/models',EMBEDDING_DATA_DIR:'fallback',RUNTIME_ARTIFACT_DIR:'runtime'}}).models,'/native/models');
    assert.equal(assetDirectories({root,environment:{EMBEDDING_DATA_DIR:'models'}}).models,'/checkout/models');
    assert.equal(assetDirectories({root,environment:{MODEL_STORAGE_PATH:'env'},modelsDirectory:'explicit'}).models,'/checkout/explicit');
});

test('Ссылка вместо host-кэша не используется при verify',async t=>{
    const f=await assetFixture(t);await f.run();await symlink(path.join(f.root,'data/embedding'),path.join(f.root,'linked-cache'));
    await assert.rejects(f.run({verifyOnly:true,modelsDirectory:'linked-cache'}),/ссылк/);
});

test('Умерший владелец общей блокировки не блокирует повторную подготовку',async t=>{
    const f=await assetFixture(t);await mkdir(path.join(f.root,'.run'));await writeFile(path.join(f.root,'.run/assets-sync.lock'),JSON.stringify({pid:2147483647,token:'dead-owner'}));
    assert.equal(await withAssetsLock(f.root,()=>42),42);
});

test('Блокировка публикует полностью записанного владельца; отмена ожидания удаляет только свою заготовку',async t=>{
    const f=await assetFixture(t),cancellation=new AbortController();
    await withAssetsLock(f.root,async()=>{
        const owner=JSON.parse(await readFile(path.join(f.root,'.run/assets-sync.lock'),'utf8'));assert.equal(owner.pid,process.pid);assert.ok(owner.token);
        await assert.rejects(withAssetsLock(f.root,()=>assert.fail('Второй владелец не допускается'),{
            signal:cancellation.signal,onProgress:()=>cancellation.abort(new Error('Отмена ожидания')),
        }),/aborted|Отмена ожидания/);
        assert.equal(JSON.parse(await readFile(path.join(f.root,'.run/assets-sync.lock'),'utf8')).token,owner.token);
        assert.equal((await readdir(path.join(f.root,'.run'))).filter(name=>name.startsWith('assets-sync.lock.')).length,1);
    });
    assert.deepEqual(await readdir(path.join(f.root,'.run')),[]);
});

test('CLI принимает безопасные режимы и help; неизвестные, повторные и конфликтующие параметры отклоняются',()=>{
    assert.deepEqual(parseAssetsArguments(['--verify-only','--root','/tmp/project']),{verifyOnly:true,root:'/tmp/project'});
    for(const help of ['--help','-h','—help'])assert.deepEqual(parseAssetsArguments(['--verify-only',help]),{help:true});
    for(const args of [['--verify-only','--download-only'],['--root'],['constructor'],['--verify-only','--verify-only'],['--unknown']])assert.throws(()=>parseAssetsArguments(args));
});

test('Автономный CLI читает настройки checkout и подтверждает кэш без npm-зависимостей',async t=>{
    const f=await assetFixture(t),environment={MODEL_STORAGE_PATH:'custom/models',RUNTIME_ARTIFACT_DIR:'custom/catalog'};
    await f.run({environment});await writeFile(path.join(f.root,'.env'),Object.entries(environment).map(([key,value])=>key+'='+value).join('\n'));
    const env={...process.env};for(const key of Object.keys(environment))delete env[key];
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../assets/cli.mjs',import.meta.url)),'--root',f.root,'--verify-only'],{encoding:'utf8',env,timeout:30000});
    assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
    assert.equal(report.verifyOnly,true);assert.equal(report.directories.models,path.join(f.root,'custom/models'));assert.equal(report.directories.catalog,path.join(f.root,'custom/catalog'));
});
