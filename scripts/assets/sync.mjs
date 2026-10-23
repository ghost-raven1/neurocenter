import {lstat,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fetchArtifact} from '@neurocenter/asset-contract';
import {ensureSpace,safeDirectory} from '../models/bundle-files.mjs';
import {readAssetSupply,readSourcePin,assetDirectories} from './supply.mjs';
import {AssetCache} from './cache.mjs';
import {withAssetsLock} from './lock.mjs';
export {readAssetSupply,assetDirectories};
const repository=fileURLToPath(new URL('../../',import.meta.url));

async function receipt(root,report){
    await safeDirectory(root,'.run',true);
    const filename=path.join(root,'.run/assets-ready.json'),temporary=filename+'.'+randomUUID();
    try{
        try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error('Квитанция поставки заменена посторонними данными.');}catch(error){if(error.code!=='ENOENT')throw error;}
        await writeFile(temporary,JSON.stringify({...report,schemaVersion:2,preparedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
        await rename(temporary,filename);
    }finally{await rm(temporary,{force:true});}
}

/** Только prefetch нового формата: не создаёт карточки, registry, теги моделей или установки моста. */
export async function syncAssets({root=repository,environment=process.env,artifactsDirectory,verifyOnly=false,metadataOnly=false,offlineReady=false,withoutModels=false,ids,expectedRepository,expectedCommit,expectedRevision,
    signal,onProgress=()=>{},fetch:request=globalThis.fetch,readDisk,lockWaitMs}={}){
    root=path.resolve(root);await safeDirectory(root);
    const execute=async()=>{
        signal?.throwIfAborted();
        const supply=await readAssetSupply({root,environment,artifactsDirectory,verifyOnly,offlineReady,withoutModels,ids,expectedRepository,expectedCommit,expectedRevision,signal,fetch:request});
        const guardSelection=async()=>{
            if(expectedCommit!==undefined&&(await readSourcePin(root)).lockSha256!==supply.lockSha256)throw Object.assign(new Error('Источник ассетов изменился после выбора. Повторите запуск; прежние файлы сохранены.'),{code:'ASSET_SOURCE_CHANGED'});
        };
        await guardSelection();
        const cache=new AssetCache(supply.directories.blobs),missing=[];
        const report={ok:true,mode:metadataOnly?'metadata':'prefetch',verifyOnly,revision:supply.revision,sourceCommit:supply.pin.commit,directories:supply.directories,
            selected:supply.selected,assets:supply.assets.map(({asset,sha256})=>({id:asset.id,kind:asset.kind,version:asset.version,sha256})),
            files:supply.artifacts.length,bytes:supply.artifacts.reduce((sum,item)=>sum+item.bytes,0),downloaded:0,...(withoutModels?{withoutModels:true}:{}),...(offlineReady?{offlineReady:true}:{})};
        for(const artifact of metadataOnly?[]:supply.artifacts){
            signal?.throwIfAborted();
            if(!await cache.verify(artifact,signal))missing.push(artifact);
        }
        if(verifyOnly&&missing.length)throw new Error('Часть выбранных ассетов отсутствует в SHA-кэше. Выполните npm run assets:sync с тем же выбором.');
        if(!verifyOnly&&!metadataOnly){
            if(supply.offline&&missing.length)throw Object.assign(new Error('ASSET_SOURCE_MODE=offline: бинарные файлы выбранных ассетов отсутствуют в SHA-кэше. Подготовьте тот же выбор с --offline-ready на машине с доступом к сети.'),{code:'ASSET_ARTIFACTS_MISSING'});
            if(missing.some(artifact=>!artifact.url))throw new Error('Локальные файлы выбранного ассета отсутствуют в проверенном SHA-кэше. Загрузите исходный пакет или импортируйте опубликованную версию с адресом доставки.');
            await safeDirectory(cache.directory,'',true);await ensureSpace(cache.directory,missing.reduce((sum,item)=>sum+item.bytes,0),readDisk);
            let completed=0;
            for(const artifact of missing){
                signal?.throwIfAborted();const temporary=path.join(cache.directory,'.download-'+randomUUID());
                try{
                    await onProgress({section:'assets',stage:'downloading',message:'Загружаем выбранные ассеты.',completed,total:missing.length,unit:'files'});
                    await guardSelection();
                    await fetchArtifact(artifact,temporary,{fetch:request,signal});
                    await cache.publish(temporary,artifact.sha256,'.blob');
                    if(!await cache.verify(artifact,signal))throw new Error('Проверенный ассет исчез из кэша.');
                    report.downloaded++;completed++;
                }finally{await rm(temporary,{force:true});}
            }
        }
        if((await readSourcePin(root)).lockSha256!==supply.lockSha256)throw new Error('Источник изменился во время подготовки. Повторите команду.');
        signal?.throwIfAborted();if(!verifyOnly)await receipt(root,report);
        await onProgress({section:'assets',stage:'ready',message:metadataOnly?'Описания нового источника проверены; бинарники не загружались.':'Выбранные ассеты проверены. Состав каталога меняется только явным импортом.',
            ...(metadataOnly?{}:{completed:supply.artifacts.length,total:supply.artifacts.length,unit:'files'})});
        return report;
    };
    return verifyOnly?execute():withAssetsLock(root,execute,{signal,onProgress,waitMs:lockWaitMs});
}
