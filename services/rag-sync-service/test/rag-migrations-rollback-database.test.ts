import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,afterEach,describe,expect,it} from 'vitest';
import {checkRagMigrations,checkRagQuotaMigration,migrateRag} from '../src/database/migrations';
import {PLATFORM_QUOTA_CACHE_MIGRATION as cache,QUOTA_MIGRATION,sqlChecksum} from '../src/database/migration-definitions';
import {ragQuota,setupRagQuota} from '../src/rag/quota/rag-quota';
import {ownedQuotaRollbackUrl} from './platform-quota-rollback.fixture';

type Layout='empty'|'quota'|'migrations';
const connection=process.env.RAG_MIGRATION_ROLLBACK_TEST_PG_URL,project='project';
const fixtures:Array<{dispose:()=>Promise<unknown>}>=[],cleanup:unknown[]=[],observations:unknown[]=[];
afterEach(async()=>{for(const value of fixtures.splice(0))cleanup.push(await value.dispose());});
afterAll(async()=>{
    if(process.env.RAG_MIGRATION_ROLLBACK_EVIDENCE_FILE)await writeFile(process.env.RAG_MIGRATION_ROLLBACK_EVIDENCE_FILE,
        JSON.stringify({cleanup,observations},null,2)+'\n');
});

/** Real registered cache SQL needs no vector extension; the quota successor uses the unchanged production quota schema. */
async function fixture(layout:Layout='empty'){
    const url=ownedQuotaRollbackUrl(connection!),database='ragmigrationtx_'+randomUUID().replaceAll('-','');
    const admin=new Pool({connectionString:url.href,max:1});let pool:Pool|undefined,observer:Pool|undefined,created=false;
    const dispose=async()=>{
        try{
            await observer?.end();await pool?.end();if(created)await admin.query('DROP DATABASE '+database);
            const databases=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows;
            const sessions=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[database])).rows;
            if(databases.length||sessions.length)throw Error('Owned migration fixture resources remain.');
            return{database,dropped:created,databasesRemaining:databases,sessionsRemaining:sessions};
        }finally{await admin.end();}
    };
    try{
        await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:1});observer=new Pool({connectionString:url.href,max:1});
        if(layout==='migrations')await migrateRag(pool,[cache]);
        if(layout!=='empty'){
            await pool.query(`CREATE FUNCTION public.vector_dims(real[]) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS 'SELECT cardinality($1)';
                CREATE TABLE rag_chunks(id text NOT NULL,project_key text NOT NULL,file_path text NOT NULL DEFAULT '',content text NOT NULL,
                    description text,start_line integer,end_line integer,language text,kind text NOT NULL DEFAULT '',role text,quirk_type text,
                    tags text,content_hash text NOT NULL,embedding real[],PRIMARY KEY(id,project_key));`);
            await setupRagQuota(pool,{defaultBytes:100,maximumBytes:300});await ragQuota(pool,project);
            if(layout==='quota')expect(await checkRagQuotaMigration(pool)).toBe(true);
            else expect(await checkRagMigrations(pool,[cache])).toEqual({applied:[cache.version],pending:[]});
        }
        const value={pool,observer,database,dispose};fixtures.push(value);return value;
    }catch(error){await dispose();throw error;}
}

/** Business SQL is real; only its ACK and ROLLBACK delivery/ACK can be lost at named boundaries. */
function faultPool(pool:Pool,boundary:'ledger'|'commit'|'none',rollbackLoss:'none'|'before'|'after'='none'){
    const failure=new Error('Own migration '+boundary+' acknowledgement lost'),rollbackFailure=new Error('Own migration rollback acknowledgement lost');
    const sql:string[]=[];let pid=0,released:Error|boolean|undefined,fired=false;
    const wrapped={connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        pid=Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return{query:async(text:string,...args:unknown[])=>{
            sql.push(text);if(text==='ROLLBACK'&&rollbackLoss==='before')throw rollbackFailure;
            const result=await(query as(...values:unknown[])=>Promise<unknown>)(text,...args);
            if(text==='ROLLBACK'&&rollbackLoss==='after')throw rollbackFailure;
            if(!fired&&(boundary==='ledger'&&text.startsWith('INSERT INTO neurocenter_rag_schema_versions(')||boundary==='commit'&&text==='COMMIT')){
                fired=true;throw failure;
            }
            return result;
        },release:(discard?:Error|boolean)=>{released=discard;client.release(discard);}};
    }}as unknown as Pool;
    return{pool:wrapped,failure,rollbackFailure,sql,pid:()=>pid,released:()=>released,fired:()=>fired};
}

async function state(f:Awaited<ReturnType<typeof fixture>>){
    const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename as string);
    return{tables,migrations:tables.includes('neurocenter_rag_schema_versions')?(await f.observer.query('SELECT version,checksum,applied_at FROM neurocenter_rag_schema_versions ORDER BY version')).rows:[],
        applied:tables.includes('rag_platform_quota_applied')?(await f.observer.query('SELECT * FROM rag_platform_quota_applied')).rows:[],
        quotaHistory:tables.includes('neurocenter_rag_migrations')?(await f.observer.query('SELECT version,checksum,applied_at FROM neurocenter_rag_migrations ORDER BY version')).rows:[],
        budgets:tables.includes('rag_storage_budget')?(await f.observer.query('SELECT project_key,used_bytes,limit_bytes,revision FROM rag_storage_budget ORDER BY project_key')).rows:[],
        events:tables.includes('rag_quota_events')?(await f.observer.query('SELECT project_key,actor,before_bytes,after_bytes,revision FROM rag_quota_events ORDER BY id')).rows:[]};
}

