import {constants} from 'node:fs';
import {open,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {modelLocks,validateModelBundle} from './bundle-manifest.mjs';
import {safeDirectory,verifyFile,ensureSpace,promote} from './bundle-files.mjs';
import {preflightModelDirectories} from './bundle-preflight.mjs';

async function verifiedFile(directory,relative,file,signal,onBytes) {
    try {await safeDirectory(directory,path.posix.dirname(relative));} catch(error) {if(error.code==='ENOENT')return false;throw error;}
    const filename=path.join(directory,relative);
    return await verifyFile(filename,file,{onBytes:async bytes=>{signal?.throwIfAborted();await onBytes(bytes);}})?filename:false;
}

async function copyBlob(source,target,file,{signal,onBytes,readDisk,directory}) {
    const input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let output;
    try {
        const before=await input.stat();
        if(!before.isFile()||before.size!==file.size)throw new Error('Файл предзагрузки изменился перед копированием.');
        output=await open(target,'wx',0o600);let size=0,spaceChecked=0;
        for await(const chunk of input.createReadStream({autoClose:false})) {
            signal?.throwIfAborted();size+=chunk.length;
            if(size>file.size)throw new Error('Файл предзагрузки изменился во время копирования.');
            await output.writeFile(chunk);await onBytes(chunk.length);
            if(size-spaceChecked>=64*1024**2) {await ensureSpace(directory,64*1024**2,readDisk);spaceChecked=size;}
        }
        const after=await input.stat();
        if(size!==file.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Файл предзагрузки изменился во время копирования.');
        await output.sync();
    } finally {await output?.close();await input.close();}
    if(!await verifyFile(target,file,{onBytes:()=>signal?.throwIfAborted()}))throw new Error('Копия предзагруженной модели не прошла SHA-256.');
}

/** Read-only предзагрузка переносит только SHA-blobs; теги, ключи и квитанции источника не читаются. */
export async function copyPrefetchedModels({source,directory,manifest,locks,signal,onProgress=()=>{},readDisk}={}) {
    locks??=await modelLocks();validateModelBundle(manifest,locks);signal?.throwIfAborted();
    source=path.resolve(source);directory=path.resolve(directory);
    const available=[],blobs=manifest.files.filter(item=>item.parts),verificationBytes=blobs.reduce((sum,file)=>sum+file.size,0);let verified=0;
    const checking=async bytes=>{
        verified+=bytes;await onProgress({stage:'verifying',message:'Проверяем локальный кэш предзагрузки моделей.',completed:verified,total:verificationBytes});
    };
    await checking(0);
    for(const file of blobs) {
        signal?.throwIfAborted();
        const cached='.bundle-cache/blobs/'+file.sha256;
        if(await verifiedFile(directory,file.path,file,signal,checking)||await verifiedFile(directory,cached,file,signal,checking))continue;
        const filename=await verifiedFile(source,file.path,file,signal,checking)||await verifiedFile(source,cached,file,signal,checking);
        if(filename)available.push({filename,file});
    }
    const total=available.reduce((sum,item)=>sum+item.file.size,0),report={copied:0,bytes:0};
    if(!available.length)return report;
    await safeDirectory(directory,'',true);await ensureSpace(directory,total,readDisk);
    await preflightModelDirectories(directory,['.bundle-cache/blobs']);
    const staging=await mkdtemp(path.join(directory,'.bundle-cache/prefetch-'));let completed=0;
    try {
        for(const {filename,file} of available) {
            signal?.throwIfAborted();
            const temporary=path.join(staging,file.sha256);
            await copyBlob(filename,temporary,file,{signal,readDisk,directory,onBytes:async bytes=>{
                completed+=bytes;await onProgress({stage:'copying',message:'Копируем проверенные веса из предзагрузки в том моделей.',completed,total});
            }});
            signal?.throwIfAborted();await promote(temporary,path.join(directory,'.bundle-cache/blobs',file.sha256),file);
            report.copied++;report.bytes+=file.size;
        }
        return report;
    } finally {await rm(staging,{recursive:true,force:true});}
}
