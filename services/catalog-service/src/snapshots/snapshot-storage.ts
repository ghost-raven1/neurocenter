import {ConflictException,ServiceUnavailableException} from '@nestjs/common';
import {Client} from 'minio';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type {Pool,PoolClient} from 'pg';
import {runtimeArtifactDirectory} from '../runtime-artifacts/runtime-artifacts';
import {SNAPSHOT_CHUNK_BYTES} from '../../../shared/project-snapshot.cjs';
import {assertPrivateS3Bucket} from '../../../shared/s3-bucket-privacy.cjs';

const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export interface SnapshotBlob {bytes:string;storage_id:string;version_id:string|null;state:'LIVE'|'DELETING'}
interface WriteIntent {project_id:string;sha256:string;write_id:string;bytes:string;storage_id:string}
export interface SnapshotStorageOptions {directory?:string;s3?:{endpoint:string;bucket:string;region:string;accessKey:string;secretKey:string}}
/** Content addresses are project scoped; reads pin the exact S3 object version and verify bytes. */
export class SnapshotStorage {
    readonly storageId:string;
    private readonly client?:Client;
    private readonly bucket?:string;
    /** A lost rollback acknowledgement makes this owned session unsafe for subsequent pool borrowers. */
    private readonly failedRollbacks=new WeakSet<PoolClient>();
    readonly directory:string;
    constructor(private readonly pool:Pool,options:SnapshotStorageOptions={}){
        this.directory=path.resolve(options.directory||process.env.SNAPSHOT_STORAGE_DIR||path.join(runtimeArtifactDirectory(),'.project-snapshots'));
        const s3=options.s3??(process.env.SNAPSHOT_S3_ENDPOINT?{
            endpoint:process.env.SNAPSHOT_S3_ENDPOINT,bucket:process.env.SNAPSHOT_S3_BUCKET||'',region:process.env.SNAPSHOT_S3_REGION||'us-east-1',
            accessKey:process.env.SNAPSHOT_S3_ACCESS_KEY||'',secretKey:process.env.SNAPSHOT_S3_SECRET_KEY||''}:undefined);
        if(s3){
            const url=new URL(s3.endpoint);
            if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash
                ||!s3.bucket||!s3.accessKey||!s3.secretKey||process.env.NODE_ENV==='production'&&url.protocol!=='https:')throw new Error('Нужна закрытая конфигурация MinIO/S3 для снимков.');
            const transport=url.protocol==='https:'?https:http;
            const request=((...args:Parameters<typeof http.request>)=>{
                const outgoing=transport.request(...args);
                const deadline=setTimeout(()=>outgoing.destroy(new Error('snapshot-s3-deadline')),120000);deadline.unref();
                outgoing.setTimeout(30000,()=>outgoing.destroy(new Error('snapshot-s3-idle')));
                outgoing.once('close',()=>clearTimeout(deadline));return outgoing;
            }) as typeof http.request;
            this.client=new Client({endPoint:url.hostname,port:Number(url.port)||(url.protocol==='https:'?443:80),useSSL:url.protocol==='https:',accessKey:s3.accessKey,secretKey:s3.secretKey,region:s3.region,transport:{request},retryOptions:{maximumRetryCount:1}});
            this.bucket=s3.bucket;this.storageId='s3:'+digest(JSON.stringify([url.origin,s3.bucket])).slice(0,32);
        }else{
            if(process.env.NODE_ENV==='production')throw new ServiceUnavailableException('Настройте закрытое MinIO/S3-хранилище снимков.');
            this.storageId='fs:'+digest(this.directory).slice(0,32);
        }
    }
    private key(project:string,sha:string):string{
        if(!/^[a-f0-9]{64}$/.test(sha)||!project)throw new ConflictException('Некорректный адрес блока снимка.');
        return 'projects/'+digest(project)+'/blobs/'+sha;
    }
    private async folder(project:string):Promise<string>{
        await fs.mkdir(this.directory,{recursive:true,mode:0o700});
        const root=await fs.lstat(this.directory);if(!root.isDirectory()||root.isSymbolicLink())throw new ConflictException('Хранилище снимков заменено.');
        const folder=path.join(this.directory,digest(project));await fs.mkdir(folder,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
        const info=await fs.lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw new ConflictException('Каталог снимков заменён.');return folder;
    }
    private async localRead(project:string,sha:string,size:number):Promise<Buffer>{
        const file=path.join(await this.folder(project),sha),handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try{
            const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size!==size)throw new ConflictException('Размер или тип блока снимка изменился.');
            const bytes=await handle.readFile(),after=await handle.stat();
            if(bytes.length!==size||digest(bytes)!==sha||before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw new ConflictException('Блок снимка повреждён.');return bytes;
        }finally{await handle.close();}
    }
    private async remoteRead(project:string,sha:string,size:number,versionId:string):Promise<Buffer>{
        if(typeof versionId!=='string'||!versionId||versionId==='null'||versionId.length>1024||/[\x00-\x1f\x7f]/.test(versionId))throw new ServiceUnavailableException('Нет точной S3-версии блока снимка.');
        const stream=await this.client!.getObject(this.bucket!,this.key(project,sha),{versionId});const chunks:Buffer[]=[];let received=0;
        const timer=setTimeout(()=>stream.destroy(new Error('Истёк срок чтения блока снимка.')),120000);timer.unref();
        try{for await(const part of stream){const bytes=Buffer.from(part);received+=bytes.length;if(received>size)throw new ConflictException('Блок снимка превышает опись.');chunks.push(bytes);}
            const bytes=Buffer.concat(chunks);if(received!==size||digest(bytes)!==sha)throw new ConflictException('SHA или размер блока снимка не совпал.');return bytes;
        }finally{clearTimeout(timer);stream.destroy();}
    }
    private async privateBucket():Promise<void>{
        if(this.client)try{await assertPrivateS3Bucket(this.client,this.bucket!);}catch{throw new ServiceUnavailableException('Закрытый доступ к хранилищу снимков не подтверждён.');}
    }
    async read(project:string,sha:string):Promise<Buffer>{
        this.key(project,sha);await this.privateBucket();
        const row=(await this.pool.query<SnapshotBlob>('SELECT bytes,storage_id,version_id,state FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2',[project,sha])).rows[0];
        if(!row||row.state!=='LIVE'||row.storage_id!==this.storageId)throw new ServiceUnavailableException('Проверенный блок снимка недоступен в выбранном хранилище.');
        return this.client?this.remoteRead(project,sha,Number(row.bytes),row.version_id!):this.localRead(project,sha,Number(row.bytes));
    }
    async put(project:string,sha:string,bytes:Buffer):Promise<void>{
        this.key(project,sha);
        if(bytes.length<1||bytes.length>SNAPSHOT_CHUNK_BYTES||digest(bytes)!==sha)throw new ConflictException('SHA или размер загружаемого блока не совпал.');
        const connection=await this.pool.connect();
        try{
            await connection.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['neurocenter:snapshot-storage']);
            const existing=(await connection.query<SnapshotBlob>('SELECT bytes,storage_id,version_id,state FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2',[project,sha])).rows[0];
            if(existing){
                if(existing.state!=='LIVE')throw new ConflictException('Предыдущая версия блока очищается. Повторите загрузку после завершения очистки.');
                if(Number(existing.bytes)!==bytes.length||existing.storage_id!==this.storageId)throw new ConflictException('Сохранённая опись блока отличается.');
                await this.privateBucket();
                if(this.client)await this.remoteRead(project,sha,bytes.length,existing.version_id!);else await this.localRead(project,sha,bytes.length);
                return;
            }
            await this.privateBucket();
            let intent=(await connection.query<WriteIntent>('SELECT * FROM project_snapshot_blob_writes WHERE project_id=$1 AND sha256=$2',[project,sha])).rows[0];
            if(intent){this.assertIntent(intent,bytes.length);const recovered=await this.settleWrite(connection,intent);if(recovered==='complete')return;if(recovered==='pending')throw new ServiceUnavailableException('Устраняются лишние версии предыдущей передачи блока. Повторите позже.');}
            const total=Number((await connection.query('SELECT (SELECT COALESCE(sum(bytes),0) FROM project_snapshot_blobs)+(SELECT COALESCE(sum(bytes)*2,0) FROM project_snapshot_blob_writes) AS bytes')).rows[0].bytes);
            const maximum=Number(process.env.SNAPSHOT_STORAGE_MAX_BYTES||256*1024**3);
            if(!Number.isSafeInteger(maximum)||maximum<1||total+(intent?0:bytes.length*2)>maximum)throw new ConflictException('Хранилище снимков достигло лимита. Увеличьте квоту или выполните управляемую очистку.');
            if(!intent){intent={project_id:project,sha256:sha,write_id:randomUUID(),bytes:String(bytes.length),storage_id:this.storageId};await connection.query('INSERT INTO project_snapshot_blob_writes(project_id,sha256,write_id,bytes,storage_id) VALUES($1,$2,$3,$4,$5)',[project,sha,intent.write_id,bytes.length,this.storageId]);}
            let version:string|null=null;
            if(this.client){
                const configuration=await this.client.getBucketVersioning(this.bucket!);
                if(configuration.Status!=='Enabled')throw new ServiceUnavailableException('Для bucket снимков нужно включить S3 versioning.');
                const result=await this.client.putObject(this.bucket!,this.key(project,sha),bytes,bytes.length,{'X-Amz-Meta-Neurocenter-Snapshot-Write':intent.write_id});
                version=result.versionId??null;if(!version||version==='null')throw new ServiceUnavailableException('S3 не подтвердил неизменяемую версию блока.');
                const settled=await this.settleWrite(connection,intent,version);if(settled!=='complete')throw new ServiceUnavailableException('Запись блока ещё не подтверждена. Повторите позже.');return;
            }else{
                const folder=await this.folder(project),disk=await fs.statfs(folder,{bigint:true});
                if(disk.bavail*disk.bsize<BigInt(bytes.length)+BigInt(256*1024**2))throw new ServiceUnavailableException('Недостаточно места для снимка с учётом резерва.');
                const temporary=path.join(folder,'.stage-'+intent.write_id),handle=await fs.open(temporary,'wx',0o600);
                try{await handle.writeFile(bytes);await handle.chmod(0o400);await handle.sync();}finally{await handle.close();}
                try{await fs.link(temporary,path.join(folder,sha));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
                finally{await fs.unlink(temporary);}
                await this.localRead(project,sha,bytes.length);
                const directory=await fs.open(folder,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
            }
            await this.registerWrite(connection,intent,version);
        }finally{
            let discard=this.failedRollbacks.delete(connection);if(!discard)try{await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['neurocenter:snapshot-storage']);}catch{discard=true;}
            connection.release(discard);
        }
    }
    private assertIntent(intent:WriteIntent,size:number):void{
        if(intent.storage_id!==this.storageId||Number(intent.bytes)!==size)throw new ConflictException('Незавершённая запись относится к другой конфигурации хранилища.');
    }
    private async registerWrite(client:PoolClient,intent:WriteIntent,version:string|null):Promise<void>{
        try{await client.query('BEGIN');await client.query('INSERT INTO project_snapshot_blobs(project_id,sha256,bytes,storage_id,version_id) VALUES($1,$2,$3,$4,$5)',[intent.project_id,intent.sha256,intent.bytes,this.storageId,version]);
            await client.query('DELETE FROM project_snapshot_blob_writes WHERE project_id=$1 AND sha256=$2 AND write_id=$3',[intent.project_id,intent.sha256,intent.write_id]);await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK').catch(()=>{this.failedRollbacks.add(client);});throw error;}
    }
    /** The nonce is durable before PUT/link; a lost response never creates an unaccounted object. */
    private async settleWrite(client:PoolClient,intent:WriteIntent,confirmedVersion?:string):Promise<'missing'|'pending'|'complete'>{
        this.assertIntent(intent,Number(intent.bytes));const project=intent.project_id,sha=intent.sha256;
        if(this.client){
            const key=this.key(project,sha),stream=this.client.listObjects(this.bucket!,key,true,{IncludeVersion:true}),versions:string[]=[];let entries=0;
            const timer=setTimeout(()=>stream.destroy(new Error('snapshot-version-list-timeout')),120000);timer.unref();
            try{for await(const raw of stream){const item=raw as {name?:string;versionId?:string;isDeleteMarker?:boolean};
                if(++entries>128)throw new ConflictException('Слишком много версий незавершённого блока.');
                if(item.name!==key||item.isDeleteMarker||!item.versionId||item.versionId==='null')continue;
                const stat=await this.client.statObject(this.bucket!,key,{versionId:item.versionId}),metadata=stat.metaData;
                if(metadata['neurocenter-snapshot-write']===intent.write_id||metadata['x-amz-meta-neurocenter-snapshot-write']===intent.write_id)versions.push(item.versionId);
            }}finally{clearTimeout(timer);stream.destroy();}
            if(!versions.length){if(confirmedVersion)throw new ServiceUnavailableException('S3 не подтвердил версию записанного блока.');return 'missing';}
            const selected=confirmedVersion??versions[0];if(!versions.includes(selected))throw new ServiceUnavailableException('Записанная версия не входит в опись S3.');await this.remoteRead(project,sha,Number(intent.bytes),selected);
            const extra=versions.filter(version=>version!==selected);if(extra.length)await this.client.removeObject(this.bucket!,key,{versionId:extra[0]});
            if(extra.length>1)return 'pending';
            await this.registerWrite(client,intent,selected);return 'complete';
        }
        const folder=await this.folder(project),temporary=path.join(folder,'.stage-'+intent.write_id),filename=path.join(folder,sha);
        try{const info=await fs.lstat(temporary);if(!info.isFile()||info.isSymbolicLink()||info.nlink<1||info.nlink>2)throw new ConflictException('Незавершённый файл снимка заменён.');
            if(info.nlink===2){const target=await fs.lstat(filename);if(target.ino!==info.ino||target.dev!==info.dev)throw new ConflictException('Незавершённая ссылка снимка заменена.');}await fs.unlink(temporary);
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        try{await this.localRead(project,sha,Number(intent.bytes));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error;}
        await this.registerWrite(client,intent,null);return 'complete';
    }
    /** One abandoned write per tick is settled or discarded under the same global fence as all PUTs. */
    async recoverWrite():Promise<boolean>{
        const client=await this.pool.connect();let locked=false,discard=false;
        try{
            try{locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended('neurocenter:snapshot-storage',0)) AS locked")).rows[0].locked;}catch(error){discard=true;throw error;}
            if(!locked)return false;
            const intent=(await client.query<WriteIntent>('SELECT * FROM project_snapshot_blob_writes ORDER BY created_at LIMIT 1')).rows[0];if(!intent)return false;
            await this.privateBucket();
            if(await this.settleWrite(client,intent)==='missing')await client.query('DELETE FROM project_snapshot_blob_writes WHERE project_id=$1 AND sha256=$2 AND write_id=$3',[intent.project_id,intent.sha256,intent.write_id]);return true;
        }finally{
            discard=this.failedRollbacks.delete(client)||discard;if(locked&&!discard)try{await client.query("SELECT pg_advisory_unlock(hashtextextended('neurocenter:snapshot-storage',0))");}catch{discard=true;}
            client.release(discard);
        }
    }
    /** Caller holds the global storage fence and has durably marked this exact version DELETING. */
    async remove(project:string,sha:string,row:SnapshotBlob):Promise<void>{
        this.key(project,sha);
        if(row.state!=='DELETING'||row.storage_id!==this.storageId)throw new ConflictException('Хранилище очищаемого блока изменилось.');
        if(this.client){
            if(!row.version_id||row.version_id==='null')throw new ConflictException('Нет точной S3-версии очищаемого блока.');
            await this.client.removeObject(this.bucket!,this.key(project,sha),{versionId:row.version_id});
        }else{
            const filename=path.join(await this.folder(project),sha);
            let stat;try{stat=await fs.lstat(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
            if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new ConflictException('Очищаемый блок заменён.');
            await fs.unlink(filename);
            const directory=await fs.open(path.dirname(filename),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
        }
    }
}
