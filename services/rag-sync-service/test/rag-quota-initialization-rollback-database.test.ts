import 'reflect-metadata';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,afterEach,describe,expect,it} from 'vitest';
import {ragQuota,reserveLegacyRagQuota,setupRagQuota} from '../src/rag/quota/rag-quota';
import {RAG_QUOTA_MIGRATION,RAG_QUOTA_SCHEMA} from '../src/rag/quota/rag-quota-schema';
import {ownedQuotaRollbackUrl} from './platform-quota-rollback.fixture';

type Mode='cold'|'warm'|'legacy';
const connection=process.env.RAG_QUOTA_INITIALIZATION_TEST_PG_URL,project='project';
const initialPolicy={defaultBytes:100,maximumBytes:300},failedPolicy={defaultBytes:150,maximumBytes:500};
const fixtures:Array<{dispose:()=>Promise<unknown>}>=[],cleanup:unknown[]=[],observations:unknown[]=[];
afterEach(async()=>{for(const value of fixtures.splice(0))cleanup.push(await value.dispose());});
afterAll(async()=>{
    if(process.env.RAG_QUOTA_INITIALIZATION_EVIDENCE_FILE)await writeFile(process.env.RAG_QUOTA_INITIALIZATION_EVIDENCE_FILE,
        JSON.stringify({cleanup,observations},null,2)+'\n');
});

/** Only chunk storage is a fixture; production quota DDL, journal, triggers and business SQL execute unchanged. */
async function fixture(mode:Mode){
    const url=ownedQuotaRollbackUrl(connection!),database='ragquotainit_'+randomUUID().replaceAll('-','');
    const admin=new Pool({connectionString:url.href,max:1});let pool:Pool|undefined,observer:Pool|undefined,created=false;
    const dispose=async()=>{
        try{
            await observer?.end();await pool?.end();if(created)await admin.query('DROP DATABASE '+database);
            const databases=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows;
            const sessions=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[database])).rows;
            if(databases.length||sessions.length)throw Error('Owned quota initialization resources remain.');
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
        await pool.query("INSERT INTO rag_chunks(id,project_key,file_path,content,kind,content_hash) VALUES('row',$1,'a.ts','saved','code',$2)",[project,'a'.repeat(64)]);
        if(mode!=='cold')await setupRagQuota(pool,initialPolicy);
        const value={pool,observer,database,dispose};fixtures.push(value);return value;
    }catch(error){await dispose();throw error;}
}

/** Fault only ACK delivery after the real mutation or COMMIT; an undelivered rollback leaves its real transaction open. */
function faultPool(pool:Pool,mode:Mode,boundary:'business'|'commit'|'none',rollbackLoss:'none'|'before'|'after'='none'){
    const failure=new Error('Own '+mode+' quota '+boundary+' acknowledgement lost'),rollbackFailure=new Error('Own quota rollback not delivered');
    const sql:string[]=[];let pid=0,released:Error|boolean|undefined,fired=false;
    const wrapped={connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        pid=Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return{query:async(text:string,...args:unknown[])=>{
            sql.push(text);if(text==='ROLLBACK'&&rollbackLoss==='before')throw rollbackFailure;
            const result=await(query as(...values:unknown[])=>Promise<unknown>)(text,...args);
            if(text==='ROLLBACK'&&rollbackLoss==='after')throw rollbackFailure;
            const mutation=mode==='cold'?text.startsWith('INSERT INTO neurocenter_rag_migrations(version,checksum)')
                :mode==='warm'?text.startsWith('INSERT INTO rag_storage_settings(singleton,default_bytes,maximum_bytes)')
                    :text.startsWith('UPDATE rag_storage_budget SET limit_bytes=');
            if(!fired&&(boundary==='business'&&mutation||boundary==='commit'&&text==='COMMIT')){fired=true;throw failure;}
            return result;
        },release:(discard?:Error|boolean)=>{released=discard;client.release(discard);}};
    }}as unknown as Pool;
    return{pool:wrapped,failure,sql,pid:()=>pid,released:()=>released,fired:()=>fired};
}

