import 'reflect-metadata';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {afterAll,afterEach,describe,expect,it} from 'vitest';
import {RagDb} from '../src/rag/rag-db';
import {RAG_GENERATION_SCHEMA} from '../src/rag/rag-generation-schema';
import {setupRagQuota} from '../src/rag/quota/rag-quota';
import {ownedQuotaRollbackUrl} from './platform-quota-rollback.fixture';

const connection=process.env.RAG_EXPORT_ROLLBACK_TEST_PG_URL,project='main',peer='peer';
const fixtures:Array<{dispose:()=>Promise<unknown>}>=[],restores:Array<()=>void>=[],cleanup:unknown[]=[],observations:unknown[]=[];
afterEach(async()=>{for(const restore of restores.splice(0))restore();for(const f of fixtures.splice(0))cleanup.push(await f.dispose());});
afterAll(async()=>{
    if(process.env.RAG_EXPORT_ROLLBACK_EVIDENCE_FILE)await writeFile(process.env.RAG_EXPORT_ROLLBACK_EVIDENCE_FILE,
        JSON.stringify({cleanup,observations},null,2)+'\n');
});

/** No setup()/summary/search runs: registered chunk/quota SQL uses null vectors and an unused vector-operation tripwire. */
async function fixture(){
    const url=ownedQuotaRollbackUrl(connection!),database='ragexporttx_'+randomUUID().replaceAll('-','');
    const chunks=RAG_GENERATION_SCHEMA.match(/CREATE TABLE IF NOT EXISTS rag_chunks \([\s\S]*?\n\);/)?.[0];
    if(!chunks?.includes('embedding vector,'))throw Error('Registered chunk SQL changed; review this narrow export fixture.');
    const admin=new Pool({connectionString:url.href,max:1});let store:RagDb|undefined,pool:Pool|undefined,observer:Pool|undefined,created=false;
    const dispose=async()=>{
        try{
            await observer?.end();await store?.close();if(created)await admin.query('DROP DATABASE '+database);
            const databases=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows;
            const sessions=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[database])).rows;
            if(databases.length||sessions.length)throw Error('Owned export fixture resources remain.');
            return{database,dropped:created,databasesRemaining:databases,sessionsRemaining:sessions};
        }finally{await admin.end();}
    };
    try{
        await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        store=new RagDb({url:url.href});pool=(store as unknown as{pool:Pool}).pool;pool.options.max=1;
        observer=new Pool({connectionString:url.href,max:1});
        await pool.query(`CREATE FUNCTION public.vector_dims(real[]) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT AS $tripwire$
            BEGIN RAISE EXCEPTION 'Vector operations are outside the export rollback fixture'; END $tripwire$;`
            +chunks.replace('embedding vector,','embedding real[],'));
        await setupRagQuota(pool,{defaultBytes:10000,maximumBytes:100000});
        const generation='initial-'+createHash('md5').update(project).digest('hex');
        for(const key of [project,peer])await pool.query(`INSERT INTO rag_chunks(id,project_key,generation_id,file_path,content,kind,content_hash,embedding)
            VALUES('one',$1,$2,'one.ts',$3,'code',$4,NULL)`,[key,generation,key+' saved bytes',createHash('sha256').update(key).digest('hex')]);
        const value={store,pool,observer,generation,dispose};fixtures.push(value);return value;
    }catch(error){await dispose();throw error;}
}

