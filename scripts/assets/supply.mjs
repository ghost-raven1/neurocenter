import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {validateBridgeRuntimeRelease} from '../bridge-runtime-release.mjs';
import {validateCatalogRelease} from '../catalog-plugins/release-cache.mjs';
import {validateModelBundle,modelLocks} from '../models/bundle-manifest.mjs';
import {safeDirectory} from '../models/bundle-files.mjs';
import {validateModelRegistry} from '../models/model-registry.mjs';

const manifests={bridge:'scripts/bridge-runtime-release.json',catalog:'scripts/catalog-plugins/catalog-release.json',models:'scripts/models/bundle-release.json'};

/** Опись поставки выводится из исходных manifest/lock; повторного списка SHA в репозитории нет. */
export async function readAssetSupply({root}) {
    const bytes=new Map();
    const read=async(relative,limit=16*1024*1024)=>{
        await safeDirectory(root,path.posix.dirname(relative));
        const filename=path.join(root,relative),info=await lstat(filename);
        if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw new Error('Опись поставки должна быть небольшим обычным JSON-файлом.');
        const data=await readFile(filename);bytes.set(relative,data);return JSON.parse(data);
    };
    const bridge=validateBridgeRuntimeRelease(await read(manifests.bridge,256*1024));
    const catalog=validateCatalogRelease(await read(manifests.catalog));
    const models=await read(manifests.models,256*1024);
    const registry=validateModelRegistry(await read('scripts/models/model-registry.json',256*1024));
    for(const item of registry.models)await read(path.posix.normalize('scripts/models/'+item.lock),256*1024);
    const locks=await modelLocks(path.join(root,'scripts/models/model-registry.json'));
    validateModelBundle(models,locks);
    const bridgePackage=await read('mcp/neurocenter-asset-sync/package.json',256*1024);
    if(bridgePackage.version!==bridge.version)throw new Error('Версия моста отличается от закреплённого release.');
    const digest=createHash('sha256');
    for(const [filename,data] of [...bytes].sort(([a],[b])=>a.localeCompare(b)))digest.update(filename+'\0').update(data).update('\0');
    return {revision:digest.digest('hex'),bridge,catalog,models,locks};
}

/** Production named-volume активирует setup; hook заполняет только явно выбранный host-кэш. */
export function assetDirectories({root,environment=process.env,modelsDirectory,artifactsDirectory}) {
    return {
        models:path.resolve(root,modelsDirectory||environment.MODEL_STORAGE_PATH||environment.EMBEDDING_DATA_DIR||'data/embedding'),
        catalog:path.resolve(root,artifactsDirectory||environment.RUNTIME_ARTIFACT_DIR||'data/runtime-artifacts'),
        bridge:path.join(root,'bridge-dist/runtime'),
    };
}
