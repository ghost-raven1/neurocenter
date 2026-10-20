import {constants} from 'node:fs';
import {lstat,open,writeFile,chmod,link,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {safeDirectory} from '../models/bundle-files.mjs';

/** Immutable SHA-кэш общий для CLI prefetch и серверного импорта; registry не создаётся. */
export class AssetCache {
    constructor(directory){this.directory=directory;}
    file(sha,suffix){if(typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha))throw new Error('Некорректный SHA кэша ассетов.');return path.join(this.directory,sha+suffix);}
    async open(sha,suffix,maximum){
        const filename=this.file(sha,suffix);let handle;
        try{
            await safeDirectory(this.directory);const named=await lstat(filename);
            if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1||named.size>maximum)throw new Error('Небезопасный или слишком большой файл кэша ассетов.');
            handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await handle.stat();
            if(!info.isFile()||info.nlink!==1||info.ino!==named.ino||info.dev!==named.dev||info.size>maximum)throw new Error('Кэш ассетов изменился перед чтением.');
            return {handle,info,filename};
        }catch(error){await handle?.close();if(error.code==='ENOENT')return;throw error;}
    }
    async stable(file){
        const after=await file.handle.stat(),named=await lstat(file.filename),before=file.info;
        if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.nlink!==1||named.ino!==before.ino||named.dev!==before.dev
            ||!named.isFile()||named.isSymbolicLink()||named.nlink!==1)throw new Error('Кэш ассетов изменился во время проверки.');
    }
    async read(sha,maximum){
        const file=await this.open(sha,'.json',maximum);if(!file)return;
        try{const bytes=await file.handle.readFile();await this.stable(file);return bytes;}finally{await file.handle.close();}
    }
    async verify(artifact,signal){
        const file=await this.open(artifact.sha256,'.blob',artifact.bytes);if(!file)return false;
        try{
            const hash=createHash('sha256');let count=0;
            for await(const chunk of file.handle.createReadStream({autoClose:false})){
                signal?.throwIfAborted();count+=chunk.length;if(count>artifact.bytes)throw new Error('Кэш ассета превысил закреплённый размер.');hash.update(chunk);
            }
            await this.stable(file);
            if(count!==artifact.bytes||hash.digest('hex')!==artifact.sha256)throw new Error('SHA или размер кэша ассета не совпал. Повреждённый файл сохранён для проверки.');
            return true;
        }finally{await file.handle.close();}
    }
    /** Create-if-absent не перезаписывает чужую/параллельно опубликованную запись. */
    async publish(temporary,sha,suffix){
        const filename=this.file(sha,suffix);await chmod(temporary,0o400);
        try{await link(temporary,filename);}catch(error){if(error.code!=='EEXIST')throw error;}
        finally{await rm(temporary,{force:true});}
    }
    async write(sha,bytes){
        if(createHash('sha256').update(bytes).digest('hex')!==sha)throw new Error('Metadata не совпала с SHA источника.');
        await safeDirectory(this.directory,'',true);const temporary=path.join(this.directory,'.metadata-'+randomUUID());
        try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await this.publish(temporary,sha,'.json');}
        finally{await rm(temporary,{force:true});}
        const saved=await this.read(sha,bytes.length);
        if(!saved||!saved.equals(bytes))throw new Error('Существующая metadata кэша повреждена; автоматическая подмена запрещена.');
    }
}
