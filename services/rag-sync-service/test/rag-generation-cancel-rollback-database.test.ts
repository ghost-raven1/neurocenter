import 'reflect-metadata';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,afterEach,describe,expect,it} from 'vitest';
import {RagGenerations} from '../src/rag/rag-generations';
import {RAG_GENERATION_SCHEMA} from '../src/rag/rag-generation-schema';
import {setupRagQuota} from '../src/rag/quota/rag-quota';
import {applyPlatformQuotaPolicy} from '../src/rag/quota/platform-quota';
import {PLATFORM_QUOTA_CACHE_MIGRATION} from '../src/database/migration-definitions';
import {ownedQuotaRollbackUrl} from './platform-quota-rollback.fixture';

const connection=process.env.RAG_GENERATION_CANCEL_TEST_PG_URL;
const project='main',peer='peer';
const profile={provider:'openai',model:'neurocenter/cancel-fixture/sha256/'+'a'.repeat(64),dimension:3};
const policy={defaultBytes:10000,maximumBytes:100000,revision:0,updatedAt:'2026-10-26T00:00:00.000Z',updatedBy:'fixture'};
const fixtures:Array<{dispose:()=>Promise<unknown>}>=[],cleanup:unknown[]=[],observations:unknown[]=[];
afterEach(async()=>{for(const f of fixtures.splice(0))cleanup.push(await f.dispose());});
afterAll(async()=>{
    if(process.env.RAG_GENERATION_CANCEL_EVIDENCE_FILE)await writeFile(process.env.RAG_GENERATION_CANCEL_EVIDENCE_FILE,
        JSON.stringify({cleanup,observations},null,2)+'\n');
});

/** Registered table/quota SQL is retained; real[] only substitutes the unused vector type, without search or inference. */
async function fixture(){
    const url=ownedQuotaRollbackUrl(connection!),database='ragcanceltx_'+randomUUID().replaceAll('-','');
    const chunks=RAG_GENERATION_SCHEMA.match(/CREATE TABLE IF NOT EXISTS rag_chunks \([\s\S]*?\n\);/)?.[0];
    const generations=RAG_GENERATION_SCHEMA.match(/CREATE TABLE IF NOT EXISTS rag_generations \([\s\S]*?\n\);/)?.[0];
    if(!chunks?.includes('embedding vector,')||!generations)throw Error('Registered generation table SQL changed; review this narrow fixture.');
    const admin=new Pool({connectionString:url.href,max:1});let pool:Pool|undefined,observer:Pool|undefined,created=false;
    const dispose=async()=>{
        try{
            await observer?.end();await pool?.end();if(created)await admin.query('DROP DATABASE '+database);
            const databases=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows;
            const sessions=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[database])).rows;
            if(databases.length||sessions.length)throw Error('Owned cancellation fixture resources remain.');
            return{database,dropped:created,databasesRemaining:databases,sessionsRemaining:sessions};
        }finally{await admin.end();}
    };
    try{
        await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:1});observer=new Pool({connectionString:url.href,max:1});
        await pool.query("CREATE FUNCTION public.vector_dims(real[]) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS 'SELECT cardinality($1)';"
            +chunks.replace('embedding vector,','embedding real[],')+generations+PLATFORM_QUOTA_CACHE_MIGRATION.sql);
        await setupRagQuota(pool,policy);await applyPlatformQuotaPolicy(pool,policy);
        const id=randomUUID(),active='initial-'+createHash('md5').update(project).digest('hex'),peerGeneration='initial-'+createHash('md5').update(peer).digest('hex');
        for(const [generation,key,state]of [[active,project,'ready'],[id,project,'building'],[peerGeneration,peer,'ready']]){
            await pool.query('INSERT INTO rag_generations(id,project_key,index_profile,state,source_rows) VALUES($1,$2,$3::jsonb,$4,1)',[generation,key,JSON.stringify(profile),state]);
            const content=key===peer?'peer saved text':'active saved text';
            await pool.query(`INSERT INTO rag_chunks(id,project_key,generation_id,file_path,content,kind,content_hash,embedding)
                VALUES('one',$1,$2,'one.ts',$3,'code',$4,$5::real[])`,[key,generation,content,createHash('sha256').update(content).digest('hex'),generation===id?null:[1,0,0]]);
        }
        const reader=new RagGenerations(pool),activeSource=await reader.source(project,active),peerSource=await reader.source(peer,peerGeneration);
        await pool.query('UPDATE rag_generations SET source_generation=$2,source_snapshot=$3 WHERE id=$1',[id,active,activeSource.hash]);
        const candidateBytes=Number((await pool.query('SELECT public.neurocenter_rag_row_bytes(c) AS bytes FROM rag_chunks c WHERE project_key=$1 AND generation_id=$2',[project,id])).rows[0].bytes);
        const tombstone={profile,sourceGeneration:active,sourceSnapshot:activeSource.hash};
        const value={pool,observer,id,active,peerGeneration,activeSource,peerSource,candidateBytes,tombstone,dispose};fixtures.push(value);return value;
    }catch(error){await dispose();throw error;}
}