async function state(f:Awaited<ReturnType<typeof fixture>>){
    const tables=(await f.observer.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
        AND tablename IN ('rag_storage_settings','rag_storage_budget','rag_quota_events','neurocenter_rag_migrations') ORDER BY tablename`)).rows.map(row=>row.tablename as string);
    return{tables,settings:tables.includes('rag_storage_settings')?(await f.observer.query('SELECT default_bytes,maximum_bytes FROM rag_storage_settings')).rows:[],
        budgets:tables.includes('rag_storage_budget')?(await f.observer.query('SELECT project_key,used_bytes,limit_bytes,revision FROM rag_storage_budget ORDER BY project_key')).rows:[],
        events:tables.includes('rag_quota_events')?(await f.observer.query('SELECT project_key,actor,before_bytes,after_bytes,revision FROM rag_quota_events ORDER BY id')).rows:[],
        migrations:tables.includes('neurocenter_rag_migrations')?(await f.observer.query('SELECT version,checksum,applied_at FROM neurocenter_rag_migrations ORDER BY version')).rows:[],
        chunks:(await f.observer.query('SELECT id,project_key,file_path,content,kind,content_hash FROM rag_chunks ORDER BY id')).rows};
}
function expectedCold(value:Awaited<ReturnType<typeof state>>,limit:number){
    expect(value.settings).toEqual([{default_bytes:String(limit),maximum_bytes:'300'}]);
    expect(value.budgets).toEqual([{project_key:project,used_bytes:'87',limit_bytes:String(limit),revision:'0'}]);
    expect(value.events).toHaveLength(1);expect(value.events[0]).toMatchObject({project_key:project,before_bytes:null,after_bytes:String(limit),revision:'0'});
    expect(value.migrations).toHaveLength(1);expect(value.migrations[0]).toMatchObject({version:RAG_QUOTA_MIGRATION,checksum:createHash('sha256').update(RAG_QUOTA_SCHEMA).digest('hex')});
}
const change=(pool:Pool,mode:Mode)=>mode==='legacy'?reserveLegacyRagQuota(pool,project,200):setupRagQuota(pool,mode==='cold'?{...failedPolicy,maximumBytes:300}:failedPolicy);
const recover=(pool:Pool,mode:Mode)=>mode==='cold'?setupRagQuota(pool,initialPolicy):ragQuota(pool,project);

describe.skipIf(connection===undefined).sequential('Quota initialization and legacy reservation rollback ownership on real PostgreSQL',()=>{
    for(const mode of ['cold','warm','legacy']as const){
        it(mode+': a real next operation cannot commit an unacknowledged failed quota transaction',async()=>{
            const f=await fixture(mode),before=await state(f),fault=faultPool(f.pool,mode,'business','before');
            await expect(change(fault.pool,mode)).rejects.toBe(fault.failure);expect(fault.fired()).toBe(true);
            const afterFailure=await state(f),next=faultPool(f.pool,mode,'none');
            const recovered=await recover(next.pool,mode),afterNext=await state(f);
            observations.push({mode,boundary:'business',before,afterFailure,afterNext,recovered,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
            expect(afterFailure).toEqual(before);expect(afterNext.chunks).toEqual(before.chunks);
            if(mode==='cold')expectedCold(afterNext,100);else{expect(afterNext).toEqual(before);expect(recovered).toMatchObject({limitBytes:100,maximumBytes:300,revision:0});}
            expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);expect(fault.sql).toContain('ROLLBACK');
        });
        it(mode+': an acknowledged rollback preserves the original error and reuses the healthy backend',async()=>{
            const f=await fixture(mode),before=await state(f),fault=faultPool(f.pool,mode,'business'),next=faultPool(f.pool,mode,'none');
            await expect(change(fault.pool,mode)).rejects.toBe(fault.failure);expect(fault.fired()).toBe(true);expect(await state(f)).toEqual(before);
            await recover(next.pool,mode);const after=await state(f);
            if(mode==='cold')expectedCold(after,100);else expect(after).toEqual(before);
            expect(after.chunks).toEqual(before.chunks);expect(next.pid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);
        });
        it(mode+': a lost rollback ACK preserves the original failure and discards the backend after actual rollback',async()=>{
            const f=await fixture(mode),before=await state(f),fault=faultPool(f.pool,mode,'business','after'),next=faultPool(f.pool,mode,'none');
            await expect(change(fault.pool,mode)).rejects.toBe(fault.failure);expect(fault.fired()).toBe(true);expect(await state(f)).toEqual(before);
            await recover(next.pool,mode);const after=await state(f);
            if(mode==='cold')expectedCold(after,100);else expect(after).toEqual(before);
            expect(after.chunks).toEqual(before.chunks);expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
        });
        it(mode+': a committed-but-lost ACK stays durable and exact retry adds no migration, quota or audit duplicate',async()=>{
            const f=await fixture(mode),before=await state(f),fault=faultPool(f.pool,mode,'commit','before');
            await expect(change(fault.pool,mode)).rejects.toBe(fault.failure);expect(fault.fired()).toBe(true);
            const committed=await state(f),next=faultPool(f.pool,mode,'none');await change(next.pool,mode);const retried=await state(f);
            observations.push({mode,boundary:'commit',committed,retried,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
            expect(retried).toEqual(committed);expect(committed.chunks).toEqual(before.chunks);expect(committed.migrations).toHaveLength(1);
            if(mode==='cold')expectedCold(committed,150);
            else if(mode==='warm'){expect(committed.settings).toEqual([{default_bytes:'150',maximum_bytes:'500'}]);expect(committed.events).toHaveLength(1);}
            else{expect(committed.budgets[0]).toMatchObject({limit_bytes:'200',revision:'0'});expect(committed.events).toHaveLength(2);
                expect(committed.events[1]).toMatchObject({actor:'system:legacy-rag-migration',after_bytes:'200',revision:'0'});}
            expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
        });
    }
});