/** Only the first real rowsPage result ACK is lost; the next ordinary pool checkout uses the original driver unchanged. */
function faultCheckout(pool:Pool,rollbackLoss:'none'|'before'|'after'){
    const failure=new Error('Own export rows acknowledgement lost'),rollbackFailure=new Error('Own export rollback acknowledgement lost');
    const original=pool.connect,connect=pool.connect.bind(pool),sql:string[]=[];
    let pid=0,released:Error|boolean|undefined,fired=false,selectedRows=0;
    restores.push(()=>{pool.connect=original;});
    pool.connect=(async()=>{
        pool.connect=original;const client=await connect(),query=client.query.bind(client);
        pid=Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return{query:async(text:string,...args:unknown[])=>{
            sql.push(text);if(text==='ROLLBACK'&&rollbackLoss==='before')throw rollbackFailure;
            const result=await(query as(...values:unknown[])=>Promise<unknown>)(text,...args);
            if(text==='ROLLBACK'&&rollbackLoss==='after')throw rollbackFailure;
            if(!fired&&text.startsWith('SELECT id, file_path, content, description, start_line, end_line, language, ')
                &&text.includes('FROM rag_chunks WHERE project_key=')){
                selectedRows=(result as{rows:unknown[]}).rows.length;fired=true;throw failure;
            }
            return result;
        },release:(discard?:Error|boolean)=>{released=discard;client.release(discard);}}as unknown as PoolClient;
    })as Pool['connect'];
    return{failure,rollbackFailure,sql,pid:()=>pid,released:()=>released,fired:()=>fired,selectedRows:()=>selectedRows};
}
async function state(f:Awaited<ReturnType<typeof fixture>>){
    return{chunks:(await f.observer.query('SELECT * FROM rag_chunks ORDER BY project_key,id')).rows,
        budgets:(await f.observer.query('SELECT * FROM rag_storage_budget ORDER BY project_key')).rows,
        events:(await f.observer.query('SELECT * FROM rag_quota_events ORDER BY id')).rows,
        settings:(await f.observer.query('SELECT * FROM rag_storage_settings')).rows};
}

describe.skipIf(connection===undefined).sequential('Export page READ ONLY transaction ownership on actual PostgreSQL',()=>{
    for(const loss of ['before','after','none']as const){
        it('lost rows ACK and rollback '+loss+' preserve the original export error without poisoning the next quota update',async()=>{
            const f=await fixture(),before=await state(f),fault=faultCheckout(f.pool,loss);
            await expect(f.store.exportPage(project,f.generation,100,0)).rejects.toBe(fault.failure);
            expect(fault.fired()).toBe(true);expect(fault.selectedRows()).toBe(1);
            expect(fault.sql).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(fault.sql).toContain('ROLLBACK');
            expect(fault.sql.some(query=>/vector_norm|vector_dims|WITH stats/.test(query))).toBe(false);
            const afterFailure=await state(f);let updated:unknown,nextError:unknown;
            try{updated=await f.store.quota(project,{limitBytes:20000,expectedRevision:0},'healthy-after-export@test');}catch(error){nextError=error;}
            const nextPid=Number((await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid),after=await state(f);
            observations.push({rollbackLoss:loss,before,afterFailure,after,updated,selectedRows:fault.selectedRows(),sql:fault.sql,
                nextError:nextError?{code:(nextError as{code?:string}).code,message:(nextError as Error).message}:null,
                pid:fault.pid(),nextPid,released:fault.released()});
            expect(afterFailure).toEqual(before);expect(nextError).toBeUndefined();expect(updated).toMatchObject({limitBytes:20000,revision:1});
            expect(after.chunks).toEqual(before.chunks);expect(after.settings).toEqual(before.settings);
            expect(after.budgets.find(row=>row.project_key===peer)).toEqual(before.budgets.find(row=>row.project_key===peer));
            expect(after.budgets.find(row=>row.project_key===project)).toEqual({...before.budgets.find(row=>row.project_key===project),limit_bytes:'20000',revision:'1'});
            expect(after.events.slice(0,-1)).toEqual(before.events);expect(after.events.at(-1)).toMatchObject({actor:'healthy-after-export@test',after_bytes:'20000',revision:'1'});
            if(loss==='none'){expect(nextPid).toBe(fault.pid());expect(fault.released()).not.toBe(true);}
            else{expect(nextPid).not.toBe(fault.pid());expect(fault.released()).toBe(true);}
        });
    }
});
