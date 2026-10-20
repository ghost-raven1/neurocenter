import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import * as contract from '@neurocenter/asset-contract';
import sourceReader from '../../services/shared/asset-source-client.cjs';
import {safeDirectory} from '../models/bundle-files.mjs';
import {AssetCache} from './cache.mjs';

/** Единственный источник поставки — commit и точный index SHA нового репозитория. */
export async function readSourcePin(root) {
    await safeDirectory(root,'services/shared');
    const file=path.join(root,'services/shared/asset-source.lock.json'),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16384)throw new Error('Некорректный lock источника ассетов.');
    const bytes=await readFile(file);
    return {pin:sourceReader.validateSourcePin(JSON.parse(bytes)),lockSha256:contract.assetDigest(bytes)};
}
export function assetDirectories({root,environment=process.env,artifactsDirectory}) {
    const catalog=path.resolve(root,artifactsDirectory||environment.RUNTIME_ARTIFACT_DIR||'data/runtime-artifacts');
    return {catalog,blobs:path.join(catalog,'.asset-source-blobs'),metadata:path.join(catalog,'.asset-source-metadata')};
}

/** Описания читаются без бинарников; offline проверка использует только подтверждённые SHA-кэши. */
export async function readAssetSupply({root,environment=process.env,artifactsDirectory,verifyOnly=false,withoutModels=false,ids,
    signal,fetch:request=globalThis.fetch}={}) {
    const {pin,lockSha256}=await readSourcePin(root),directories=assetDirectories({root,environment,artifactsDirectory});
    const source=new sourceReader.AssetSourceClient(pin,{contract,fetch:request,signal,offline:verifyOnly,cache:new AssetCache(directories.metadata)});
    const index=await source.index();
    const selected=ids??index.assets.filter(entry=>entry.current&&(!withoutModels||entry.kind!=='model')).map(entry=>entry.id);
    if(!Array.isArray(selected)||new Set(selected).size!==selected.length||selected.some(id=>typeof id!=='string'))throw new Error('Выберите разные ID ассетов.');
    if(ids&&withoutModels&&index.assets.some(entry=>entry.current&&entry.kind==='model'&&selected.includes(entry.id)))throw new Error('Модель выбрана вместе с --without-models.');
    const records=new Map();
    for(let start=0;start<selected.length;start+=50){
        const batch=await source.select(selected.slice(start,start+50));
        for(const record of batch.assets)records.set(record.asset.id+'@'+record.asset.version,record);
    }
    if(records.size>300||[...records.values()].reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item.asset)),0)>32*1024*1024)throw new Error('Выбор превышает размер поддерживаемой поставки.');
    const assets=contract.selectAssets([...records.values()],selected);
    if(withoutModels&&assets.some(record=>record.asset.kind==='model'))throw new Error('Выбранному инструменту нужна модель. Выберите профиль full или другой набор ассетов.');
    const artifacts=new Map();
    for(const {asset}of assets)for(const artifact of contract.downloadArtifacts(asset)){
        const previous=artifacts.get(artifact.sha256);
        if(previous&&previous.bytes!==artifact.bytes)throw new Error('Один SHA ассета имеет разные размеры.');
        artifacts.set(artifact.sha256,previous?.url?previous:artifact);
    }
    return {pin,revision:pin.index.sha256,lockSha256,index,assets,artifacts:[...artifacts.values()],directories,selected};
}