/** DELETE and optional COMMIT execute on PostgreSQL; only the delivered ACK or ROLLBACK delivery is faulted. */
function faultPool(pool:Pool,boundary:'delete'|'commit'|'none',rollbackLoss:'none'|'before'|'after'='none'){
    const failure=new Error('Own generation cancel '+boundary+' acknowledgement lost'),rollbackFailure=new Error('Own cancel rollback acknowledgement lost');
    let pid=0,released:Error|boolean|undefined,fired=false;const sql:string[]=[];
    const wrapped={query:pool.query.bind(pool),connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);pid=Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return{query:async(text:string,...args:unknown[])=>{
            sql.push(text);if(text==='ROLLBACK'&&rollbackLoss==='before')throw rollbackFailure;
            const result=await(query as(...values:unknown[])=>Promise<unknown>)(text,...args);
            if(text==='ROLLBACK'&&rollbackLoss==='after')throw rollbackFailure;
            if(!fired&&(boundary==='delete'&&text.startsWith('DELETE FROM rag_chunks WHERE project_key=')||boundary==='commit'&&text==='COMMIT')){
                fired=true;throw failure;
            }
            return result;
        },release:(discard?:Error|boolean)=>{released=discard;client.release(discard);}};
    }}as unknown as Pool;
    return{pool:wrapped,failure,sql,pid:()=>pid,released:()=>released,fired:()=>fired};
}
async function state(f:Awaited<ReturnType<typeof fixture>>){
    return{chunks:(await f.observer.query('SELECT * FROM rag_chunks ORDER BY project_key,generation_id,id')).rows,
        generations:(await f.observer.query('SELECT * FROM rag_generations ORDER BY project_key,id')).rows,
        budgets:(await f.observer.query('SELECT * FROM rag_storage_budget ORDER BY project_key')).rows,
        events:(await f.observer.query('SELECT * FROM rag_quota_events ORDER BY id')).rows,
        settings:(await f.observer.query('SELECT * FROM rag_storage_settings')).rows,
        applied:(await f.observer.query('SELECT * FROM rag_platform_quota_applied')).rows};
}
/** withProject refreshes policy before its source action; neither normal consumer is allowed to finish an old cancellation. */
async function nextSource(f:Awaited<ReturnType<typeof fixture>>,pool:Pool){
    await applyPlatformQuotaPolicy(pool,policy);const afterRefresh=await state(f),reader=new RagGenerations(pool);
    const active=await reader.source(project,f.active),other=await reader.source(peer,f.peerGeneration);
    return{afterRefresh,active,other,afterSource:await state(f)};
}
function cancelled(f:Awaited<ReturnType<typeof fixture>>,before:Awaited<ReturnType<typeof state>>,after:Awaited<ReturnType<typeof state>>){
    expect(after.chunks).toEqual(before.chunks.filter(row=>row.generation_id!==f.id));
    expect(after.generations.filter(row=>row.id!==f.id)).toEqual(before.generations.filter(row=>row.id!==f.id));
    expect(after.generations.find(row=>row.id===f.id)).toMatchObject({state:'cancelled',source_generation:f.active,source_snapshot:f.activeSource.hash});
    expect(after.budgets.filter(row=>row.project_key!==project)).toEqual(before.budgets.filter(row=>row.project_key!==project));
    const prior=before.budgets.find(row=>row.project_key===project)!,current=after.budgets.find(row=>row.project_key===project)!;
    expect(Number(prior.used_bytes)-Number(current.used_bytes)).toBe(f.candidateBytes);
    expect({...current,used_bytes:prior.used_bytes}).toEqual(prior);expect(after.events).toEqual(before.events);
    expect(after.settings).toEqual(before.settings);expect(after.applied).toEqual(before.applied);
}

