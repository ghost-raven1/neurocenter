import { ConflictException,NotFoundException,ServiceUnavailableException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {createPool} from '../database/pool';
import { RagDb } from './rag-db';
import {reserveCapacity,recordCapacityQueue} from '../../../shared/capacity.cjs';
import {DatabaseLifecycle} from '../retired-databases/database-lifecycle';
import {databaseLock,LIFECYCLE_LOCK} from '../retired-databases/lifecycle-schema';
import {projectDatabaseName} from './project-database-name';
export {projectDatabaseName} from './project-database-name';

interface IProjectRef { id:string; name:string }
interface ICacheEntry { db:RagDb; used:number; active:number }

/** Отдельные PostgreSQL-базы проектов с ограниченным числом открытых пулов. */
@Injectable()
export class ProjectDatabases implements OnModuleInit, OnModuleDestroy {
    private readonly baseUrl=process.env.RAG_PG_URL || 'postgresql://rag:rag@localhost:5432/rag';
    private readonly admin=createPool({connectionString:this.baseUrl,max:2},'rag-admin');
    private readonly provisioner=process.env.RAG_PROVISION_PG_URL?createPool({connectionString:process.env.RAG_PROVISION_PG_URL,max:1},'rag-provisioner'):this.admin;
    private readonly migrationSource=new RagDb({url:this.baseUrl,scope:'base'});
    private readonly cache=new Map<string,ICacheEntry>();
    private readonly pending=new Map<string,Promise<void>>();
    private readonly migrated=new Set<string>();
    private readonly waiting:Array<()=>void>=[];
    private running=0;
    constructor(private readonly lifecycle:DatabaseLifecycle){
        lifecycle.setCacheCloser(async id=>{const entry=this.cache.get(id);if(!entry)return;if(entry.active)throw new ConflictException('База ещё используется.');this.cache.delete(id);await entry.db.close();});
    }

    /** Проверяет оба рабочих подключения, не создавая проектных БД. */
    async ready():Promise<void>{await Promise.all([this.admin.query('SELECT 1'),this.provisioner.query('SELECT 1')]);}

    async onModuleInit():Promise<void> {
        await this.migrationSource.setup();
        await this.lifecycle.setup();
    }
    async onModuleDestroy():Promise<void> {
        await Promise.all([...this.cache.values()].map(item=>item.db.close()));
        await this.migrationSource.close(); await this.admin.end();
        if(this.provisioner!==this.admin){await this.provisioner.end();}
    }

    /** Получает только проверенные серверные ID, не используя локальные пути клиента. */
    async projects():Promise<IProjectRef[]> {
        const base=(process.env.CATALOG_SERVICE_URL || 'http://localhost:4100').replace(/\/$/,'');
        const response=await fetch(`${base}/internal/access/projects`,{headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN || ''},signal:AbortSignal.timeout(8000)});
        if (!response.ok) { throw new Error(`Не удалось прочитать каталог проектов: HTTP ${response.status}`); }
        return await response.json() as IProjectRef[];
    }

    /** Не более восьми запросов к проектным БД одновременно; очередь не создаёт новые пулы. */
    async withProject<T>(key:string, action:(db:RagDb,id:string)=>Promise<T>):Promise<T> {
        if (this.running>=8) {
            if(this.waiting.length>=16){throw new ServiceUnavailableException('Очередь базы знаний заполнена. Повторите запрос позже.');}
            await new Promise<void>(resolve=>{this.waiting.push(resolve);recordCapacityQueue('rag',this.waiting.length,this.running);});
        }
        else { this.running++; }
        recordCapacityQueue('rag',this.waiting.length,this.running);
        let entry:ICacheEntry|undefined;
        let releaseLease:(()=>Promise<void>)|undefined;
        try {
            const project=(await this.projects()).find(item=>item.id===key || !key.startsWith('prj-')&&item.name===key);
            if (!project) { throw new NotFoundException('Проект не найден в каталоге.'); }
            await this.ensure(project);
            releaseLease=await this.lifecycle.lease(project.id);
            entry=this.cache.get(project.id);
            if (!entry) {
                const url=new URL(this.baseUrl); url.pathname=`/${projectDatabaseName(project.id)}`;
                const db=new RagDb({url:url.toString()});
                entry={db,used:Date.now(),active:0}; this.cache.set(project.id,entry);
            }
            entry.active++; entry.used=Date.now();
            await entry.db.setup();
            return await action(entry.db,project.id);
        } finally {
            if (entry) { entry.active--; }
            try { await this.trim(); }
            finally {
                try{await releaseLease?.();}finally{
                    const next=this.waiting.shift();
                    if (next) { next(); } else { this.running--; }
                    recordCapacityQueue('rag',this.waiting.length,this.running);
                }
            }
        }
    }

    /** Создаёт проектную БД и переносит старый общий индекс без удаления исходных данных. */
    private async ensure(project:IProjectRef):Promise<void> {
        if (this.migrated.has(project.id)) { return; }
        let pending=this.pending.get(project.id);
        if (!pending) {
            pending=this.provision(project).then(()=>{this.migrated.add(project.id);}).finally(()=>this.pending.delete(project.id));
            this.pending.set(project.id,pending);
        }
        await pending;
    }
    private async provision(project:IProjectRef):Promise<void> {
        const database=projectDatabaseName(project.id);
        const client=await this.admin.connect();
        let target:RagDb|undefined;
        let locked=false,global=false;let releaseCapacity=()=>{};
        try {
            await client.query('SELECT pg_advisory_lock_shared(hashtextextended($1,0))',[LIFECYCLE_LOCK]);global=true;
            await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[databaseLock(database)]); locked=true;
            const lifecycle=(await client.query('SELECT lifecycle_state FROM neurocenter_project_databases WHERE project_id=$1',[project.id])).rows[0];
            if(lifecycle&&lifecycle.lifecycle_state!=='active')throw new ConflictException('Этот ID проекта уже выведен из эксплуатации.');
            const existing=await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);
            if (!existing.rowCount) {
                const template=await client.query('SELECT pg_database_size($1)::float8 AS bytes',[process.env.NODE_ENV==='production'?'nc_rag_template':'template1']);
                releaseCapacity=await reserveCapacity({resource:'postgres',bytes:Math.max(64*1024**2,Number(template.rows[0].bytes)*3)});
                if(process.env.NODE_ENV==='production'){
                    const owner=new URL(this.baseUrl).username;
                    if(owner!=='nc_rag'){throw new Error('Неверный владелец проектной БД');}
                    await this.provisioner.query(`CREATE DATABASE "${database}" OWNER nc_rag TEMPLATE nc_rag_template`);
                    await this.provisioner.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
                    await this.provisioner.query(`GRANT CONNECT ON DATABASE "${database}" TO nc_backup`);
                }else{await client.query(`CREATE DATABASE "${database}"`);}
            }
            await client.query('INSERT INTO neurocenter_project_databases (project_id,database_name) VALUES ($1,$2) ON CONFLICT DO NOTHING',[project.id,database]);
            const state=await client.query('SELECT migrated,migration_offset FROM neurocenter_project_databases WHERE project_id=$1',[project.id]);
            if (state.rows[0].migrated) { return; }
            const url=new URL(this.baseUrl); url.pathname=`/${database}`;
            target=new RagDb({url:url.toString()}); await target.setup();
            const generation=(id:string)=>'initial-'+createHash('md5').update(id).digest('hex');
            const canonicalCount=await this.migrationSource.count(project.id,generation(project.id));
            // Имя из пространства ID не может быть источником чужого старого индекса.
            const source=canonicalCount>0 || project.name.startsWith('prj-') ? project.id : project.name;
            await target.reserveMigrationQuota(project.id,await this.migrationSource.migrationQuotaBytes(source,project.id));
            const sourceSummary=await this.migrationSource.summary(source,generation(source));
            let offset=Number(state.rows[0].migration_offset);
            while (true) {
                const rows=await this.migrationSource.rowsPage(source,generation(source),500,offset);
                if (!rows.length) { break; }
                await target.applyDelta(project.id,generation(project.id),rows,[],sourceSummary.indexProfile?{indexProfile:sourceSummary.indexProfile,
                    snapshot:{hash:sourceSummary.snapshotHash||'0'.repeat(64),rowCount:sourceSummary.rowCount,complete:false}}:{indexProfile:null});
                offset+=rows.length;
                await client.query('UPDATE neurocenter_project_databases SET migration_offset=$2 WHERE project_id=$1',[project.id,offset]);
            }
            const expected=await this.migrationSource.count(source,generation(source));
            if (await target.count(project.id,generation(project.id))<expected) { throw new Error('Проверка переноса проектной базы не пройдена.'); }
            if(sourceSummary.complete&&sourceSummary.indexProfile&&sourceSummary.snapshotHash){await target.applyDelta(project.id,generation(project.id),[],[],{
                indexProfile:sourceSummary.indexProfile,snapshot:{hash:sourceSummary.snapshotHash,rowCount:sourceSummary.rowCount,complete:true}});}
            await client.query('UPDATE neurocenter_project_databases SET migrated=true WHERE project_id=$1',[project.id]);
        } finally {
            releaseCapacity();
            try { if (target) { await target.close(); } }
            finally {
                let broken=false;
                try{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[databaseLock(database)]);
                    if(global)await client.query('SELECT pg_advisory_unlock_shared(hashtextextended($1,0))',[LIFECYCLE_LOCK]);}
                catch(error){broken=true;throw error;}finally{client.release(broken);}
            }
        }
    }
    private async trim():Promise<void> {
        const idle=[...this.cache.entries()].filter(([,entry])=>entry.active===0).sort((a,b)=>a[1].used-b[1].used);
        while (this.cache.size>8 && idle.length) {
            const [id,entry]=idle.shift()!; this.cache.delete(id); await entry.db.close();
        }
    }
}
