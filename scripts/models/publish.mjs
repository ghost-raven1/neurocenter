import {constants} from 'node:fs';
import {readFile,writeFile,lstat,open,rename,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {packModelBundle} from './bundle.mjs';
import {sha256,lockedFiles,releaseBaseUrl} from './bundle-manifest.mjs';
import {safeDirectory,ensureSpace} from './bundle-files.mjs';
import {readModelRegistry,registryModelLocks,validateModelRegistry} from './model-registry.mjs';
import {withAssetsLock} from '../assets/lock.mjs';
import {readPreparedSupply} from './publication-stage.mjs';

const execute=promisify(execFile),repository='ghost-raven1/neurocenter';
const json=value=>JSON.stringify(value,null,2)+'\n';

/** Рецепт из каталога не содержит весов, адресов сервера, GitHub-токенов или исполняемых команд. */
export function modelSupplyRecipe(value) {
    if(!value||value.schemaVersion!==1||Object.keys(value).some(key=>!['schemaVersion','id','name','descriptor'].includes(key))
        ||!value.descriptor||!['custom','builtin'].includes(value.descriptor.source)
        ||!(value.descriptor.manifestSha256===null||typeof value.descriptor.manifestSha256==='string'&&/^[a-f0-9]{64}$/.test(value.descriptor.manifestSha256)))throw new Error('Нужен рецепт поставки модели, экспортированный из каталога.');
    const descriptor={...value.descriptor,source:'builtin',manifestSha256:'0'.repeat(64)};
    const item={id:value.id,name:value.name,descriptor,lock:`./locks/${value.id}.lock.json`};
    validateModelRegistry({schemaVersion:1,models:[item]});
    return item;
}

async function smallFile(filename) {
    const info=await lstat(filename);
    if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>128*1024)throw new Error('Нужен небольшой обычный файл манифеста модели.');
    const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
        const current=await file.stat();
        if(!current.isFile()||current.ino!==info.ino||current.dev!==info.dev||current.size!==info.size)throw new Error('Манифест модели изменился перед чтением.');
        const bytes=await file.readFile();if(bytes.length!==info.size)throw new Error('Манифест модели изменился при чтении.');
        return bytes;
    } finally {await file.close();}
}

async function localLock(directory,item) {
    const [name,tag]=item.descriptor.model.split(':'),relative=`models/manifests/registry.ollama.ai/${name.includes('/')?name:'library/'+name}`;
    await safeDirectory(directory,relative);
    const bytes=await smallFile(path.join(directory,relative,tag)),manifest=JSON.parse(bytes);
    const lock={schemaVersion:1,model:item.descriptor.model,manifestSha256:sha256(bytes),manifest,
        ...(item.descriptor.dimension!==null?{dimension:item.descriptor.dimension}:{}),capability:item.descriptor.capability};
    lockedFiles([lock]);return lock;
}

async function snapshot(filename) {
    try {return await readFile(filename);} catch(error) {if(error.code==='ENOENT')return null;throw error;}
}

/** Изменённый checkout не затирается: снапшоты сверяются после длительной упаковки и загрузки. */
async function installMetadata(changes) {
    for(const change of changes) {
        const current=await snapshot(change.filename);
        if(!(current===null&&change.before===null||current&&change.before&&current.equals(change.before)))throw new Error('Метаданные поставки изменились. Релиз загружен; обновление checkout остановлено. Повторите команду с новым release.');
    }
    const installed=[];
    try {
        for(const change of changes) {
            await safeDirectory(path.dirname(change.filename),'',true);
            const temporary=change.filename+`.publish-${process.pid}.tmp`;
            try {
                await writeFile(temporary,change.bytes,{flag:'wx',mode:0o600});
                await rename(temporary,change.filename);installed.push(change);
            } finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
        }
    } catch(error) {
        for(const change of installed.reverse()) {
            if(change.before===null)await unlink(change.filename);
            else await writeFile(change.filename,change.before,{mode:0o600});
        }
        throw error;
    }
}

async function ghRun(args) {
    const result=await execute('gh',args,{maxBuffer:4*1024*1024});return result.stdout;
}

