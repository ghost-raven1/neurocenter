import {lstat,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {hydrateBridgeRuntimeRelease,bridgeRuntimeCached} from '../bridge-runtime-release.mjs';
import {cacheCatalogRelease,verifyCatalogRelease} from '../catalog-plugins/release-cache.mjs';
import {hydrateModelBundle} from '../models/bundle.mjs';
import {ensureSpace,safeDirectory,verifyFile} from '../models/bundle-files.mjs';
import {readAssetSupply,assetDirectories} from './supply.mjs';
import {withAssetsLock} from './lock.mjs';

export {readAssetSupply,assetDirectories};
const repository=fileURLToPath(new URL('../../',import.meta.url));

async function verifyBridge(supply,directory,signal,onProgress) {
    await safeDirectory(directory);
    let completed=0;
    for(const artifact of supply.bridge.artifacts) {
        signal?.throwIfAborted();
        if(!await bridgeRuntimeCached({directory,target:artifact.metadata.target,version:supply.bridge.version,buildId:supply.bridge.buildId,metadata:artifact.metadata}))throw new Error('Закреплённый автономный мост отсутствует или не прошёл SHA-256.');
        await onProgress({section:'bridge',stage:'verifying',message:'Проверяем архивы автономного моста.',completed:++completed,total:supply.bridge.artifacts.length,unit:'files'});
    }
}

/** Для prefetch достаточно активного immutable blob или его проверенного кэша; теги остаются прежними. */
async function verifyModels(supply,directory,signal,onProgress) {
    await safeDirectory(directory);
    const blobs=supply.models.files.filter(file=>file.parts);let completed=0;
    for(const file of blobs) {
        signal?.throwIfAborted();
        const expected={size:file.size,sha256:file.sha256};
        const present=async(relative)=>{
            try {await safeDirectory(directory,path.posix.dirname(relative));} catch(error) {if(error.code==='ENOENT')return false;throw error;}
            return verifyFile(path.join(directory,relative),expected,{onBytes:()=>signal?.throwIfAborted()});
        };
        if(!await present(file.path)&&!await present('.bundle-cache/blobs/'+file.sha256))throw new Error('Часть закреплённых моделей отсутствует в активном хранилище и кэше предзагрузки.');
        await onProgress({section:'models',stage:'verifying',message:'Проверяем предзагруженные веса моделей.',completed:++completed,total:blobs.length,unit:'files'});
    }
    return {models:supply.locks.length,files:supply.models.files.length};
}

async function writeReceipt(root,report) {
    await safeDirectory(root,'.run',true);
    const filename=path.join(root,'.run/assets-ready.json'),temporary=filename+'.'+randomUUID();
    try {
        try {const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink())throw new Error('Квитанция поставки заменена посторонними данными.');} catch(error) {if(error.code!=='ENOENT')throw error;}
        await writeFile(temporary,JSON.stringify({...report,schemaVersion:1,preparedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
        await rename(temporary,filename);
    } finally {await rm(temporary,{force:true});}
}

/** Одна поставка: сначала все описи, затем SHA-кэш без активации, квитанция — только после всех проверок. */
export async function syncAssets({root=repository,environment=process.env,modelsDirectory,artifactsDirectory,verifyOnly=false,
    signal,onProgress=()=>{},fetch:request=globalThis.fetch,readDisk,lockWaitMs}={}) {
    root=path.resolve(root);await safeDirectory(root);
    const supply=await readAssetSupply({root}),directories=assetDirectories({root,environment,modelsDirectory,artifactsDirectory});
    const report={ok:true,mode:'prefetch',verifyOnly,revision:supply.revision,directories,
        bridge:{version:supply.bridge.version,targets:supply.bridge.artifacts.map(item=>item.metadata.target)},
        catalog:{release:supply.catalog.release,tools:supply.catalog.tools.length},models:{models:supply.locks.length,files:supply.models.files.length}};
    const verify=async()=>{
        await verifyBridge(supply,directories.bridge,signal,onProgress);
        await verifyCatalogRelease({manifest:supply.catalog,directory:directories.catalog,signal,onProgress});
        await verifyModels(supply,directories.models,signal,onProgress);
        if((await readAssetSupply({root})).revision!==supply.revision)throw new Error('Опись изменилась во время проверки. Повторите подготовку поставки.');
        signal?.throwIfAborted();return report;
    };
    if(verifyOnly)return verify();
    return withAssetsLock(root,async()=>{
        signal?.throwIfAborted();
        if((await readAssetSupply({root})).revision!==supply.revision)throw new Error('Опись изменилась во время ожидания. Повторите подготовку поставки.');
        await onProgress({section:'supply',stage:'inspecting',message:'Проверяем закреплённую поставку моста, инструментов и моделей.'});
        let bridgeBytes=0;
        for(const artifact of supply.bridge.artifacts) {
            if(!await bridgeRuntimeCached({directory:directories.bridge,target:artifact.metadata.target,version:supply.bridge.version,buildId:supply.bridge.buildId,metadata:artifact.metadata}))bridgeBytes+=artifact.metadata.bytes;
        }
        await safeDirectory(directories.bridge,'',true);
        await ensureSpace(directories.bridge,bridgeBytes,readDisk);
        await hydrateBridgeRuntimeRelease({directory:root,release:supply.bridge,fetch:request,signal,onProgress});
        await cacheCatalogRelease({manifest:supply.catalog,directory:directories.catalog,fetch:request,signal,onProgress,readDisk});
        await hydrateModelBundle({directory:directories.models,manifest:supply.models,locks:supply.locks,downloadOnly:true,fetch:request,signal,readDisk,
            onProgress:value=>onProgress({section:'models',...value})});
        // Изменение git checkout во время загрузки или SHA-проверки не получит прежнюю квитанцию.
        await verify();await writeReceipt(root,report);
        await onProgress({section:'supply',stage:'ready',message:'Вся закреплённая поставка готова; теги моделей и база данных не изменены.'});
        return report;
    },{signal,onProgress,waitMs:lockWaitMs});
}
