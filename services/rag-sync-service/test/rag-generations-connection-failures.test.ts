import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {RagGenerations} from '../src/rag/rag-generations';

const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
const profile={provider:'openai',model:'neurocenter/test/sha256/'+'a'.repeat(64),dimension:3};

/** Server locks and an independent observer are real; only exact acknowledgement boundaries are faulted. */
describe.skipIf(!connection).sequential('RAG generation sessions after uncertain lock acknowledgements',()=>{
    const database='nc_rag_session_'+randomUUID().replaceAll('-','');
    let admin:Pool,pool:Pool,observer:Pool,created=false;
    beforeAll(async()=>{
        const url=new URL(connection!);
        if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432')throw Error('Configure an explicitly owned loopback PostgreSQL port other than5432.');
        url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});
        await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:3});observer=new Pool({connectionString:url.href,max:1});
        await pool.query(`CREATE TABLE rag_generations(id text PRIMARY KEY,project_key text,index_profile jsonb,state text,
            source_generation text,source_snapshot text,source_rows bigint DEFAULT 0,processed_rows bigint DEFAULT 0,
            snapshot_hash text,receipt_hash text,error text,updated_at timestamptz DEFAULT now())`);
    });
    afterEach(()=>vi.restoreAllMocks());
    afterAll(async()=>{await observer?.end();await pool?.end();if(created)await admin.query('DROP DATABASE '+database);await admin?.end();});
    async function fixture(state='cancelled'){
        const id=randomUUID(),project='p-'+randomUUID();
        await pool.query('INSERT INTO rag_generations(id,project_key,index_profile,state,source_generation,source_snapshot) VALUES($1,$2,$3::jsonb,$4,$5,$6)',
            [id,project,JSON.stringify(profile),state,randomUUID(),'a'.repeat(64)]);
        return{id,project,generations:new RagGenerations(pool)};
    }
    async function unlocked(id:string){
        const db=await observer.connect();
        try{
            const acquired=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',['rag-reindex:'+id])).rows[0].locked;
            if(acquired)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['rag-reindex:'+id]);return acquired;
        }finally{db.release();}
    }
    function checkout(mode?:'acquire'|'unlock'){
        const connect=pool.connect.bind(pool),error=new Error('own lost '+mode+' acknowledgement');let fired=false,pid=0;
        vi.spyOn(pool,'connect').mockImplementationOnce(async()=>{
            const client=await connect(),query=client.query.bind(client);pid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            client.query=(async(text:string,...args:unknown[])=>{
                if(!fired&&mode==='unlock'&&text.includes('pg_advisory_unlock(')){fired=true;throw error;}
                const result=await (query as (...input:unknown[])=>Promise<unknown>)(text,...args);
                if(!fired&&mode==='acquire'&&text.includes('pg_try_advisory_lock(')){fired=true;throw error;}return result;
            })as PoolClient['query'];return client;
        });return{error,pid:()=>pid};
    }
    const currentPid=async()=>Number((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    it('discards a real server lock after its acquisition acknowledgement is lost',async()=>{
        const f=await fixture('building'),fault=checkout('acquire');
        await expect(f.generations.build(f.project,f.id,async()=>[])).rejects.toBe(fault.error);
        expect(await unlocked(f.id)).toBe(true);expect(await currentPid()).not.toBe(fault.pid());
    });
    it('keeps the terminal result but drops its locked session after unlock failure',async()=>{
        const f=await fixture(),fault=checkout('unlock');
        expect((await f.generations.build(f.project,f.id,async()=>[])).state).toBe('cancelled');
        expect(await unlocked(f.id)).toBe(true);expect(await currentPid()).not.toBe(fault.pid());
    });
    it('preserves its original error when unlock also fails',async()=>{
        const f=await fixture('building'),original=new Error('original generation error'),fault=checkout('unlock');
        vi.spyOn(f.generations,'get').mockRejectedValueOnce(original);
        await expect(f.generations.build(f.project,f.id,async()=>[])).rejects.toBe(original);
        expect(await unlocked(f.id)).toBe(true);expect(await currentPid()).not.toBe(fault.pid());
    });
    it('reuses the healthy session after a normal terminal generation result',async()=>{
        const f=await fixture(),checkoutResult=checkout();
        expect((await f.generations.build(f.project,f.id,async()=>[])).state).toBe('cancelled');
        expect(await unlocked(f.id)).toBe(true);expect(await currentPid()).toBe(checkoutResult.pid());
    });
    it('keeps a building generation and healthy session after acknowledged lock contention',async()=>{
        const f=await fixture('building'),holder=await observer.connect(),checkoutResult=checkout(),embed=vi.fn(async()=>[]);
        try{
            await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['rag-reindex:'+f.id]);
            expect((await f.generations.build(f.project,f.id,embed)).state).toBe('building');expect(embed).not.toHaveBeenCalled();
            expect(await currentPid()).toBe(checkoutResult.pid());
            expect((await holder.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',['rag-reindex:'+f.id])).rows[0].unlocked).toBe(true);
        }finally{holder.release();}
    });
});
