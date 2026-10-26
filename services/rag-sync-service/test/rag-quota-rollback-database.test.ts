import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,afterEach,describe,expect,it} from 'vitest';
import {ragQuota,setupRagQuota} from '../src/rag/quota/rag-quota';
import {ownedQuotaRollbackUrl} from './platform-quota-rollback.fixture';

const connection=process.env.RAG_QUOTA_TEST_PG_URL;
const fixtures:Array<{dispose:()=>Promise<unknown>}>=[],cleanup:unknown[]=[],observations:unknown[]=[];
afterEach(async()=>{for(const value of fixtures.splice(0))cleanup.push(await value.dispose());});
afterAll(async()=>{
    if(process.env.RAG_QUOTA_TRANSACTION_EVIDENCE_FILE)await writeFile(process.env.RAG_QUOTA_TRANSACTION_EVIDENCE_FILE,
        JSON.stringify({cleanup,observations},null,2)+'\n');
});

/** Production quota SQL runs against empty chunk storage; array dimensions only satisfy its unused vector signature. */
async function fixture(){
    const url=ownedQuotaRollbackUrl(connection!),database='ragquotatx_'+randomUUID().replaceAll('-','');
    const admin=new Pool({connectionString:url.href,max:1});let pool:Pool|undefined,observer:Pool|undefined,created=false;
    const dispose=async()=>{
        try{
            await observer?.end();await pool?.end();
            if(created)await admin.query('DROP DATABASE '+database);
            const databases=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows;
            const sessions=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[database])).rows;
            if(databases.length||sessions.length)throw Error('Owned RAG quota resources remain.');
            return{database,dropped:created,databasesRemaining:databases,sessionsRemaining:sessions};
        }finally{await admin.end();}
    };
    try{
        await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:1});observer=new Pool({connectionString:url.href,max:1});
        await pool.query(`CREATE FUNCTION public.vector_dims(real[]) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS 'SELECT cardinality($1)';
            CREATE TABLE rag_chunks(id text NOT NULL,project_key text NOT NULL,file_path text NOT NULL DEFAULT '',content text NOT NULL,
                description text,start_line integer,end_line integer,language text,kind text NOT NULL DEFAULT '',role text,quirk_type text,
                tags text,content_hash text NOT NULL,embedding real[],PRIMARY KEY(id,project_key));`);
        await setupRagQuota(pool,{defaultBytes:100,maximumBytes:300});
        const project='project-'+randomUUID(),before=await ragQuota(pool,project);
        const value={pool,observer,project,before,dispose};fixtures.push(value);return value;
    }catch(error){await dispose();throw error;}
}

/** Execute business SQL; fault its ACK and either ROLLBACK delivery or the ACK after PostgreSQL rolls back. */
function faultPool(pool:Pool,boundary:'update'|'commit'|'none',rollbackLoss:'none'|'before'|'after'='none'){
    const error=new Error('Own RAG quota '+boundary+' acknowledgement lost'),rollbackError=new Error('Own RAG rollback not delivered');
    const sql:string[]=[];let pid=0,released:Error|boolean|undefined,fired=false;
    const wrapped={connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        pid=Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return{query:async(text:string,...args:unknown[])=>{
            sql.push(text);if(text==='ROLLBACK'&&rollbackLoss==='before')throw rollbackError;
            const result=await (query as (...values:unknown[])=>Promise<unknown>)(text,...args);
            if(text==='ROLLBACK'&&rollbackLoss==='after')throw rollbackError;
            if(!fired&&(boundary==='update'&&text.startsWith('UPDATE rag_storage_budget SET limit_bytes=')||boundary==='commit'&&text==='COMMIT')){
                fired=true;throw error;
            }
            return result;
        },release:(discard?:Error|boolean)=>{released=discard;client.release(discard);}};
    }}as unknown as Pool;
    return{pool:wrapped,error,sql,pid:()=>pid,released:()=>released,fired:()=>fired};
}