describe.skipIf(connection===undefined).sequential('RAG migration transaction ownership on real PostgreSQL',()=>{
    for(const loss of ['before','after']as const)it('a compatibility check cannot commit failed migration DDL after rollback ACK loss '+loss,async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'ledger',loss),next=faultPool(f.pool,'none');
        await expect(migrateRag(fault.pool,[cache])).rejects.toBe(fault.failure);expect(fault.fired()).toBe(true);
        const afterFailure=await state(f),checked=await checkRagMigrations(next.pool,[cache]),afterCheck=await state(f);
        observations.push({operation:'migrate',boundary:'ledger',rollbackLoss:loss,before,afterFailure,checked,afterCheck,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
        expect(afterFailure).toEqual(before);expect(checked).toEqual({applied:[],pending:[cache.version]});expect(afterCheck).toEqual(before);
        expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
        await migrateRag(f.pool,[cache]);expect(await checkRagMigrations(f.pool,[cache])).toEqual({applied:[cache.version],pending:[]});
    });
    it('a confirmed migration rollback preserves the primary error and reuses a healthy backend',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'ledger'),next=faultPool(f.pool,'none');
        await expect(migrateRag(fault.pool,[cache])).rejects.toBe(fault.failure);
        expect(await state(f)).toEqual(before);expect(await checkRagMigrations(next.pool,[cache])).toEqual({applied:[],pending:[cache.version]});
        expect(await state(f)).toEqual(before);expect(next.pid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);
        await migrateRag(f.pool,[cache]);expect((await state(f)).migrations).toHaveLength(1);
    });
    it('a lost COMMIT ACK keeps registered DDL durable and exact migration retry adds no ledger duplicate',async()=>{
        const f=await fixture(),fault=faultPool(f.pool,'commit','before'),next=faultPool(f.pool,'none');
        await expect(migrateRag(fault.pool,[cache])).rejects.toBe(fault.failure);expect(fault.fired()).toBe(true);
        const committed=await state(f);expect(committed.migrations).toHaveLength(1);
        expect(committed.migrations[0]).toMatchObject({version:cache.version,checksum:sqlChecksum(cache.sql)});
        expect(await checkRagMigrations(next.pool,[cache])).toEqual({applied:[cache.version],pending:[]});
        await migrateRag(next.pool,[cache]);const retried=await state(f);
        observations.push({operation:'migrate',boundary:'commit',committed,retried,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
        expect(retried).toEqual(committed);expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
    });
    for(const operation of ['quota','migrations']as const)for(const loss of ['none','before','after']as const){
        it(operation+': natural malformed history with rollback '+loss+' cannot poison a later quota write with a READ ONLY session',async()=>{
            const f=await fixture(operation),before=await state(f),fault=faultPool(f.pool,'none',loss),next=faultPool(f.pool,'none');
            const table=operation==='quota'?'neurocenter_rag_migrations':'neurocenter_rag_schema_versions';
            const migration=operation==='quota'?QUOTA_MIGRATION:cache;
            await f.observer.query('UPDATE '+table+' SET checksum=$2 WHERE version=$1',[migration.version,'tampered']);
            let primary:unknown;
            try{if(operation==='quota')await checkRagQuotaMigration(fault.pool);else await checkRagMigrations(fault.pool,[cache]);}
            catch(error){primary=error;}
            expect(primary).toBeInstanceOf(Error);expect((primary as Error).message).toMatch(/История миграций RAG/);expect(primary).not.toBe(fault.rollbackFailure);
            expect(fault.sql).toContain('BEGIN READ ONLY');expect(fault.sql).toContain('ROLLBACK');
            // Repair only the fixture's deliberately corrupted history before the unrelated ordinary quota update.
            await f.observer.query('UPDATE '+table+' SET checksum=$2 WHERE version=$1',[migration.version,sqlChecksum(migration.sql)]);
            expect(await state(f)).toEqual(before);
            let updated:unknown,nextError:unknown;
            try{updated=await ragQuota(next.pool,project,{limitBytes:150,expectedRevision:0},'healthy-next@test');}catch(error){nextError=error;}
            const after=await state(f);
            observations.push({operation,rollbackLoss:loss,before,after,updated,primary:{message:(primary as Error).message},
                nextError:nextError?{code:(nextError as{code?:string}).code,message:(nextError as Error).message}:null,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
            expect(nextError).toBeUndefined();expect(updated).toMatchObject({limitBytes:150,revision:1});
            expect(after.budgets).toEqual([{project_key:project,used_bytes:'0',limit_bytes:'150',revision:'1'}]);
            expect(after.events).toHaveLength(2);expect(after.events[1]).toMatchObject({actor:'healthy-next@test',after_bytes:'150',revision:'1'});
            if(loss==='none'){expect(next.pid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);}
            else{expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);}
        });
    }
});
