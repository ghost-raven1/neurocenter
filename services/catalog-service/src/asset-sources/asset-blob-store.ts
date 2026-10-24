import { ConflictException, NotFoundException } from '@nestjs/common';
import { downloadArtifacts, fetchArtifact, type AssetDescriptor } from '@neurocenter/asset-contract';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { runtimeArtifactDirectory } from '../runtime-artifacts/runtime-artifacts';
import { reserveCapacity } from '../../../shared/capacity.cjs';
import {assetSourceMode} from './source-cache';
import {withImportRegistryTransaction} from '../database/import-registry-transaction';

export interface IAssetBlob { sha256: string; bytes: number; filename: string; target?: string }

/** Серверный кэш поставки; URL upstream остаются только во входной описи и никогда не возвращаются устройству. */
export class AssetBlobStore {
    constructor(private readonly pool: Pool, readonly directory = path.join(runtimeArtifactDirectory(), '.asset-source-blobs'),
        private readonly request: typeof fetch = fetch,private readonly offline=assetSourceMode()==='offline') {}

    private async root(): Promise<void> {
        await fs.mkdir(this.directory, {recursive:true,mode:0o700});
        const info = await fs.lstat(this.directory);
        if (!info.isDirectory() || info.isSymbolicLink()) { throw new ConflictException('Хранилище поставки заменено посторонним путём.'); }
    }

    private filename(sha: string): string {
        if (!/^[a-f0-9]{64}$/.test(sha)) { throw new ConflictException('Некорректный SHA-256 файла поставки.'); }
        return path.join(this.directory,sha+'.blob');
    }

    private async checked(sha: string, bytes: number, signal?:AbortSignal): Promise<fs.FileHandle> {
        signal?.throwIfAborted();
        const handle = await fs.open(this.filename(sha), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const before = await handle.stat();
            if (!before.isFile() || before.nlink !== 1 || before.size !== bytes) { throw new ConflictException('Размер или тип файла поставки изменился.'); }
            const digest = createHash('sha256'); let readBytes = 0;
            for await (const chunk of handle.createReadStream({autoClose:false,signal})) {
                signal?.throwIfAborted();
                readBytes += chunk.length;
                if (readBytes > bytes) { throw new ConflictException('Файл поставки изменился во время чтения.'); }
                digest.update(chunk);
            }
            const after = await handle.stat();
            signal?.throwIfAborted();
            if (digest.digest('hex') !== sha || before.dev !== after.dev || before.ino !== after.ino
                || before.size !== after.size || before.mtimeMs !== after.mtimeMs) { throw new ConflictException('SHA-256 или состояние файла поставки изменилось.'); }
            return handle;
        } catch (error) { await handle.close(); throw error; }
    }

