import 'reflect-metadata';
import {ConflictException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,afterEach,describe,expect,it} from 'vitest';
import {RAG_GENERATION_SCHEMA} from '../src/rag/rag-generation-schema';
import {projectSearchInput,searchProjectIndex} from '../src/rag/rag-search';
import {ragQuota,setupRagQuota} from '../src/rag/quota/rag-quota';
import {ownedQuotaRollbackUrl} from './platform-quota-rollback.fixture';

const connection=process.env.RAG_SEARCH_ROLLBACK_TEST_PG_URL,project='prj-search',peer='prj-peer';
const profile={provider:'openai',model:'neurocenter/search-fixture/sha256/'+'a'.repeat(64),dimension:3};
const conflictMessage='Индекс проекта изменён или ещё не синхронизирован полностью.';
const fixtures:Array<{dispose:()=>Promise<unknown>}>=[],cleanup:unknown[]=[],observations:unknown[]=[];
afterEach(async()=>{for(const value of fixtures.splice(0))cleanup.push(await value.dispose());});
afterAll(async()=>{
    if(process.env.RAG_SEARCH_ROLLBACK_EVIDENCE_FILE)await writeFile(process.env.RAG_SEARCH_ROLLBACK_EVIDENCE_FILE,
        JSON.stringify({cleanup,observations},null,2)+'\n');
});

/** Registered search tables and quota SQL run unchanged; real[] substitutes only the unused vector type. */
async function fixture(){
    const url=ownedQuotaRollbackUrl(connection!),database='ragsearchtx_'+randomUUID().replaceAll('-','');
    const chunks=RAG_GENERATION_SCHEMA.match(/CREATE TABLE IF NOT EXISTS rag_chunks \([\s\S]*?\n\);/)?.[0];
    const indexState=RAG_GENERATION_SCHEMA.match(/CREATE TABLE IF NOT EXISTS rag_index_state \([\s\S]*?\n\);/)?.[0];
    if(!chunks?.includes('embedding vector,')||!indexState)throw Error('Registered search table SQL changed; review this narrow fixture.');
    const admin=new Pool({connectionString:url.href,max:1});let pool:Pool|undefined,observer:Pool|undefined,created=false;
    const dispose=async()=>{
        try{
            await observer?.end();await pool?.end();if(created)await admin.query('DROP DATABASE '+database);
            const databases=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows;
            const sessions=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[database])).rows;
            if(databases.length||sessions.length)throw Error('Owned search fixture resources remain.');
            return{database,dropped:created,databasesRemaining:databases,sessionsRemaining:sessions};
        }finally{await admin.end();}
    };
    try{
        await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:1});observer=new Pool({connectionString:url.href,max:1});
        await pool.query("CREATE FUNCTION public.vector_dims(real[]) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS 'SELECT cardinality($1)';"
            +chunks.replace('embedding vector,','embedding real[],')+indexState);
        await setupRagQuota(pool,{defaultBytes:10000,maximumBytes:100000});
        const generation=randomUUID(),peerGeneration=randomUUID();
        for(const [key,id]of [[project,generation],[peer,peerGeneration]]){
            const content=key===project?'saved project knowledge':'saved peer knowledge';
            await pool.query(`INSERT INTO rag_chunks(id,project_key,generation_id,file_path,content,kind,content_hash)
                VALUES('saved',$1,$2,'saved.ts',$3,'code',$4)`,[key,id,content,createHash('sha256').update(content).digest('hex')]);
            await pool.query(`INSERT INTO rag_index_state(project_key,generation_id,index_profile,complete,snapshot_hash,snapshot_rows)
                VALUES($1,$2,$3::jsonb,false,$4,1)`,[key,id,JSON.stringify(profile),'b'.repeat(64)]);
        }
        const initialQuota=await ragQuota(pool,project);
        const input=projectSearchInput({projectId:project,generation,revision:1,dataRevision:2,profile,snapshot:'b'.repeat(64),embedding:[1,0,0]});
        const value={pool,observer,input,initialQuota,dispose};fixtures.push(value);return value;
    }catch(error){await dispose();throw error;}
}