describe.skipIf(connection===undefined).sequential('Generation cancellation rollback ownership on actual PostgreSQL',()=>{
    for(const loss of ['before','after']as const)it('a failed cancel with rollback '+loss+' cannot lose candidate rows during the next policy refresh and source read',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'delete',loss),next=faultPool(f.pool,'none');
        await expect(new RagGenerations(fault.pool).cancel(project,f.id,f.tombstone)).rejects.toBe(fault.failure);expect(fault.fired()).toBe(true);
        const afterFailure=await state(f),source=await nextSource(f,next.pool);
        observations.push({boundary:'delete',rollbackLoss:loss,before,afterFailure,...source,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
        expect(afterFailure).toEqual(before);expect(source.afterRefresh).toEqual(before);expect(source.afterSource).toEqual(before);
        expect(source.active).toEqual(f.activeSource);expect(source.other).toEqual(f.peerSource);
        expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
    });
    it('a confirmed rollback preserves all candidate bytes and reuses its healthy backend',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'delete'),next=faultPool(f.pool,'none');
        await expect(new RagGenerations(fault.pool).cancel(project,f.id,f.tombstone)).rejects.toBe(fault.failure);
        const source=await nextSource(f,next.pool);expect(await state(f)).toEqual(before);
        expect(source.active).toEqual(f.activeSource);expect(source.other).toEqual(f.peerSource);
        expect(next.pid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);
    });
    it('a lost COMMIT ACK retains exactly one durable cancellation and exact replay cannot delete active or peer rows',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'commit','before'),next=faultPool(f.pool,'none');
        await expect(new RagGenerations(fault.pool).cancel(project,f.id,f.tombstone)).rejects.toBe(fault.failure);expect(fault.fired()).toBe(true);
        const committed=await state(f),source=await nextSource(f,next.pool);cancelled(f,before,committed);
        expect(await new RagGenerations(next.pool).cancel(project,f.id,f.tombstone)).toMatchObject({id:f.id,state:'cancelled'});
        const retried=await state(f);expect(retried).toEqual(committed);expect(source.active).toEqual(f.activeSource);expect(source.other).toEqual(f.peerSource);
        expect(next.pid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
        observations.push({boundary:'commit',before,committed,retried,pid:fault.pid(),nextPid:next.pid(),released:fault.released()});
    });
    it('normal cancellation and replay release only the candidate quota and reuse the healthy backend',async()=>{
        const f=await fixture(),before=await state(f),fault=faultPool(f.pool,'none'),next=faultPool(f.pool,'none');
        expect(await new RagGenerations(fault.pool).cancel(project,f.id,f.tombstone)).toMatchObject({id:f.id,state:'cancelled'});
        const committed=await state(f);cancelled(f,before,committed);
        expect(await new RagGenerations(next.pool).cancel(project,f.id,f.tombstone)).toMatchObject({id:f.id,state:'cancelled'});
        const source=await nextSource(f,next.pool);expect(await state(f)).toEqual(committed);
        expect(source.active).toEqual(f.activeSource);expect(source.other).toEqual(f.peerSource);
        expect(next.pid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);expect(fault.sql).not.toContain('ROLLBACK');
    });
});