    /** Незавершённые файлы собственного задания удаляются перед повтором; проверенные SHA-файлы сохраняются. */
    async importAsset(asset: AssetDescriptor, requestKey: string, signal: AbortSignal,cacheOnly=false): Promise<IAssetBlob[]> {
        if (!/^[a-f0-9-]{36}$/.test(requestKey)) { throw new ConflictException('Некорректное задание поставки.'); }
        const all = downloadArtifacts(asset), unique = new Map<string,typeof all[number]>();
        for (const artifact of all) {
            const previous = unique.get(artifact.sha256);
            if (previous && previous.bytes !== artifact.bytes) { throw new ConflictException('Один SHA-256 имеет разные размеры в описи.'); }
            unique.set(artifact.sha256,artifact);
        }
        if (!all.length) { return []; }
        await this.root();
        const missing:typeof all=[];
        for(const artifact of unique.values()){
            signal.throwIfAborted();
            try{const handle=await this.checked(artifact.sha256,artifact.bytes);await handle.close();}
            catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing.push(artifact);}
        }
        if((this.offline||cacheOnly)&&missing.length)throw new ConflictException('Файлы выбранного ассета отсутствуют в локальной поставке. Перенесите архив с файлами этого ассета. Сетевое скачивание для этого импорта отключено.');
        const stage = path.join(this.directory,'.stage-'+requestKey);
        try {
            const previous = await fs.lstat(stage);
            if (!previous.isDirectory() || previous.isSymbolicLink()) { throw new ConflictException('Временный каталог поставки заменён посторонним путём.'); }
            await fs.rm(stage,{recursive:true});
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        await fs.mkdir(stage,{mode:0o700});
        let release: () => void = () => undefined;
        try {
            release = await reserveCapacity({resource:'runtime-artifacts',bytes:missing.reduce((sum,file)=>sum+file.bytes,0),path:this.directory});
            for (const artifact of missing) {
                signal.throwIfAborted();
                const temporary = path.join(stage,artifact.sha256);
                await fetchArtifact(artifact,temporary,{fetch:this.request,signal});
                await fs.chmod(temporary,0o400);
                try { await fs.link(temporary,this.filename(artifact.sha256)); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
                await fs.unlink(temporary);
                const handle = await this.checked(artifact.sha256,artifact.bytes); await handle.close();
            }
            if (process.platform !== 'win32') {
                const directory = await fs.open(this.directory,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                try { await directory.sync(); } finally { await directory.close(); }
            }
            for (const artifact of unique.values()) {
                signal.throwIfAborted();
                await this.pool.query('INSERT INTO asset_source_blobs(sha256,bytes) VALUES($1,$2) ON CONFLICT(sha256) DO NOTHING',[artifact.sha256,artifact.bytes]);
                const {rows} = await this.pool.query<{bytes:string}>('SELECT bytes FROM asset_source_blobs WHERE sha256=$1',[artifact.sha256]);
                if (Number(rows[0]?.bytes) !== artifact.bytes) { throw new ConflictException('Сохранённая опись SHA-файла отличается от поставки.'); }
            }
            return all.map(({sha256,bytes,filename,target})=>({sha256,bytes,filename,...(target?{target}:{})}));
        } finally { release(); await fs.rm(stage,{recursive:true,force:true}); }
    }

    async checkedPath(sha:string,bytes:number,signal?:AbortSignal):Promise<string> {
        const handle=await this.checked(sha,bytes,signal);await handle.close();signal?.throwIfAborted();return this.filename(sha);
    }

    /** Fast list preflight only; import and serving always repeat full SHA verification. */
    async hasLocalCandidate(sha:string,bytes:number):Promise<boolean>{
        let handle:fs.FileHandle|undefined;
        try{
            if(!Number.isSafeInteger(bytes)||bytes<1)return false;
            const root=await fs.lstat(this.directory);if(!root.isDirectory()||root.isSymbolicLink())return false;
            const filename=this.filename(sha);handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
            const info=await handle.stat(),named=await fs.lstat(filename),after=await fs.lstat(this.directory);
            return info.isFile()&&info.nlink===1&&info.size===bytes&&!named.isSymbolicLink()&&named.dev===info.dev&&named.ino===info.ino&&root.dev===after.dev&&root.ino===after.ino&&!after.isSymbolicLink();
        }catch{return false;}finally{await handle?.close();}
    }

    /** Локальная сборка проходит ту же SHA-проверку до записи native card; исходный путь не становится URL. */
    async ingestLocal(files:Array<IAssetBlob&{archivePath:string}>,requestKey:string,signal?:AbortSignal):Promise<IAssetBlob[]> {
        signal?.throwIfAborted();
        if(!/^[a-f0-9-]{36}$/.test(requestKey)||files.length>12)throw new ConflictException('Некорректная локальная поставка.');
        for(const file of files){this.filename(file.sha256);if(!Number.isSafeInteger(file.bytes)||file.bytes<1)throw new ConflictException('Некорректный размер локального архива.');}
        await this.root();
        const stage=await fs.mkdtemp(path.join(this.directory,'.local-'+requestKey+'-'));
        let release=()=>undefined as void;
        try{
            const unique=new Map<string,typeof files[number]>(),missing:typeof files=[];
            for(const file of files){
                if(unique.has(file.sha256)&&unique.get(file.sha256)!.bytes!==file.bytes)throw new ConflictException('Один SHA имеет разные размеры.');
                unique.set(file.sha256,file);
            }
            for(const file of unique.values()){
                signal?.throwIfAborted();
                try{await this.checkedPath(file.sha256,file.bytes,signal);}
                catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing.push(file);}
            }
            release=await reserveCapacity({resource:'runtime-artifacts',bytes:missing.reduce((sum,file)=>sum+file.bytes,0),path:this.directory});
            for(const file of missing){
                signal?.throwIfAborted();
                const input=await fs.open(file.archivePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
                try{
                    const before=await input.stat();
                    if(!before.isFile()||before.nlink!==1||before.size!==file.bytes)throw new ConflictException('Исходный архив заменён или имеет другой размер.');
                    const temporary=path.join(stage,file.sha256),output=await fs.open(temporary,'wx',0o600),hash=createHash('sha256');let bytes=0;
                    try{
                        for await(const chunk of input.createReadStream({autoClose:false,signal})){
                            signal?.throwIfAborted();
                            bytes+=chunk.length;if(bytes>file.bytes)throw new ConflictException('Архив вырос во время чтения.');
                            hash.update(chunk);await output.writeFile(chunk);
                        }
                        const after=await input.stat();
                        signal?.throwIfAborted();
                        if(bytes!==file.bytes||hash.digest('hex')!==file.sha256||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new ConflictException('SHA-256 локального архива не подтверждён.');
                        await output.chmod(0o400);await output.sync();
                    }finally{await output.close();}
                    signal?.throwIfAborted();
                    try{await fs.link(temporary,this.filename(file.sha256));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
                    await fs.unlink(temporary);await this.checkedPath(file.sha256,file.bytes,signal);
                }finally{await input.close();}
            }
            if(process.platform!=='win32'){const directory=await fs.open(this.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}}
            await withImportRegistryTransaction(this.pool,signal,async client=>{for(const file of files){
                signal?.throwIfAborted();
                await client.query('INSERT INTO asset_source_blobs(sha256,bytes) VALUES($1,$2) ON CONFLICT(sha256) DO NOTHING',[file.sha256,file.bytes]);
                signal?.throwIfAborted();
                const saved=await client.query<{bytes:string}>('SELECT bytes FROM asset_source_blobs WHERE sha256=$1',[file.sha256]);
                if(Number(saved.rows[0]?.bytes)!==file.bytes)throw new ConflictException('Опись локального SHA уже имеет другой размер.');
            }});
            signal?.throwIfAborted();
            return files.map(({sha256,bytes,filename,target})=>({sha256,bytes,filename,...(target?{target}:{})}));
        }finally{release();await fs.rm(stage,{recursive:true,force:true});}
    }

    /** Только внутренний контроллер с авторизацией открывает зарегистрированный SHA, проверив его фактические байты. */
    async open(sha: string,signal?:AbortSignal): Promise<{stream:ReturnType<fs.FileHandle['createReadStream']>;bytes:number;sha256:string}> {
        signal?.throwIfAborted();
        const {rows} = await this.pool.query<{bytes:string}>('SELECT bytes FROM asset_source_blobs WHERE sha256=$1',[sha]);
        if (!rows[0]) { throw new NotFoundException('Файл поставки ещё не импортирован.'); }
        let handle: fs.FileHandle;
        try { handle = await this.checked(sha,Number(rows[0].bytes),signal); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { throw new NotFoundException('Файл поставки недоступен в хранилище.'); }
            throw error;
        }
        return {stream:handle.createReadStream({start:0,autoClose:true}),bytes:Number(rows[0].bytes),sha256:sha};
    }
}
