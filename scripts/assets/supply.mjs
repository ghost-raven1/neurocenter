import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import * as contract from '@neurocenter/asset-contract';
import sourceReader from '../../services/shared/asset-source-client.cjs';
import bundledCatalog from '../../services/shared/bundled-catalog.cjs';
import {safeDirectory} from '../models/bundle-files.mjs';
import {AssetCache} from './cache.mjs';

/** Git carries the approved current source set; legacy Git pins remain readable through exact bundled metadata. */
export async function readSourcePin(root) {
    await safeDirectory(root,'services/shared');
    let file=path.join(root,'services/shared/bundled-catalog.lock.json'),info;
    try{info=await lstat(file);}catch(error){
        if(error.code!=='ENOENT')throw error;
        file=path.join(root,'services/shared/asset-source.lock.json');info=await lstat(file);
        if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16384)throw new Error('Некорректный lock источника ассетов.');
        const bytes=await readFile(file),pin=sourceReader.validateSourcePin(JSON.parse(bytes));
        if(pin.repository==='ghost-raven1/neurocenter-assets')throw new Error('В приложении отсутствует закреплённая поставка catalog-source. Обновите исходники через Git.');
        return {pin,lockSha256:contract.assetDigest(bytes)};
    }
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16384)throw new Error('Некорректный lock источника ассетов.');
    const bytes=await readFile(file);
    const bundle=await bundledCatalog.readBundledCatalog(root);
    return {pin:sourceReader.validateSourcePin(bundle.pin),lockSha256:contract.assetDigest(bytes),bundle};
}
export function assetDirectories({root,environment=process.env,artifactsDirectory}) {
    const catalog=path.resolve(root,artifactsDirectory||environment.RUNTIME_ARTIFACT_DIR||'data/runtime-artifacts');
    return {catalog,blobs:path.join(catalog,'.asset-source-blobs'),metadata:path.join(catalog,'.asset-source-metadata')};
}

/** Complete source metadata shares the immutable SHA cache and one exact-byte budget, including recipes. */
function boundedMetadata(cache){
    const seen=new Set();let total=0;
    const account=(sha,bytes)=>{
        if(!bytes||contract.assetDigest(bytes)!==sha||seen.has(sha))return;
        if(total+bytes.length>32*1024*1024)throw new Error('Полные описания источника превышают 32 МиБ.');
        seen.add(sha);total+=bytes.length;
    };
    return {
        async read(sha,maximum){const bytes=await cache.read(sha,maximum);account(sha,bytes);return bytes;},
        async write(sha,bytes){account(sha,bytes);await cache.write(sha,bytes);},
    };
}

/** Every historical descriptor must retain resolvable exact dependency pins for later offline imports. */
function completeGraph(records){
    const visiting=new Set(),done=new Set(),fail=()=>{throw new Error('Зависимости полного источника не образуют согласованный граф точных версий и SHA-256.');};
    const visit=key=>{
        if(visiting.has(key))fail();if(done.has(key))return;visiting.add(key);
        for(const dependency of records.get(key).asset.dependencies||[]){
            const target=dependency.id+'@'+dependency.version,record=records.get(target);
            if(!record||record.sha256!==dependency.sha256)fail();visit(target);
        }
        visiting.delete(key);done.add(key);
    };
    for(const key of records.keys())visit(key);
}

/** Описания читаются без бинарников; offline проверка использует только подтверждённые SHA-кэши. */
export async function readAssetSupply({root,environment=process.env,artifactsDirectory,verifyOnly=false,offlineReady=false,withoutModels=false,ids,expectedRepository,expectedCommit,expectedRevision,
    signal,fetch:request=globalThis.fetch}={}) {
    const {pin,lockSha256,bundle}=await readSourcePin(root),directories=assetDirectories({root,environment,artifactsDirectory});
    if([expectedRepository,expectedCommit,expectedRevision].some(value=>value!==undefined)
        &&(pin.repository!==expectedRepository||pin.commit!==expectedCommit||pin.index.sha256!==expectedRevision))throw Object.assign(new Error('Источник ассетов отличается от подтверждённого выбора. Повторите запуск; сохранённые файлы не изменены.'),{code:'ASSET_SOURCE_CHANGED'});
    const mode=environment.ASSET_SOURCE_MODE||'online';
    if(!['online','offline'].includes(mode))throw new Error('ASSET_SOURCE_MODE должен быть online или offline.');
    const offline=verifyOnly||mode==='offline';
    const metadata=new AssetCache(directories.metadata);
    const source=new sourceReader.AssetSourceClient(pin,{contract,fetch:request,signal,offline,local:bundle?.metadata,cache:offlineReady?boundedMetadata(metadata):metadata});
    const index=await source.index();
    if(offlineReady&&index.assets.length>300)throw new Error('Полный источник превышает 300 описаний ассетов.');
    const selected=ids??index.assets.filter(entry=>entry.current&&(!withoutModels||entry.kind!=='model')).map(entry=>entry.id);
    if(!Array.isArray(selected)||new Set(selected).size!==selected.length||selected.some(id=>typeof id!=='string'))throw new Error('Выберите разные ID ассетов.');
    if(offlineReady&&selected.some(id=>!index.assets.some(entry=>entry.current&&entry.id===id)))throw new Error('Выбранный ассет отсутствует в закреплённой описи.');
    if(ids&&withoutModels&&index.assets.some(entry=>entry.current&&entry.kind==='model'&&selected.includes(entry.id)))throw new Error('Модель выбрана вместе с --without-models.');
    const records=new Map();
    if(offlineReady){
        for(const entry of index.assets){signal?.throwIfAborted();const record=await source.descriptor(entry);records.set(record.asset.id+'@'+record.asset.version,record);}
        completeGraph(records);
    }else{
        for(let start=0;start<selected.length;start+=50){
            const batch=await source.select(selected.slice(start,start+50));
            for(const record of batch.assets)records.set(record.asset.id+'@'+record.asset.version,record);
        }
    }
    if(records.size>300||[...records.values()].reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item.asset)),0)>32*1024*1024)throw new Error('Выбор превышает размер поддерживаемой поставки.');
    const assets=contract.selectAssets([...records.values()],selected);
    if(withoutModels&&assets.some(record=>record.asset.kind==='model'))throw new Error('Выбранному инструменту нужна модель. Выберите профиль full или другой набор ассетов.');
    const artifacts=new Map();
    for(const {asset}of assets)for(const artifact of asset.kind==='model'?[]:contract.downloadArtifacts(asset)){
        const previous=artifacts.get(artifact.sha256);
        if(previous&&previous.bytes!==artifact.bytes)throw new Error('Один SHA ассета имеет разные размеры.');
        artifacts.set(artifact.sha256,previous?.url?previous:artifact);
    }
    return {pin,revision:pin.index.sha256,lockSha256,index,assets,artifacts:[...artifacts.values()],directories,selected,offline,sourcePlans:bundle?.plans??[]};
}
