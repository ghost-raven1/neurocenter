import {BadRequestException,ConflictException,Injectable,NotFoundException,ServiceUnavailableException,type OnModuleDestroy} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {createPool} from '../database/pool';
import {projectDatabaseName} from '../rag/project-database-name';
import {ragRequestHash} from '../../../shared/rag-index-contract.cjs';
import {databaseLock,LIFECYCLE_LOCK,setupDatabaseLifecycle} from './lifecycle-schema';
import type {IDatabaseIdentity,IPurgeCommand,IPurgeReceipt,IRetiredDatabaseFacts} from './lifecycle-types';
import {migrateRag} from '../database/migrations';
import {IDENTITY_MIGRATION} from '../database/migration-definitions';

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const conflict=()=>new ConflictException('База, план или её использование изменились. Подготовьте новый план удаления.');

/** Session fences переживают HTTP timeout; DROP никогда не отключает чужие соединения принудительно. */
@Injectable()
export class DatabaseLifecycle implements OnModuleDestroy {
    private readonly baseUrl=process.env.RAG_PG_URL||'postgresql://rag:rag@localhost:5432/rag';
    private readonly pool=createPool({connectionString:this.baseUrl,max:12},'database-lifecycle');
    private setupTask?:Promise<void>;
    private closeCached:(projectId:string)=>Promise<void>=async()=>{};
    setup():Promise<void>{return this.setupTask??=setupDatabaseLifecycle(this.pool).catch(error=>{this.setupTask=undefined;throw error;});}
    async onModuleDestroy(){await this.pool.end();}
    setCacheCloser(close:(projectId:string)=>Promise<void>):void{this.closeCached=close;}
    /** Любое чтение/индексация держит lease до завершения действия, включая async inference. */
    async lease(projectId:string):Promise<()=>Promise<void>>{
        await this.setup();const db=await this.pool.connect(),key=databaseLock(projectDatabaseName(projectId));let locked=false;
        try{
            await db.query('SELECT pg_advisory_lock_shared(hashtextextended($1,0))',[key]);locked=true;
            const row=(await db.query('SELECT lifecycle_state FROM neurocenter_project_databases WHERE project_id=$1',[projectId])).rows[0];
            if(row?.lifecycle_state!=='active')throw conflict();
            return async()=>{let broken=false;try{await db.query('SELECT pg_advisory_unlock_shared(hashtextextended($1,0))',[key]);}catch(error){broken=true;throw error;}finally{db.release(broken);}};
        }catch(error){let broken=false;if(locked)await db.query('SELECT pg_advisory_unlock_shared(hashtextextended($1,0))',[key]).catch(()=>{broken=true;});db.release(broken);throw error;}
    }
    async inventory(){
        await this.setup();return (await this.pool.query(`SELECT r.project_id AS "projectId",r.database_name AS "databaseName",r.lifecycle_state AS state,
            r.retirement_id AS "retirementId",r.purged_at AS "purgedAt",d.oid IS NOT NULL AS present,
            CASE WHEN d.oid IS NULL THEN 0 ELSE pg_database_size(d.oid)::float8 END AS bytes
            FROM neurocenter_project_databases r LEFT JOIN pg_database d ON d.datname=r.database_name ORDER BY r.created_at DESC`)).rows;
    }
    /** Привязка legacy retained DB создаёт явный marker; имя никогда не приходит в SQL от клиента. */
    async preview(projectId:string,retirementId:string):Promise<IRetiredDatabaseFacts>{
        if(!uuid(retirementId)||typeof projectId!=='string'||!projectId||projectId.length>200)throw new BadRequestException('Некорректное сохранённое хранилище.');
        const base=(process.env.CATALOG_SERVICE_URL||'http://localhost:4100').replace(/\/$/,'');
        const response=await fetch(`${base}/internal/retired-rag/retirements/${retirementId}/authorize-preview`,{method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},body:JSON.stringify({projectId}),signal:AbortSignal.timeout(8000)});
        if(!response.ok)throw conflict();const approval=await response.json() as {projectId?:string;retirementId?:string};
        if(approval.projectId!==projectId||approval.retirementId!==retirementId)throw conflict();
        return this.exclusive(projectId,async db=>{
            const registry=await this.registry(db,projectId);
            if(registry.lifecycle_state==='purged')throw new NotFoundException('База уже удалена.');
            if(registry.retirement_id&&registry.retirement_id!==retirementId)throw conflict();
            const identity=await this.identity(db,projectId,registry.database_identity,true);
            await db.query("UPDATE neurocenter_project_databases SET lifecycle_state='retained',retirement_id=$2 WHERE project_id=$1 AND lifecycle_state<>'purged'",[projectId,retirementId]);
            return this.facts(db,identity,retirementId);
        });
    }
    async execute(command:IPurgeCommand):Promise<IPurgeReceipt>{
        if(!command||Object.keys(command).sort().join(',')!=='digest,facts,jobId'||!uuid(command.jobId)||!/^[a-f0-9]{64}$/.test(command.digest)
            ||!command.facts?.identity||ragRequestHash(command.facts)!==command.digest)throw new BadRequestException('Некорректный план удаления базы.');
        const {identity}=command.facts,projectId=identity.projectId;
        if(typeof projectId!=='string'||!projectId||projectId.length>200||!uuid(command.facts.retirementId)||!uuid(identity.marker)
            ||typeof identity.cluster!=='string'||!/^\d+$/.test(identity.cluster)||typeof identity.oid!=='string'||!/^\d+$/.test(identity.oid)
            ||![command.facts.bytes,command.facts.chunks,command.facts.generations].every(v=>Number.isSafeInteger(v)&&v>=0))throw new BadRequestException('План не содержит полной проверенной identity базы.');
        if(identity.databaseName!==projectDatabaseName(projectId)||!/^nc_rag_[a-f0-9]{32}$/.test(identity.databaseName))throw conflict();
        return this.exclusive(projectId,async db=>{
            const registry=await this.registry(db,projectId);
            const old=(await db.query('SELECT * FROM neurocenter_database_purge_receipts WHERE id=$1',[command.jobId])).rows[0];
            if(old&&(old.project_id!==projectId||old.digest!==command.digest||ragRequestHash(old.facts)!==command.digest))throw conflict();
            if(registry.database_identity!==identity.marker)throw conflict();
            // A restored completed receipt is history, never permission to DROP in the restored cluster.
            if(old?.phase==='dropped'){if(registry.lifecycle_state!=='purged')throw conflict();return this.receipt(command,old.updated_at);}
            const cluster=await this.cluster(db);if(cluster!==identity.cluster)throw conflict();
            if(registry.retirement_id!==command.facts.retirementId||!['retained','purging'].includes(registry.lifecycle_state))throw conflict();
            const physical=(await db.query('SELECT oid::text,datallowconn FROM pg_database WHERE datname=$1',[identity.databaseName])).rows[0];
            if(!physical){if(!old||old.phase!=='dropping')throw conflict();return this.finish(db,command);}
            if(physical.oid!==identity.oid)throw conflict();
            if(!physical.datallowconn){
                if(!old||!['freezing','dropping'].includes(old.phase))throw conflict();
                await db.query(`ALTER DATABASE "${identity.databaseName}" ALLOW_CONNECTIONS true`);
            }
            await this.identity(db,projectId,identity.marker,false);
            // Reopening our exact interrupted freeze preserves backup availability even after role revocation.
            await this.authorize(command);
            await db.query(`INSERT INTO neurocenter_database_purge_receipts(id,project_id,digest,facts,phase) VALUES($1,$2,$3,$4::jsonb,'claimed')
                ON CONFLICT(id) DO NOTHING`,[command.jobId,projectId,command.digest,JSON.stringify(command.facts)]);
            await db.query("UPDATE neurocenter_project_databases SET lifecycle_state='purging' WHERE project_id=$1",[projectId]);
            let dropAttempted=false;
            try{
                // Own connection is opened before the fence; facts are read AFTER every other session is excluded.
                await db.query("UPDATE neurocenter_database_purge_receipts SET phase='freezing',updated_at=now() WHERE id=$1",[command.jobId]);
                await this.frozen(db,command,async target=>{
                    await db.query(`ALTER DATABASE "${identity.databaseName}" ALLOW_CONNECTIONS false`);
                    await this.authorize(command);
                    const pid=(await target.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
                    if((await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND pid<>$2 AND backend_type='client backend' LIMIT 1",[identity.databaseName,pid])).rows.length)throw new ServiceUnavailableException('База используется другим соединением.');
                    if(ragRequestHash(await this.facts(db,identity,command.facts.retirementId,target))!==command.digest)throw conflict();
                    // Ambiguous DROP boundary is durable BEFORE issuing the nontransactional statement.
                    await db.query("UPDATE neurocenter_database_purge_receipts SET phase='dropping',updated_at=now() WHERE id=$1",[command.jobId]);
                });
                dropAttempted=true;
                await db.query(`DROP DATABASE "${identity.databaseName}"`);
                return await this.finish(db,command);
            }catch(error){
                const remaining=(await db.query('SELECT oid::text FROM pg_database WHERE datname=$1',[identity.databaseName])).rows[0];
                if(!remaining){if(dropAttempted)return this.finish(db,command);throw conflict();}
                if(remaining.oid===identity.oid){
                    await db.query(`ALTER DATABASE "${identity.databaseName}" ALLOW_CONNECTIONS true`);
                    await db.query("UPDATE neurocenter_project_databases SET lifecycle_state='retained' WHERE project_id=$1",[projectId]);
                    await db.query("UPDATE neurocenter_database_purge_receipts SET phase='failed',message='Удаление не завершено. База сохранена.',updated_at=now() WHERE id=$1",[command.jobId]);
                }
                if(error instanceof ConflictException)throw error;
                throw new ServiceUnavailableException('Удаление не завершено. База сохранена; проверьте подключения и повторите действие.');
            }
        });
    }
    private async authorize(command:IPurgeCommand){
        const base=(process.env.CATALOG_SERVICE_URL||'http://localhost:4100').replace(/\/$/,'');
        const result=await fetch(`${base}/internal/retired-rag/purges/${command.jobId}/authorize`,{method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
            body:JSON.stringify({digest:command.digest}),signal:AbortSignal.timeout(8000)});
        if(!result.ok)throw new ConflictException('Удаление больше не разрешено. Проверьте удержание, права и незавершённые операции.');
        const body=await result.json() as {projectId?:string;digest?:string};if(body.projectId!==command.facts.identity.projectId||body.digest!==command.digest)throw conflict();
    }
    private async exclusive<T>(projectId:string,work:(db:PoolClient)=>Promise<T>):Promise<T>{
        await this.setup();const db=await this.pool.connect(),key=databaseLock(projectDatabaseName(projectId));let global=false,local=false;
        try{
            global=(await db.query('SELECT pg_try_advisory_lock_shared(hashtextextended($1,0)) AS locked',[LIFECYCLE_LOCK])).rows[0].locked;
            if(!global)throw new ConflictException('Выполняется полная резервная копия. Повторите после её завершения.');
            local=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
            if(!local)throw new ConflictException('База ещё используется запросом или индексацией. Повторите после завершения.');
            await this.closeCached(projectId);return await work(db);
        }finally{
            let broken=false;try{if(local)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);if(global)await db.query('SELECT pg_advisory_unlock_shared(hashtextextended($1,0))',[LIFECYCLE_LOCK]);}catch{broken=true;}db.release(broken);
        }
    }
    private async registry(db:PoolClient,projectId:string){
        const row=(await db.query('SELECT * FROM neurocenter_project_databases WHERE project_id=$1',[projectId])).rows[0];
        if(!row)throw new NotFoundException('У проекта нет отдельной RAG-базы.');
        if(row.database_name!==projectDatabaseName(projectId))throw conflict();return row;
    }
    private async cluster(db:PoolClient):Promise<string>{return (await db.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;}
    private async frozen<T>(db:PoolClient,command:IPurgeCommand,work:(target:PoolClient)=>Promise<T>):Promise<T>{
        const identity=command.facts.identity,url=new URL(this.baseUrl);url.pathname='/'+identity.databaseName;
        const pool=createPool({connectionString:url.toString(),max:1,statement_timeout:10000},'database-freeze');let target:PoolClient|undefined;
        try{target=await pool.connect();const marker=(await target.query('SELECT id,project_id FROM neurocenter_database_identity WHERE singleton')).rows[0];
            const actual=(await db.query('SELECT oid::text FROM pg_database WHERE datname=$1',[identity.databaseName])).rows[0];
            if(marker?.id!==identity.marker||marker?.project_id!==identity.projectId||actual?.oid!==identity.oid)throw conflict();return await work(target);
        }finally{target?.release();await pool.end();}
    }
    private async identity(db:PoolClient,projectId:string,marker:string,adopt:boolean):Promise<IDatabaseIdentity>{
        const databaseName=projectDatabaseName(projectId),physical=(await db.query('SELECT oid::text,datallowconn FROM pg_database WHERE datname=$1',[databaseName])).rows[0];
        if(!physical)throw new NotFoundException('Физическая база отсутствует. Удаление не подтверждено.');if(!physical.datallowconn)throw conflict();
        const url=new URL(this.baseUrl);url.pathname='/'+databaseName;const target=createPool({connectionString:url.toString(),max:1},'database-identity');
        try{
            if(adopt){await migrateRag(target,[IDENTITY_MIGRATION]);
                await target.query('INSERT INTO neurocenter_database_identity(singleton,id,project_id) VALUES(true,$1,$2) ON CONFLICT DO NOTHING',[marker,projectId]);}
            if(!(await target.query("SELECT to_regclass('public.neurocenter_database_identity') AS name")).rows[0].name)throw conflict();
            const actual=(await target.query('SELECT id,project_id FROM neurocenter_database_identity WHERE singleton')).rows[0];
            if(actual?.id!==marker||actual?.project_id!==projectId)throw conflict();
        }finally{await target.end();}
        return {cluster:await this.cluster(db),oid:physical.oid,marker,databaseName,projectId};
    }
    private async facts(db:PoolClient,identity:IDatabaseIdentity,retirementId:string,existing?:PoolClient):Promise<IRetiredDatabaseFacts>{
        const url=new URL(this.baseUrl);url.pathname='/'+identity.databaseName;const pool=existing?undefined:createPool({connectionString:url.toString(),max:1,statement_timeout:10000},'database-preview');const target=existing??pool!;
        try{
            const tables=(await target.query("SELECT to_regclass('public.rag_chunks') IS NOT NULL AS chunks,to_regclass('public.rag_generations') IS NOT NULL AS generations")).rows[0];
            const chunks=tables.chunks?Number((await target.query('SELECT count(*) FROM rag_chunks')).rows[0].count):0;
            const generations=tables.generations?Number((await target.query('SELECT count(*) FROM rag_generations')).rows[0].count):0;
            const bytes=Number((await db.query('SELECT pg_database_size($1)::float8 AS bytes',[identity.databaseName])).rows[0].bytes);
            if(![bytes,chunks,generations].every(v=>Number.isSafeInteger(v)&&v>=0))throw conflict();
            return {identity,retirementId,bytes,chunks,generations,backupPolicy:'retained-until-explicit-purge',preserves:['backups','lance-snapshots','local-files']};
        }finally{await pool?.end();}
    }
    private receipt(command:IPurgeCommand,at:Date|string):IPurgeReceipt{return {jobId:command.jobId,state:'succeeded',databaseName:command.facts.identity.databaseName,identity:command.facts.identity,purgedAt:new Date(at).toISOString()};}
    private async finish(db:PoolClient,command:IPurgeCommand):Promise<IPurgeReceipt>{
        await db.query('BEGIN');try{
            const previous=(await db.query('SELECT phase,updated_at FROM neurocenter_database_purge_receipts WHERE id=$1 FOR UPDATE',[command.jobId])).rows[0];
            if(previous?.phase==='dropped'){await db.query('COMMIT');return this.receipt(command,previous.updated_at);}
            await db.query("UPDATE neurocenter_project_databases SET lifecycle_state='purged',purged_at=now() WHERE project_id=$1 AND database_identity=$2",[command.facts.identity.projectId,command.facts.identity.marker]);
            const row=(await db.query("UPDATE neurocenter_database_purge_receipts SET phase='dropped',updated_at=now() WHERE id=$1 RETURNING updated_at",[command.jobId])).rows[0];
            await db.query('COMMIT');return this.receipt(command,row.updated_at);
        }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}
    }
}
