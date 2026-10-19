import {constants,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,lstat,open,readFile,writeFile,rm,unlink} from 'node:fs/promises';
import path from 'node:path';
import {MAX_PART_BYTES,lockedFiles,modelLocks,releaseBaseUrl,validateModelBundle} from './bundle-manifest.mjs';
import {safeDirectory,verifyFile,promote,ensureSpace,downloadPart} from './bundle-files.mjs';

/** Пакуются только публичные закреплённые blobs; ключи Ollama и прочие файлы каталога не читаются. */
export async function packModelBundle({directory,output,baseUrl,locks,partBytes=MAX_PART_BYTES}) {
    locks??=await modelLocks();const expected=lockedFiles(locks);
    if(!Number.isSafeInteger(partBytes)||partBytes<1||partBytes>MAX_PART_BYTES)throw new Error('Недопустимый размер части поставки.');
    directory=await safeDirectory(directory);
    output=path.resolve(output);await safeDirectory(path.dirname(output));
    for(const [filename,file] of expected) {
        await safeDirectory(directory,path.posix.dirname(filename));
        if(file.manifest) {
            const info=await lstat(path.join(directory,filename));if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024)throw new Error('Некорректный локальный манифест модели.');
            file.size=info.size;
        }
        if(!await verifyFile(path.join(directory,filename),file))throw new Error('Закреплённая модель отсутствует в проекте.');
    }
    const url=releaseBaseUrl(baseUrl);await mkdir(output,{mode:0o700});
    const manifest={schemaVersion:1,kind:'neurocenter-model-bundle',releaseBaseUrl:url,files:[]};
    try {
        for(const [filename,file] of [...expected].sort(([a],[b])=>a.localeCompare(b))) {
            if(file.manifest) {
                const bytes=await readFile(path.join(directory,filename));
                manifest.files.push({path:filename,size:bytes.length,sha256:file.sha256,inlineBase64:bytes.toString('base64')});continue;
            }
            const parts=[],complete=createHash('sha256');let offset=0;
            while(offset<file.size) {
                const size=Math.min(partBytes,file.size-offset),name=`model-${file.sha256}-${String(parts.length+1).padStart(3,'0')}.bin`;
                const target=await open(path.join(output,name),'wx',0o600),hash=createHash('sha256');let received=0;
                try {
                    for await(const bytes of createReadStream(path.join(directory,filename),{start:offset,end:offset+size-1,flags:constants.O_RDONLY|constants.O_NOFOLLOW})) {
                        received+=bytes.length;hash.update(bytes);complete.update(bytes);await target.writeFile(bytes);
                    }
                    if(received!==size)throw new Error('Файл модели изменился при упаковке.');await target.sync();
                } finally {await target.close();}
                parts.push({name,size,sha256:hash.digest('hex')});offset+=size;
            }
            if(complete.digest('hex')!==file.sha256)throw new Error('SHA файла модели изменился при упаковке.');
            manifest.files.push({path:filename,size:file.size,sha256:file.sha256,parts});
        }
        validateModelBundle(manifest,locks);
        await writeFile(path.join(output,'bundle-release.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
        return manifest;
    } catch(error) {await rm(output,{recursive:true,force:true});throw error;}
}

async function assemble(parts,filename,expected,onBytes,verification) {
    const output=await open(filename,'wx',0o600);
    try {
        for(const source of parts)for await(const bytes of createReadStream(source,{flags:constants.O_RDONLY|constants.O_NOFOLLOW})) {
            await output.writeFile(bytes);await onBytes(bytes.length);
        }
        await output.sync();
    } finally {await output.close();}
    if(!await verifyFile(filename,expected,verification))throw new Error('Не удалось собрать файл модели.');
}

/** Счётчик отражает прочитанные или записанные байты конкретной стадии, а не прошедшее время. */
function byteProgress(onProgress,stage,message,total) {
    let completed=0;
    return async bytes=>{completed+=bytes;await onProgress({stage,message,completed,total});};
}

/** Очистка общего immutable-кэша другим импортом допускает ограниченный повтор с полной проверкой. */
export async function hydrateModelBundle(options) {
    const cache=path.join(path.resolve(options.directory),'.bundle-cache')+path.sep;
    for(let attempt=0;attempt<3;attempt++) {
        try {return await hydrateOnce(options);} catch(error) {
            if(options.verifyOnly||attempt===2||error.code!=='ENOENT'||!['open','link','lstat','unlink'].includes(error.syscall)
                ||typeof error.path!=='string'||!path.resolve(error.path).startsWith(cache))throw error;
            options.signal?.throwIfAborted();
        }
    }
}

/** Кэш предзагрузки не активирует теги; готовые файлы публикуются без перезаписи и только после SHA. */
async function hydrateOnce({directory,manifest,locks,downloadOnly=false,verifyOnly=false,fetch:request=fetch,signal,onProgress=()=>{},readDisk}) {
    locks??=await modelLocks();validateModelBundle(manifest,locks);
    if(downloadOnly&&verifyOnly)throw new Error('Выберите один режим поставки моделей.');
    directory=await safeDirectory(directory,'',!verifyOnly);
    const report={ok:true,downloadOnly,verifyOnly,models:locks.length,files:manifest.files.length,bytes:manifest.files.reduce((sum,file)=>sum+file.size,0)};
    const blobs=manifest.files.filter(file=>file.parts),tags=manifest.files.filter(file=>file.inlineBase64);
    await onProgress({stage:'inspecting',message:'Проверяем наличие закреплённых файлов моделей.',completed:0,total:manifest.files.length,unit:'files'});
    const checked=byteProgress(onProgress,'verifying','Проверяем SHA-256 существующих файлов моделей.',report.bytes);
    await checked(0);
    const present=new Set();
    for(const file of manifest.files) {
        const relative=path.posix.dirname(file.path);let parent=true;
        try {await safeDirectory(directory,relative);} catch(error) {if(error.code==='ENOENT')parent=false;else throw error;}
        if(parent&&await verifyFile(path.join(directory,file.path),file,{onBytes:checked}))present.add(file.path);
        else if(verifyOnly)throw new Error('В проекте отсутствует часть закреплённого комплекта моделей.');
    }
    const ready=()=>onProgress({stage:'ready',message:downloadOnly?'Предзагрузка закреплённых моделей завершена.':'Все закреплённые модели находятся в проекте.',completed:report.bytes,total:report.bytes});
    if(verifyOnly||present.size===manifest.files.length) {await ready();return report;}
    await safeDirectory(directory,'.bundle-cache/parts',true);await safeDirectory(directory,'.bundle-cache/blobs',true);
    const missingBytes=blobs.filter(file=>!present.has(file.path)).reduce((sum,file)=>sum+file.size,0);
    const checkedCache=byteProgress(onProgress,'verifying','Проверяем SHA-256 подготовленного кэша моделей.',missingBytes);
    await checkedCache(0);
    const cached=new Map();let required=0,largest=0;
    for(const file of blobs) {
        if(present.has(file.path))continue;
        const cache=path.join(directory,'.bundle-cache/blobs',file.sha256);
        if(await verifyFile(cache,file,{onBytes:checkedCache}))cached.set(file.path,cache);
        else {required+=file.size;largest=Math.max(largest,file.size);}
    }
    await ensureSpace(directory,required?required+largest:0,readDisk);
    const staging=await mkdtemp(path.join(directory,'.bundle-cache/stage-'));
    const obtained=byteProgress(onProgress,'downloading','Подготавливаем части моделей: загрузка и проверенный кэш.',required);
    const assembled=byteProgress(onProgress,'assembling','Собираем файлы моделей из проверенных частей.',required);
    const activated=byteProgress(onProgress,'activating','Активируем проверенные файлы моделей.',missingBytes+tags.filter(file=>!present.has(file.path)).reduce((sum,file)=>sum+file.size,0));
    try {
        for(const file of blobs) {
            signal?.throwIfAborted();
            if(present.has(file.path)||cached.has(file.path))continue;
            const parts=[];
            for(const part of file.parts) {
                signal?.throwIfAborted();
                const cache=path.join(directory,'.bundle-cache/parts',part.sha256);
                const checkedPart=byteProgress(onProgress,'verifying','Проверяем SHA-256 части модели в кэше.',part.size);
                if(!await verifyFile(cache,part,{onBytes:checkedPart})) {
                    await obtained(0);
                    const temporary=path.join(staging,part.name);
                    await downloadPart(manifest.releaseBaseUrl+'/'+part.name,temporary,part,{fetch:request,signal,onBytes:async bytes=>{
                        await ensureSpace(directory,64*1024**2,readDisk);await obtained(bytes);
                    }});
                    const checkedPart=byteProgress(onProgress,'verifying','Проверяем SHA-256 загруженной части модели.',part.size);
                    await checkedPart(0);await promote(temporary,cache,part,{onBytes:checkedPart});
                } else await obtained(part.size);
                parts.push(cache);
            }
            const temporary=path.join(staging,file.sha256);
            await ensureSpace(directory,file.size,readDisk);
            await assembled(0);
            const checkedBlob=byteProgress(onProgress,'verifying','Проверяем SHA-256 собранного файла модели.',file.size);
            await assemble(parts,temporary,file,assembled,{onBytes:checkedBlob});
            const cache=path.join(directory,'.bundle-cache/blobs',file.sha256);
            const checkedPublication=byteProgress(onProgress,'verifying','Проверяем SHA-256 файла модели в кэше.',file.size);
            await promote(temporary,cache,file,{onBytes:checkedPublication});cached.set(file.path,cache);
            // Удаляются только собственные проверенные части после успешной сборки полного SHA-файла.
            for(const part of new Set(parts))try {await unlink(part);} catch(error) {if(error.code!=='ENOENT')throw error;}
        }
        if(downloadOnly) {await ready();return report;}
        await activated(0);
        for(const file of blobs) {
            if(present.has(file.path))continue;
            await safeDirectory(directory,path.posix.dirname(file.path),true);
            await promote(cached.get(file.path),path.join(directory,file.path),file,{onBytes:activated});
        }
        // До этого момента Ollama не видит новых тегов и продолжает использовать прежний комплект.
        for(const file of tags) {
            if(present.has(file.path))continue;
            await safeDirectory(directory,path.posix.dirname(file.path),true);
            const temporary=path.join(staging,file.sha256+'.manifest');
            const handle=await open(temporary,'wx',0o600);
            try {await handle.writeFile(Buffer.from(file.inlineBase64,'base64'));await handle.sync();} finally {await handle.close();}
            await promote(temporary,path.join(directory,file.path),file,{onBytes:activated});
        }
        await ready();
        return report;
    } finally {await rm(staging,{recursive:true,force:true});}
}

export async function readModelBundle(filename) {
    filename=path.resolve(filename);await safeDirectory(path.dirname(filename));
    const info=await lstat(filename);
    if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024)throw new Error('Нужен небольшой обычный файл описи моделей.');
    return JSON.parse(await readFile(filename,'utf8'));
}
