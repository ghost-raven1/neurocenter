import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {walkFiles} from './upstream/dist/content/reader.js';
import {createExcludeMatcher,createIncludeMatcher} from './upstream/dist/core/exclude.js';
import {normalizeExtensionKey} from './upstream/dist/core/parser-overrides.js';
import {findConfigFile} from './upstream/dist/core/config.js';
import {checkedWorkspacePath} from './rag-context.mjs';

const identity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');
const changed=()=>new Error('Исходные файлы изменились во время переиндексации. Прежний индекс сохранён. Повторите подключение.');
/** Exact upstream selection, fail-closed walk limits, bounded raw reads and metadata guards. */
export async function reindexSourceSnapshot(root,config,{maxDirs=10000,maxFiles=100000}={}){
    const extensions=new Set(config.indexing.includeExtensions);
    for(const raw of Object.keys(config.chunking?.parsers??{})){const key=normalizeExtensionKey(raw);if(key)extensions.add(key);}
    const logger={warn:()=>{throw new Error('Сканирование достигло лимита файлов или папок. Сузьте область индексации и повторите подключение.');}};
    const files=await walkFiles(root,extensions,createExcludeMatcher(config.indexing.excludeDirs),createExcludeMatcher(config.indexing.excludeFiles??[]),
        createIncludeMatcher(config.indexing.includeDirs??[]),root,logger,{value:0},maxDirs,maxFiles);
    const configuration=findConfigFile(root);if(configuration&&!files.includes(configuration))files.push(configuration);
    files.sort();const digest=createHash('sha256'),observed=[];
    for(const file of files){
        await checkedWorkspacePath(root,file);const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{
            const before=await handle.stat({bigint:true});if(!before.isFile())throw changed();
            const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:64*1024}))hash.update(chunk);
            const stamp=identity(before);
            if(identity(await handle.stat({bigint:true}))!==stamp||identity(await fs.lstat(file,{bigint:true}))!==stamp)throw changed();
            digest.update(JSON.stringify([path.relative(root,file).split(path.sep).join('/'),stamp,hash.digest('hex')])+'\n');observed.push([file,stamp]);
        }finally{await handle.close();}
    }
    for(const [file,stamp] of observed)if(identity(await fs.lstat(file,{bigint:true}))!==stamp)throw changed();
    return digest.digest('hex');
}