/** Новый draft публикуется только после проверки перечня, размеров и серверных SHA загруженных assets. */
export async function publishModelAssets({release,output,manifest,run=ghRun,onProgress=()=>{}}) {
    const assets=manifest.files.flatMap(file=>file.parts||[]).map(part=>({name:part.name,size:part.size,sha256:part.sha256}));
    const metadata=await readFile(path.join(output,'bundle-release.json'));
    assets.push({name:'bundle-release.json',size:metadata.length,sha256:sha256(metadata)});
    const read=async()=>JSON.parse(await run(['api',`repos/${repository}/releases/tags/${release}`]));
    let remote;
    try {remote=await read();} catch(error) {if(!/\bHTTP 404\b/.test(error.stderr||''))throw error;}
    const matching=(item,asset)=>item.name===asset.name&&item.size===asset.size&&item.digest==='sha256:'+asset.sha256;
    const valid=(value,complete)=>value?.tag_name===release&&typeof value.draft==='boolean'&&Array.isArray(value.assets)
        &&new Set(value.assets.map(item=>item.name)).size===value.assets.length
        &&value.assets.every(item=>assets.some(asset=>matching(item,asset)))
        &&(!complete||value.assets.length===assets.length);
    if(remote&&!valid(remote,!remote.draft))throw new Error('Существующий release отличается от подготовленной поставки. Выберите новый --release. Файлы Git не изменены.');
    if(!remote) {
        await onProgress({stage:'creating-release',message:'Создаём черновик поставки на GitHub.'});
        await run(['release','create',release,'--repo',repository,'--draft','--title',release,'--notes','Закреплённая поставка локальных моделей Нейроцентра. SHA-256 каждого файла находится в bundle-release.json.']);
        remote={tag_name:release,draft:true,assets:[]};
    }
    if(remote.draft) {
        const missing=assets.filter(asset=>!remote.assets.some(item=>matching(item,asset)));
        for(let index=0;index<missing.length;index+=25) {
            await onProgress({stage:'uploading',message:`Загружаем части на GitHub: ${Math.min(index+25,missing.length)} / ${missing.length}. Уже проверенные части не отправляются повторно.`});
            await run(['release','upload',release,'--repo',repository,...missing.slice(index,index+25).map(asset=>path.join(output,asset.name))]);
        }
        await onProgress({stage:'verifying-release',message:'Проверяем размеры и SHA-256 всех частей на GitHub перед публикацией.'});
        if(!valid(await read(),true))throw new Error('GitHub не подтвердил все части поставки по SHA-256. Draft сохранён; файлы Git не изменены.');
        await run(['release','edit',release,'--repo',repository,'--draft=false']);
        remote=await read();
    }
    if(!valid(remote,true)||remote.draft)throw new Error('GitHub не подтвердил публикацию моделей. Файлы Git не изменены.');
}

/** По умолчанию только упаковка. Git-метаданные меняются после явного --publish и успешной публикации. */
export async function prepareModelSupply({root,recipe,release,directory,output,publish=false},dependencies={}) {
    return withAssetsLock(root,()=>prepareSupply({root,recipe,release,directory,output,publish},dependencies),
        {onProgress:dependencies.onProgress});
}

async function prepareSupply({root,recipe,release,directory,output,publish},dependencies) {
    const progress=dependencies.onProgress||(()=>{});
    releaseBaseUrl(`https://github.com/${repository}/releases/download/${release}`);
    if(typeof publish!=='boolean')throw new Error('Некорректный режим публикации.');
    const registryFile=path.join(root,'scripts/models/model-registry.json'),manifestFile=path.join(root,'scripts/models/bundle-release.json');
    const oldRegistry=await snapshot(registryFile),oldManifest=await snapshot(manifestFile);
    const registry=await readModelRegistry(registryFile),locks=await registryModelLocks(registryFile);
    const receipt=JSON.parse(await smallFile(path.resolve(recipe))),item=modelSupplyRecipe(receipt);
    directory=await safeDirectory(path.resolve(directory||path.join(root,'data/embedding')));
    let lock=await localLock(directory,item);
    if(receipt.descriptor.manifestSha256!==null&&receipt.descriptor.manifestSha256!==lock.manifestSha256)throw new Error('Локальный манифест отличается от SHA рецепта. Экспортируйте актуальный рецепт перед публикацией.');
    item.descriptor.manifestSha256=lock.manifestSha256;
    const existing=registry.models.findIndex(current=>current.id===item.id);
    if(existing>=0) {
        const previous=registry.models[existing];
        for(const key of ['model','capability','dimension'])if(previous.descriptor[key]!==item.descriptor[key])throw new Error('Технические параметры существующего ID модели менять нельзя. Создайте отдельную карточку модели.');
        lock={...locks[existing],...lock};item.lock=previous.lock;registry.models[existing]=item;locks[existing]=lock;
    } else {registry.models.push(item);locks.push(lock);}
    validateModelRegistry(registry);const files=lockedFiles(locks);
    output=path.resolve(output||path.join(root,'.run/model-supply',release));
    await safeDirectory(path.dirname(output),'',true);
    const lockFile=path.resolve(path.dirname(registryFile),item.lock),oldLock=await snapshot(lockFile);
    const baseUrl=`https://github.com/${repository}/releases/download/${release}`;
    await progress({stage:'inspecting',message:'Проверяем локальную модель и ранее подготовленную поставку.'});
    let manifest=await readPreparedSupply({output,registry,lock,locks,baseUrl});
    if(!manifest) {
        await ensureSpace(path.dirname(output),[...files.values()].reduce((sum,file)=>sum+(file.size||0),0),dependencies.readDisk);
        await progress({stage:'packing',message:`Упаковываем все модели поставки: ${registry.models.length}. Файлы проверяются по SHA-256.`});
        manifest=await (dependencies.pack||packModelBundle)({directory,output,baseUrl,locks});
        await writeFile(path.join(output,'model-registry.json'),json(registry),{flag:'wx',mode:0o600});
        await writeFile(path.join(output,'model.lock.json'),json(lock),{flag:'wx',mode:0o600});
    }
    if(publish) {
        await publishModelAssets({release,output,manifest,run:dependencies.run,onProgress:progress});
        await progress({stage:'updating-metadata',message:'Публикация подтверждена. Обновляем реестр, lock и опись поставки в checkout.'});
        await installMetadata([{filename:lockFile,before:oldLock,bytes:Buffer.from(json(lock))},
            {filename:registryFile,before:oldRegistry,bytes:Buffer.from(json(registry))},
            {filename:manifestFile,before:oldManifest,bytes:Buffer.from(json(manifest))}]);
    }
    return {ok:true,published:publish,release,models:registry.models.length,files:manifest.files.length,parts:manifest.files.flatMap(file=>file.parts||[]).length,output};
}
