import {constants,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {readModelBundle} from './bundle.mjs';
import {validateModelBundle} from './bundle-manifest.mjs';
import {safeDirectory,verifyFile} from './bundle-files.mjs';

/** Повтор --publish использует проверенную упаковку, без ещё одной копии многогигабайтных весов. */
export async function readPreparedSupply({output,registry,lock,locks,baseUrl}) {
    try {await lstat(output);} catch(error) {if(error.code==='ENOENT')return null;throw error;}
    await safeDirectory(output);
    for(const [name,value] of [['model-registry.json',registry],['model.lock.json',lock]]) {
        const filename=path.join(output,name),info=await lstat(filename);
        if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024
            ||JSON.stringify(JSON.parse(await readFile(filename,'utf8')))!==JSON.stringify(value))throw new Error('Подготовленная поставка относится к другой модели или версии реестра. Укажите новый --output.');
    }
    const manifest=await readModelBundle(path.join(output,'bundle-release.json'));validateModelBundle(manifest,locks);
    if(manifest.releaseBaseUrl!==baseUrl)throw new Error('Подготовленная поставка относится к другому release. Укажите новый --output.');
    for(const file of manifest.files.filter(file=>file.parts)) {
        const complete=createHash('sha256');
        for(const part of file.parts) {
            const filename=path.join(output,part.name);
            if(!await verifyFile(filename,part))throw new Error('В подготовленной поставке отсутствует часть модели.');
            for await(const bytes of createReadStream(filename,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}))complete.update(bytes);
        }
        if(complete.digest('hex')!==file.sha256)throw new Error('SHA модели в подготовленной поставке не совпал с lock.');
    }
    return manifest;
}
