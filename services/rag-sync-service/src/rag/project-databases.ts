import { NotFoundException,ServiceUnavailableException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {createPool} from '../database/pool';
import { RagDb } from './rag-db';
import {reserveCapacity,recordCapacityQueue} from '../../../shared/capacity.cjs';

interface IProjectRef { id:string; name:string }
interface ICacheEntry { db:RagDb; used:number; active:number }

/** Имя БД зависит от постоянного ID проекта и не содержит пользовательского SQL. */
export function projectDatabaseName(projectId:string):string {
    return `nc_rag_${createHash('sha256').update(projectId).digest('hex').slice(0,32)}`;
}

/** Отдельные PostgreSQL-базы проектов с ограниченным числом открытых пулов. */
@Injectable()
export class ProjectDatabases implements OnModuleInit, OnModuleDestroy {
    private readonly baseUrl=process.env.RAG_PG_URL || 'postgresql://rag:rag@localhost:5432/rag';
    private readonly admin=createPool({connectionString:this.baseUrl,max:2},'rag-admin');
    private readonly provisioner=process.env.RAG_PROVISION_PG_URL?createPool({connectionString:process.env.RAG_PROVISION_PG_URL,max:1},'rag-provisioner'):this.admin;
    private readonly legacy=new RagDb({url:this.baseUrl,dim:Number(process.env.RAG_DIM || 2560)});
    private readonly cache=new Map<string,ICacheEntry>();
    private readonly pending=new Map<string,Promise<void>>();
    private readonly migrated=new Set<string>();
    private readonly waiting:Array<()=>void>=[];
    private running=0;

    /** Проверяет оба рабочих подключения, не создавая проектных БД. */
    async ready():Promise<void>{await Promise.all([this.admin.query('SELECT 1'),this.provisioner.query('SELECT 1')]);}

    async onModuleInit():Promise<void> {
        await this.legacy.setup();
        await this.admin.query(`CREATE TABLE IF NOT EXISTS neurocenter_project_databases (
            project_id TEXT PRIMARY KEY, database_name TEXT NOT NULL UNIQUE,
            migration_offset BIGINT NOT NULL DEFAULT 0, migrated BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    }
    async onModuleDestroy():Promise<void> {
        await Promise.all([...this.cache.values()].map(item=>item.db.close()));
        await this.legacy.close(); await this.admin.end();
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
        try {
            const project=(await this.projects()).find(item=>item.id===key || !key.startsWith('prj-')&&item.name===key);
            if (!project) { throw new NotFoundException('Проект не найден в каталоге.'); }
            await this.ensure(project);
            entry=this.cache.get(project.id);
            if (!entry) {
                const url=new URL(this.baseUrl); url.pathname=`/${projectDatabaseName(project.id)}`;
                const db=new RagDb({url:url.toString(),dim:Number(process.env.RAG_DIM || 2560)});
                entry={db,used:Date.now(),active:0}; this.cache.set(project.id,entry);
            }
            entry.active++; entry.used=Date.now();
            await entry.db.setup();
            return await action(entry.db,project.id);
        } finally {
            if (entry) { entry.active--; }
            try { await this.trim(); }
            finally {
                const next=this.waiting.shift();
                if (next) { next(); } else { this.running--; }
                recordCapacityQueue('rag',this.waiting.length,this.running);
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
        let locked=false;let releaseCapacity=()=>{};
        try {
            await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[database]); locked=true;
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
            target=new RagDb({url:url.toString(),dim:Number(process.env.RAG_DIM || 2560)}); await target.setup();
            const canonicalCount=await this.legacy.count(project.id);
            // Имя из пространства ID не может быть источником чужого старого индекса.
            const source=canonicalCount>0 || project.name.startsWith('prj-') ? project.id : project.name;
            await target.reserveLegacyQuota(project.id,await this.legacy.legacyQuotaBytes(source,project.id));
            let offset=Number(state.rows[0].migration_offset);
            while (true) {
                const rows=await this.legacy.rowsPage(source,500,offset);
                if (!rows.length) { break; }
                await target.applyDelta(project.id,rows,[]);
                offset+=rows.length;
                await client.query('UPDATE neurocenter_project_databases SET migration_offset=$2 WHERE project_id=$1',[project.id,offset]);
            }
            const expected=await this.legacy.count(source);
            if (await target.count(project.id)<expected) { throw new Error('Проверка переноса проектной базы не пройдена.'); }
            await client.query('UPDATE neurocenter_project_databases SET migrated=true WHERE project_id=$1',[project.id]);
        } finally {
            releaseCapacity();
            try { if (target) { await target.close(); } }
            finally {
                if (locked) {
                    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[database]); }
                    catch (error) { client.release(true); throw error; }
                }
                client.release();
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
