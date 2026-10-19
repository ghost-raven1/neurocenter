import {isDeepStrictEqual} from 'node:util';
import {mkdtemp,lstat,rm,link,unlink,chmod,open} from 'node:fs/promises';
import path from 'node:path';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import {downloadPart,ensureSpace,safeDirectory} from '../models/bundle-files.mjs';

const {normalizeRuntimeArtifacts,inspectRuntimeArchive}=runtime;
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>Object.keys(value).every(key=>keys.includes(key));

/** Предзагрузка проверяет опись файлов без сборки Nest, npm, БД и исполнения плагинов. */
export function validateCatalogRelease(value) {
    if(!record(value)||!exact(value,['schemaVersion','release','tools'])||value.schemaVersion!==1
        ||typeof value.release!=='string'||!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.release)||/^(latest|main|master|head)$/i.test(value.release)
        ||!Array.isArray(value.tools)||!value.tools.length||value.tools.length>100)throw new Error('Некорректная закреплённая опись каталога.');
    const keys=new Set(),names=new Set(),hashes=new Map();
    for(const tool of value.tools) {
        if(!record(tool)||!exact(tool,['key','publication','legacyOrigins','legacyPackages','artifacts'])
            ||typeof tool.key!=='string'||!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(tool.key)||keys.has(tool.key)
            ||!record(tool.publication)||!['mcp','plugin'].includes(tool.publication.kind)
            ||typeof tool.publication.name!=='string'||!tool.publication.name.trim()||names.has(tool.publication.name.toLowerCase())
            ||typeof tool.publication.revision!=='string'||!tool.publication.revision.trim()||/^(latest|main|master|head)$/i.test(tool.publication.revision)
            ||!Array.isArray(tool.artifacts)||tool.artifacts.length>8)throw new Error('Некорректный инструмент закреплённого каталога.');
        const supplied=normalizeRuntimeArtifacts(tool.artifacts.length?tool.artifacts.map(artifact=>artifact?.descriptor):undefined);
        if(!isDeepStrictEqual(supplied,normalizeRuntimeArtifacts(tool.publication.config?.extra?.runtimeArtifacts)))throw new Error('Опись архивов отличается от конфигурации инструмента.');
        runtime.validateRuntimeArtifactEntrypoints(tool.publication.kind,supplied);
        for(const artifact of tool.artifacts) {
            if(!record(artifact)||!exact(artifact,['descriptor','url'])
                ||artifact.url!==`https://github.com/ghost-raven1/neurocenter/releases/download/${value.release}/${artifact.descriptor.sha256}.tar.gz`)throw new Error('Архив каталога должен принадлежать закреплённому GitHub release.');
            const descriptor=artifact.descriptor,previous=hashes.get(descriptor.sha256);
            if(previous&&['compressedBytes','unpackedBytes','filesCount'].some(key=>previous[key]!==descriptor[key]))throw new Error('Один SHA каталога имеет противоречивые размеры.');
            hashes.set(descriptor.sha256,descriptor);
        }
        keys.add(tool.key);names.add(tool.publication.name.toLowerCase());
    }
    return value;
}

/** Архив SHA проверяется для каждой платформенной точки входа, даже при общем файле. */
export async function verifyCatalogRelease({manifest,directory,signal,onProgress=()=>{}}) {
    validateCatalogRelease(manifest);await safeDirectory(directory);
    const artifacts=manifest.tools.flatMap(tool=>tool.artifacts);let completed=0;
    for(const artifact of artifacts) {
        signal?.throwIfAborted();
        const filename=path.join(directory,artifact.descriptor.sha256+'.tar.gz'),info=await lstat(filename);
        if(!info.isFile()||info.isSymbolicLink())throw new Error('Архив каталога должен быть обычным файлом.');
        await inspectRuntimeArchive(filename,artifact.descriptor);
        await onProgress({section:'catalog',stage:'verifying',message:'Проверяем готовые комплекты каталога.',completed:++completed,total:artifacts.length,unit:'files'});
    }
    return {tools:manifest.tools.length,artifacts:new Set(artifacts.map(item=>item.descriptor.sha256)).size};
}

/** Только immutable-кэш: теги моделей, карточки инструментов и база данных не изменяются. */
export async function cacheCatalogRelease({manifest,directory,fetch:request=fetch,signal,onProgress=()=>{},readDisk}) {
    validateCatalogRelease(manifest);await safeDirectory(directory,'',true);
    const artifacts=manifest.tools.flatMap(tool=>tool.artifacts),unique=new Map(artifacts.map(item=>[item.descriptor.sha256,item]));
    const missing=[];
    for(const artifact of unique.values()) {
        signal?.throwIfAborted();
        try {await inspectRuntimeArchive(path.join(directory,artifact.descriptor.sha256+'.tar.gz'),artifact.descriptor);}
        catch(error) {if(error.code!=='ENOENT')throw error;missing.push(artifact);}
    }
    await ensureSpace(directory,missing.reduce((sum,item)=>sum+item.descriptor.compressedBytes,0),readDisk);
    if(!missing.length)return verifyCatalogRelease({manifest,directory,signal,onProgress});
    const staging=await mkdtemp(path.join(directory,'.catalog-download-'));let completed=0;
    const total=missing.reduce((sum,item)=>sum+item.descriptor.compressedBytes,0);
    try {
        for(const artifact of missing) {
            signal?.throwIfAborted();
            const source=path.join(staging,artifact.descriptor.sha256+'.tar.gz'),target=path.join(directory,path.basename(source));
            await downloadPart(artifact.url,source,{sha256:artifact.descriptor.sha256,size:artifact.descriptor.compressedBytes},
                {fetch:request,signal,onBytes:async bytes=>{
                    completed+=bytes;await onProgress({section:'catalog',stage:'downloading',message:'Загружаем готовые комплекты каталога.',completed,total});
                }});
            await inspectRuntimeArchive(source,artifact.descriptor);await chmod(source,0o400);
            try {await link(source,target);} catch(error) {if(error.code!=='EEXIST')throw error;}
            await unlink(source);await inspectRuntimeArchive(target,artifact.descriptor);
            if(process.platform!=='win32') {const folder=await open(directory,'r');try {await folder.sync();} finally {await folder.close();}}
        }
        return verifyCatalogRelease({manifest,directory,signal,onProgress});
    } finally {await rm(staging,{recursive:true,force:true});}
}
