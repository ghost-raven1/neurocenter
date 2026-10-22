import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {ProjectReindexService} from '../src/models/project-reindex.service';
import type {ModelsService} from '../src/models/models.service';
import type {ProjectRagCoordinator} from '../src/models/project-rag-coordinator';
import type {ModelRuntime} from '../src/models/model-runtime';
import type {DeviceJobs} from '../src/devices/device-jobs';
import {RagGenerations} from '../../rag-sync-service/src/rag/rag-generations';

const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
const profile={provider:'openai',model:'neurocenter/model/sha256/'+'a'.repeat(64),dimension:3};

/** Catalog cancellation and generation deletion use real SQL; transport and identity boundaries stay explicit. */
describe.skipIf(!connection).sequential('Cancellation of immutable applied RAG plans',()=>{
    const database='nc_reindex_cancel_'+randomUUID().replaceAll('-','');
    let admin:Pool,pool:Pool,observer:Pool,created=false;
    beforeAll(async()=>{
        const url=new URL(connection!);
        if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432')throw Error('Configure an explicitly owned loopback PostgreSQL port other than5432.');
        url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:5});observer=new Pool({connectionString:url.href,max:1});
        await pool.query(`CREATE TABLE projects(id text PRIMARY KEY);
            CREATE TABLE project_reindex_plans(id uuid PRIMARY KEY,project_id text,state text,digest text,data jsonb,approved boolean DEFAULT true,
                progress int DEFAULT 100,message text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),connection_job_id uuid,connection_error text);
            CREATE TABLE project_embedding_settings(project_id text PRIMARY KEY,active_generation text);
            CREATE TABLE rag_generations(id text PRIMARY KEY,project_key text,index_profile jsonb,state text,source_generation text,source_snapshot text,
                source_rows bigint DEFAULT 0,processed_rows bigint DEFAULT 0,snapshot_hash text,receipt_hash text,error text,updated_at timestamptz DEFAULT now());
            CREATE TABLE rag_chunks(id text,project_key text,generation_id text,content text);`);
    });
    afterEach(()=>vi.restoreAllMocks());
    afterAll(async()=>{await observer?.end();await pool?.end();if(created)await admin.query('DROP DATABASE '+database);await admin?.end();});
    async function fixture(state='applied',activePlan=false){
        const id=randomUUID(),active=activePlan?id:randomUUID(),project='project-'+randomUUID(),source=randomUUID(),data={profile,context:{generation:source},sourceSnapshot:'b'.repeat(64)};
        await pool.query('INSERT INTO projects VALUES($1)',[project]);
        await pool.query('INSERT INTO project_embedding_settings VALUES($1,$2)',[project,active]);
        await pool.query('INSERT INTO project_reindex_plans(id,project_id,state,digest,data) VALUES($1,$2,$3,$4,$5::jsonb)',[id,project,state,'c'.repeat(64),JSON.stringify(data)]);
        await pool.query("INSERT INTO rag_generations(id,project_key,index_profile,state,source_generation,source_snapshot) VALUES($1,$2,$3::jsonb,$4,$5,$6)",
            [id,project,JSON.stringify(profile),state==='cancelled'?'cancelled':'ready',source,'b'.repeat(64)]);
        if(state!=='cancelled')await pool.query('INSERT INTO rag_chunks VALUES($1,$2,$3,$4)',['immutable-text',project,id,'previous model verified bytes']);
        const generations=new RagGenerations(pool),models={pool,resolveProject:async(_request:Request,key:string)=>({id:key})};
        const call=vi.fn(async(_path:string,body:Parameters<RagGenerations['cancel']>[2])=>generations.cancel(project,id,body));
        const coordinator={context:async(key:string,db:Pick<PoolClient,'query'>=pool)=>({generation:(await db.query('SELECT active_generation FROM project_embedding_settings WHERE project_id=$1',[key])).rows[0].active_generation}),client:{call}};
        const service=new ProjectReindexService(models as unknown as ModelsService,coordinator as unknown as ProjectRagCoordinator,{}as ModelRuntime,{}as DeviceJobs);
        const saved=async()=>({plan:(await observer.query('SELECT state FROM project_reindex_plans WHERE id=$1',[id])).rows[0],
            generation:(await observer.query('SELECT state FROM rag_generations WHERE id=$1',[id])).rows[0],
            chunks:(await observer.query('SELECT content FROM rag_chunks WHERE generation_id=$1',[id])).rows,
            active:(await observer.query('SELECT active_generation FROM project_embedding_settings WHERE project_id=$1',[project])).rows[0].active_generation});
        return{id,project,active,service,call,saved};
    }
    it.each([false,true])('rejects an applied plan with activePlan=%s without a cancellation RPC or generation mutation',async activePlan=>{
        const f=await fixture('applied',activePlan),before=await f.saved();
        await expect(f.service.cancel({}as Request,f.project,f.id)).rejects.toMatchObject({status:409});
        expect(f.call).not.toHaveBeenCalled();expect(await f.saved()).toEqual(before);
    });
    it('checks applied state after waiting for the project lock, even when the active pointer already moved again',async()=>{
        const f=await fixture('ready'),writer=await pool.connect();let work:Promise<{status:number|string}>|undefined;
        try{
            await writer.query('BEGIN');await writer.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[f.project]);
            await writer.query("UPDATE project_reindex_plans SET state='applied' WHERE id=$1",[f.id]);
            work=f.service.cancel({}as Request,f.project,f.id).then(()=>({status:'unexpected success'}),error=>({status:error.getStatus?.()}));
            await vi.waitFor(async()=>{expect((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM projects WHERE id=$1 FOR UPDATE%'",[database])).rows).toHaveLength(1);},{timeout:3000});
            await writer.query('COMMIT');expect(await work).toEqual({status:409});expect(f.call).not.toHaveBeenCalled();
            expect(await f.saved()).toEqual({plan:{state:'applied'},generation:{state:'ready'},chunks:[{content:'previous model verified bytes'}],active:f.active});
        }finally{await writer.query('ROLLBACK');writer.release();await work;}
    });
    it.each(['ready','cancelling'])('continues a %s cancellation without touching the active generation',async state=>{
        const f=await fixture(state);expect((await f.service.cancel({}as Request,f.project,f.id)).state).toBe('cancelled');
        expect(f.call).toHaveBeenCalledOnce();expect(await f.saved()).toEqual({plan:{state:'cancelled'},generation:{state:'cancelled'},chunks:[],active:f.active});
    });
    it('keeps an already cancelled plan idempotent',async()=>{
        const f=await fixture('cancelled'),before=await f.saved();expect((await f.service.cancel({}as Request,f.project,f.id)).state).toBe('cancelled');
        expect(await f.saved()).toEqual(before);
    });
});
