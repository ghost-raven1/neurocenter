import {ensureCatalogSchema} from '../database/catalog-schema';
import {createPool} from '../database/pool';
import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { AccessDb } from '../access/access-db';
import { runAllBackups } from '../catalog/backup';
import {backupDirectory,backupFailure} from './backup-policy';

interface IProjectBackup { id:string; projectId:string; fileName:string; sizeBytes:number; createdAt:string; databaseName:string;warnings?:string[] }

/** Дампы знаний проекта хранятся отдельно от каталога и резервных копий других проектов. */
@Injectable()
export class ProjectBackupService implements OnModuleInit,OnModuleDestroy {
    private readonly pool=createPool({connectionString:process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',max:2},'backups');
    constructor(private readonly users:AccessDb) {}
    async onModuleInit():Promise<void> {
        await ensureCatalogSchema(this.pool);
    }
    async onModuleDestroy():Promise<void> { await this.pool.end(); }
    async projectId(key:string):Promise<string> {
        const project=(await this.users.projects()).find(item=>item.id===key || !key.startsWith('prj-')&&item.name===key);
        if (!project) { throw new NotFoundException('Проект не найден.'); } return project.id;
    }
    private directory(projectId:string):string {
        const safe=createHash('sha256').update(projectId).digest('hex').slice(0,32);
        return path.join(backupDirectory(),'projects',safe);
    }
    private async availableFile(projectId:string,backup:Pick<IProjectBackup,'fileName'|'sizeBytes'>):Promise<boolean> {
        try {
            if(path.basename(backup.fileName)!==backup.fileName||!backup.fileName.endsWith('.dump'))return false;
            const info=await lstat(path.join(this.directory(projectId),backup.fileName));
            return info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size===backup.sizeBytes;
        }catch(error){
            if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
            throw backupFailure('BACKUP_STORAGE_UNAVAILABLE','Не удалось проверить файлы резервных копий. Обновите список после восстановления хранилища.',503);
        }
    }
    async list(key:string):Promise<IProjectBackup[]> {
        const id=await this.projectId(key);
        const {rows}=await this.pool.query(`SELECT id,project_id AS "projectId",file_name AS "fileName",database_name AS "databaseName",size_bytes::float8 AS "sizeBytes",created_at AS "createdAt" FROM project_backups WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,[id]);
        const results:IProjectBackup[]=[];
        for (const backup of rows as IProjectBackup[])if(await this.availableFile(id,backup))results.push(backup);
        return results;
    }
    async create(key:string):Promise<IProjectBackup> {
        const id=await this.projectId(key);
        const base=(process.env.RAG_SERVICE_URL || 'http://localhost:4300').replace(/\/$/,'');
        const response=await fetch(`${base}/api/rag/database?projectKey=${encodeURIComponent(id)}`,{headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN || ''},signal:AbortSignal.timeout(5000)})
            .catch(()=>{throw backupFailure('BACKUP_DATABASE_UNAVAILABLE','База знаний проекта недоступна. Повторите после восстановления соединения.',503);});
        if (!response.ok) { throw backupFailure('BACKUP_DATABASE_UNAVAILABLE','Не удалось определить базу знаний проекта. Предыдущие копии сохранены.',503); }
        const {databaseName}=await response.json() as {databaseName:string};
        if (!/^nc_rag_[a-f0-9]{32}$/.test(databaseName)) { throw new Error('Каталог баз вернул некорректное имя.'); }
        const url=new URL(process.env.RAG_PG_URL || 'postgresql://rag:rag@localhost:5432/rag'); url.pathname=`/${databaseName}`;
        let backup!:IProjectBackup;
        const result=await runAllBackups({project:url.toString()},this.directory(id),{rootDirectory:backupDirectory(),confirm:async made=>{
            const file=made.files[0];backup={id:randomUUID(),projectId:id,fileName:path.basename(file.file),databaseName,sizeBytes:file.sizeBytes,createdAt:made.backupAt};
            const saved=await this.pool.query('INSERT INTO project_backups (id,project_id,file_name,database_name,size_bytes) VALUES ($1,$2,$3,$4,$5) RETURNING created_at',[backup.id,id,backup.fileName,databaseName,backup.sizeBytes]);
            backup.createdAt=new Date(saved.rows[0].created_at).toISOString();
        },afterPrune:async files=>{await this.pool.query('DELETE FROM project_backups WHERE project_id=$1 AND file_name=ANY($2::text[])',[id,files.map(file=>path.basename(file))]);}});
        if(result.warnings?.length){backup.warnings=result.warnings;}
        return backup;
    }
    async file(key:string,backupId:string):Promise<{file:string;name:string}> {
        const id=await this.projectId(key);
        const {rows}=await this.pool.query<Pick<IProjectBackup,'fileName'|'sizeBytes'>>(`SELECT file_name AS "fileName",size_bytes::float8 AS "sizeBytes"
            FROM project_backups WHERE project_id=$1 AND id=$2`,[id,backupId]);
        const backup=rows[0];
        if (!backup||!await this.availableFile(id,backup)) { throw new NotFoundException('Резервная копия проекта не найдена или уже удалена по сроку хранения.'); }
        return {file:path.join(this.directory(id),backup.fileName),name:backup.fileName};
    }
}