async function state(value:Awaited<ReturnType<typeof fixture>>){
    return{budget:(await value.observer.query('SELECT used_bytes,limit_bytes,revision FROM rag_storage_budget WHERE project_key=$1',[value.project])).rows[0],
        events:(await value.observer.query('SELECT actor,before_bytes,after_bytes,revision FROM rag_quota_events WHERE project_key=$1 ORDER BY id',[value.project])).rows};
}

describe.skipIf(connection===undefined).sequential('Project quota rollback ownership on real disposable PostgreSQL',()=>{
    it('a normal quota read cannot commit a previous failed update after an undelivered rollback',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'update','before');
        await expect(ragQuota(fault.pool,f.project,{limitBytes:150,expectedRevision:0},'failed@test')).rejects.toBe(fault.error);
        expect(fault.fired()).toBe(true);const beforeRead=await state(f),next=faultPool(f.pool,'none');
        const read=await ragQuota(next.pool,f.project),afterRead=await state(f);
        observations.push({boundary:'update',before,beforeRead,afterRead,read,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
        expect(beforeRead).toEqual(before);expect(read).toEqual(f.before);expect(afterRead).toEqual(before);
        expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);expect(fault.sql).toContain('ROLLBACK');
    });
    it('an acknowledged rollback preserves the primary failure and keeps the healthy backend reusable',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'update'),next=faultPool(f.pool,'none');
        await expect(ragQuota(fault.pool,f.project,{limitBytes:150,expectedRevision:0})).rejects.toBe(fault.error);
        expect(fault.fired()).toBe(true);expect(await ragQuota(next.pool,f.project)).toEqual(f.before);
        expect(await state(f)).toEqual(before);expect(next.pid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);
        expect(fault.sql).toContain('ROLLBACK');
    });
    it('a lost rollback ACK preserves the primary failure and discards the uncertain backend after real rollback',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'update','after'),next=faultPool(f.pool,'none');
        await expect(ragQuota(fault.pool,f.project,{limitBytes:150,expectedRevision:0})).rejects.toBe(fault.error);
        expect(await state(f)).toEqual(before);expect(await ragQuota(next.pool,f.project)).toEqual(f.before);
        expect(await state(f)).toEqual(before);expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
    });
    it('a committed update remains durable after a lost ACK and exact retry adds no second audit event',async()=>{
        const f=await fixture(),fault=faultPool(f.pool,'commit','before'),update={limitBytes:150,expectedRevision:0};
        await expect(ragQuota(fault.pool,f.project,update,'committed@test')).rejects.toBe(fault.error);expect(fault.fired()).toBe(true);
        const committed=await state(f),next=faultPool(f.pool,'none');
        expect(await ragQuota(next.pool,f.project,update,'committed@test')).toMatchObject({limitBytes:150,revision:1});
        expect(await state(f)).toEqual(committed);expect(committed.budget).toMatchObject({limit_bytes:'150',revision:'1'});
        expect(committed.events).toHaveLength(2);expect(committed.events[1]).toMatchObject({actor:'committed@test',after_bytes:'150',revision:'1'});
        expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
        observations.push({boundary:'commit',committed,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
    });
    it('normal success commits one update and reuses the healthy backend for a later read',async()=>{
        const f=await fixture(),fault=faultPool(f.pool,'none'),next=faultPool(f.pool,'none');
        expect(await ragQuota(fault.pool,f.project,{limitBytes:150,expectedRevision:0},'success@test')).toMatchObject({limitBytes:150,revision:1});
        expect(await ragQuota(next.pool,f.project)).toMatchObject({limitBytes:150,revision:1});
        expect(next.pid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);
        expect(fault.sql).toContain('COMMIT');expect(fault.sql).not.toContain('ROLLBACK');expect((await state(f)).events).toHaveLength(2);
    });
});
