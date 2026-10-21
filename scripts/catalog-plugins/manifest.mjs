import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {validateAsset,toToolPublication,toSkillCreate} from '@neurocenter/asset-contract';
import {assertSupplyLayout,inspectSupplyBytes,supplyFile,toolRuntimePath,toolSourcePath,TOOL_SOURCE_MAX_BYTES} from './supply-layout.mjs';
import {parseSkillSource} from '../../services/shared/skill-source.mjs';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {normalizeRuntimeArtifacts,inspectRuntimeArchive}=require('../shared/runtime-artifacts.cjs');

/** Повтор одной source версии всегда использует тот же native publication intent. */
export function publicationKey(key,version){
    const bytes=createHash('sha256').update(`neurocenter-source-asset\0${key}\0${version}`).digest().subarray(0,16);
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

/** Старый ready/tools manifest не принимается; файл содержит ровно один source envelope. */
export async function readyManifest(filename){
    const absolute=path.resolve(filename),handle=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let asset;
    try{const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size<1||info.size>16*1024*1024)throw new Error('Нужен обычный asset.json до 16 МиБ.');const bytes=await handle.readFile(),after=await handle.stat();if(bytes.length!==info.size||after.mtimeMs!==info.mtimeMs)throw new Error('Asset изменился при чтении.');asset=validateAsset(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
    finally{await handle.close();}
    if(!['mcp','plugin','skill'].includes(asset.kind))throw new Error('Нужен MCP/plugin/skill source asset.');
    const directory=path.dirname(absolute);assertSupplyLayout(asset);const retainedFiles=[];
    const sourceSnapshot=asset.source.type==='archive'?await inspectSupplyBytes(directory,toolSourcePath(asset.source.sha256),asset.source.sha256,TOOL_SOURCE_MAX_BYTES,asset.source.bytes):undefined;
    if(sourceSnapshot)retainedFiles.push(sourceSnapshot);
    const recipe=asset.recipe?await inspectSupplyBytes(directory,asset.recipe.path,asset.recipe.sha256,1024*1024):undefined;if(recipe)retainedFiles.push(recipe);
    if(asset.kind==='skill'){
        if(asset.dependencies?.length||asset.recipe)throw new Error('Локальная публикация принимает самостоятельный inline skill без зависимостей или внешнего рецепта.');
        const publication=toSkillCreate(asset);
        // JSON frontmatter is valid YAML; the shared preflight needs no compiled sibling service.
        const instruction='---\n'+JSON.stringify({...publication.meta,slug:publication.slug})+'\n---\n'+publication.body;
        parseSkillSource([{path:'SKILL.md',content:instruction},...(publication.resources??[])],{name:publication.name,description:publication.meta.description},JSON.parse);
        return [{asset,filename:absolute,key:asset.id,publication:{...publication,kind:'skill',revision:asset.version,publicationKey:publicationKey(asset.id,asset.version)},artifacts:[],retainedFiles,...(sourceSnapshot?{sourceSnapshotPath:sourceSnapshot.archivePath}:{})}];
    }
    const {validatePublication}=require('./dist/publication/publication-validation.js');
    const {assertLocalUiInventory}=require('./dist/publication/publication-runtime.js');
    const publication=validatePublication(toToolPublication(asset)),artifacts=[];
    for(const supplied of asset.delivery.artifacts){
        const [descriptor]=normalizeRuntimeArtifacts([supplied.descriptor]);
        const archivePath=await supplyFile(directory,toolRuntimePath(descriptor.sha256));
        const entries=await inspectRuntimeArchive(archivePath,descriptor);assertLocalUiInventory(publication.config,publication.kind,entries);
        artifacts.push({archivePath,descriptor});
    }
    return [{asset,filename:absolute,key:asset.id,publication:{...publication,publicationKey:publicationKey(asset.id,asset.version)},artifacts,retainedFiles,...(sourceSnapshot?{sourceSnapshotPath:sourceSnapshot.archivePath}:{})}];
}