/** Every search/quota statement executes on PostgreSQL; only ROLLBACK delivery or its executed ACK is lost. */
function faultPool(pool:Pool,rollbackLoss?:'none'|'before'|'after'){
    const rollbackFailure=new Error('Own search rollback '+(rollbackLoss??'none')+' acknowledgement lost'),sql:string[]=[];
    let pid=0,released:Error|boolean|undefined,checkout:unknown,rollbackTransaction:unknown,rollbackExecuted=false;
    const wrapped={connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        checkout=(await query("SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0];
        pid=Number((checkout as {pid:number}).pid);
        return{query:async(text:string,...args:unknown[])=>{
            sql.push(text);
            if(text==='ROLLBACK'&&rollbackLoss!==undefined){
                rollbackTransaction=(await query("SELECT current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0];
                if(rollbackLoss==='before')throw rollbackFailure;
            }
            const result=await(query as(...values:unknown[])=>Promise<unknown>)(text,...args);
            if(text==='ROLLBACK'){rollbackExecuted=true;if(rollbackLoss==='after')throw rollbackFailure;}
            return result;
        },release:(discard?:Error|boolean)=>{released=discard;client.release(discard);}};
    }}as unknown as Pool;
    return{pool:wrapped,rollbackFailure,sql,pid:()=>pid,released:()=>released,checkout:()=>checkout,rollbackTransaction:()=>rollbackTransaction,rollbackExecuted:()=>rollbackExecuted};
}

async function state(f:Awaited<ReturnType<typeof fixture>>){
    return{chunks:(await f.observer.query('SELECT * FROM rag_chunks ORDER BY project_key,generation_id,id')).rows,
        indexes:(await f.observer.query('SELECT * FROM rag_index_state ORDER BY project_key,generation_id')).rows,
        budgets:(await f.observer.query('SELECT * FROM rag_storage_budget ORDER BY project_key')).rows,
        events:(await f.observer.query('SELECT * FROM rag_quota_events ORDER BY id')).rows,
        settings:(await f.observer.query('SELECT * FROM rag_storage_settings')).rows,
        migrations:(await f.observer.query('SELECT * FROM neurocenter_rag_migrations ORDER BY version')).rows};
}

describe.skipIf(connection===undefined).sequential('Incomplete project search rollback ownership on actual PostgreSQL',()=>{
    for(const loss of ['none','before','after']as const)it('natural search conflict with rollback '+loss+' permits the next normal quota writer without losing saved knowledge',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,loss),next=faultPool(f.pool);
        const error=await searchProjectIndex(fault.pool,f.input).then(()=>{throw Error('Incomplete index unexpectedly searched.');},reason=>reason as Error);
        expect(error).toBeInstanceOf(ConflictException);expect(error).toMatchObject({status:409,message:conflictMessage});expect(error).not.toBe(fault.rollbackFailure);
        expect(fault.sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(fault.sql).toContain('ROLLBACK');expect(fault.sql).not.toContain('COMMIT');
        expect(fault.sql.some(sql=>sql.includes('eligible AS MATERIALIZED')||sql.includes('embedding<=>'))).toBe(false);
        expect(fault.rollbackTransaction()).toEqual({read_only:'on',isolation:'repeatable read'});expect(fault.rollbackExecuted()).toBe(loss!=='before');
        const afterFailure=await state(f);
        const write=await ragQuota(next.pool,project,{limitBytes:15000,expectedRevision:0},'after-search@test')
            .then(quota=>({ok:true as const,quota}),failure=>({ok:false as const,error:{code:(failure as {code?:string}).code,message:(failure as Error).message}}));
        const afterWrite=await state(f);
        observations.push({rollbackLoss:loss,error:{name:error.name,message:error.message,status:(error as ConflictException).getStatus()},
            before,afterFailure,afterWrite,write,pid:fault.pid(),nextPid:next.pid(),released:fault.released(),checkout:next.checkout(),rollbackExecuted:fault.rollbackExecuted()});
        expect(afterFailure).toEqual(before);expect(write).toMatchObject({ok:true,quota:{...f.initialQuota,limitBytes:15000,revision:1,availableBytes:15000-f.initialQuota.usedBytes}});
        expect(next.checkout()).toMatchObject({read_only:'off',isolation:'read committed'});
        expect(next.sql.some(sql=>sql.startsWith('UPDATE rag_storage_budget SET limit_bytes='))).toBe(true);
        if(loss==='none'){expect(next.pid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);}
        else{expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);}
        expect(afterWrite.chunks).toEqual(before.chunks);expect(afterWrite.indexes).toEqual(before.indexes);
        expect(afterWrite.settings).toEqual(before.settings);expect(afterWrite.migrations).toEqual(before.migrations);
        expect(afterWrite.budgets.filter(row=>row.project_key!==project)).toEqual(before.budgets.filter(row=>row.project_key!==project));
        expect(afterWrite.budgets.find(row=>row.project_key===project)).toMatchObject({used_bytes:String(f.initialQuota.usedBytes),limit_bytes:'15000',revision:'1'});
        expect(afterWrite.events.slice(0,-1)).toEqual(before.events);expect(afterWrite.events).toHaveLength(before.events.length+1);
        expect(afterWrite.events.at(-1)).toMatchObject({project_key:project,actor:'after-search@test',before_bytes:'10000',after_bytes:'15000',revision:'1'});
    });
});
