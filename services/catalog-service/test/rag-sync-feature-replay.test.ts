import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {ForbiddenException,HttpException,ServiceUnavailableException} from '@nestjs/common';
import {ProjectRagCoordinator} from '../src/models/project-rag-coordinator';
import {PROJECT_RAG_AUTHORIZATION_SCHEMA_SQL} from '../src/models/project-rag-authorization.schema';
import type {ModelsService} from '../src/models/models.service';
import {RagService} from '../../rag-sync-service/src/rag/rag.service';
import {RagDb} from '../../rag-sync-service/src/rag/rag-db';
import type {ProjectDatabases} from '../../rag-sync-service/src/rag/project-databases';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {ragRequestHash} from '../../shared/rag-index-contract.cjs';
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>{}}));

const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
type Intent=Parameters<ProjectRagCoordinator['finish']>[0];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};

/** Durable SQL is real. Controlled feature/authorization transport exposes lost and late acknowledgements. */
describe.skipIf(!connection).sequential('RAG write receipt replay across disabled features',()=>{
    const database='nc_rag_flag_replay_'+randomUUID().replaceAll('-','');
    let admin:Pool,pool:Pool,observer:Pool,rag:RagDb,created=false;
    beforeAll(async()=>{
        const url=new URL(connection!);
        if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432')throw Error('Configure an explicitly owned loopback PostgreSQL port other than5432.');
        url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:4});observer=new Pool({connectionString:url.href,max:1});rag=new RagDb({url:url.href});await rag.setup();
        await pool.query(`CREATE TABLE projects(id text PRIMARY KEY);
            CREATE TABLE project_embedding_settings(project_id text PRIMARY KEY,revision bigint,data_revision bigint,active_generation text,active_snapshot text,model_id text,model_pin text,dimension int);
            CREATE TABLE project_rag_sync_intents(id uuid PRIMARY KEY,project_id text,payload_hash text,context jsonb,payload jsonb,state text,result jsonb,error jsonb,updated_at timestamptz DEFAULT now());
            CREATE TABLE platform_users(email text PRIMARY KEY,enabled boolean NOT NULL DEFAULT true,is_main_admin boolean NOT NULL DEFAULT false);
            CREATE TABLE project_members(project_id text REFERENCES projects(id),principal_name text,role text,PRIMARY KEY(project_id,principal_name));`);
        await pool.query(PROJECT_RAG_AUTHORIZATION_SCHEMA_SQL);
    });
    afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
    afterAll(async()=>{await rag?.close();await observer?.end();await pool?.end();if(created)await admin.query('DROP DATABASE '+database);await admin?.end();});
    async function fixture(){
        const project='project-'+randomUUID(),id=randomUUID(),generation='initial-'+createHash('sha256').update(project).digest('hex').slice(0,32),pin='a'.repeat(64),author='writer-'+randomUUID()+'@example.test';
        const profile={provider:'openai',model:'neurocenter/model-fixture/sha256/'+pin,dimension:3},context={projectId:project,revision:1,dataRevision:0,generation,profile,snapshot:null};
        const chunk={id:'row',filePath:'README.md',content:'actual committed original',contentHash:createHash('sha256').update('actual committed original').digest('hex'),embedding:[1,2,3]};
        const payload={projectKey:project,expectedGeneration:generation,expectedSelectionRevision:1,expectedDataRevision:0,fingerprintVersion:1,indexProfile:profile,
            snapshot:{hash:'b'.repeat(64),rowCount:1,complete:false},chunks:[chunk],deletes:[]},hash=ragRequestHash(payload),input={id,payloadHash:hash,context,payload};
        await pool.query('INSERT INTO projects VALUES($1)',[project]);
        await pool.query('INSERT INTO platform_users(email) VALUES($1)',[author]);
        await pool.query("INSERT INTO project_members(project_id,principal_name,role) VALUES($1,$2,'Разработчик')",[project,author]);
        await pool.query('INSERT INTO project_embedding_settings VALUES($1,1,0,$2,NULL,$3,$4,3)',[project,generation,'model-fixture',pin]);
        await pool.query("INSERT INTO project_rag_sync_intents(id,project_id,payload_hash,context,payload,state,author_email,author_role,write_policy) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,'pending',$6,'Разработчик','fresh-project-writer-v1')",[id,project,hash,JSON.stringify(context),JSON.stringify(payload),author]);
        const coordinator=new ProjectRagCoordinator({pool}as ModelsService);
        const databases={withProject:async<T>(_id:string,action:(db:RagDb,key:string)=>Promise<T>)=>action(rag,project)},service=new RagService(databases as unknown as ProjectDatabases);
        const state={off:false,denyAuthorization:false,featureGate:undefined as undefined|{entered:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>}};
        vi.stubEnv('CATALOG_SERVICE_URL','http://owned-catalog.invalid');vi.stubEnv('FEATURE_FLAGS_SERVICE_URL','http://owned-flags.invalid');
        const transport=vi.fn(async(url:unknown,options?:RequestInit)=>{
            if(String(url).endsWith('/internal/feature-flags/evaluated')){
                const body=evaluateFeatureFlags({...defaultFeatureFlags(),rag_sync:!state.off}),gate=state.featureGate;state.featureGate=undefined;
                if(gate){gate.entered.resolve();await gate.release.promise;}return Response.json(body);
            }
            if(String(url).endsWith('/internal/project-rag/write-authorize')){
                if(state.denyAuthorization)return Response.json({message:'denied'},{status:403});
                try{return Response.json(await coordinator.authorizeWrite(JSON.parse(String(options?.body))));}
                catch(error){if(error instanceof HttpException)return Response.json(error.getResponse(),{status:error.getStatus()});throw error;}
            }
            throw Error('Unexpected transport destination');
        });vi.stubGlobal('fetch',transport);
        const rpc=vi.spyOn(coordinator.client,'call');rpc.mockImplementation(async<T>(_path:string,value?:unknown):Promise<T>=>{
            try{return await service.applyDelta(value as Parameters<RagService['applyDelta']>[0])as T;}
            catch(error){
                // The real HTTP client recreates upstream errors in Catalog's own Nest instance.
                if(error&&typeof error==='object'&&'getStatus'in error&&typeof error.getStatus==='function'&&'getResponse'in error&&typeof error.getResponse==='function')throw new HttpException(error.getResponse()as object,error.getStatus());
                throw error;
            }
        });
        const intent=async()=>(await pool.query<Intent>('SELECT * FROM project_rag_sync_intents WHERE id=$1',[id])).rows[0];
        const observed=async()=>({intent:(await observer.query('SELECT state FROM project_rag_sync_intents WHERE id=$1',[id])).rows[0].state,
            revision:Number((await observer.query('SELECT data_revision FROM project_embedding_settings WHERE project_id=$1',[project])).rows[0].data_revision),
            chunks:(await observer.query('SELECT content FROM rag_chunks WHERE project_key=$1',[project])).rows,
            receipts:(await observer.query('SELECT state,result,xmin::text AS version FROM rag_write_receipts WHERE id=$1',[id])).rows});
        return{project,id,generation,hash,input,coordinator,service,state,rpc,transport,intent,observed};
    }
    it('replays a committed result while disabled, preserving one write and one catalog revision after ACK loss',async()=>{
        const f=await fixture();f.rpc.mockImplementationOnce(async()=>{await f.service.applyDelta(f.input);throw new ServiceUnavailableException('own lost ACK after actual COMMIT');});
        await expect(f.coordinator.finish(await f.intent())).rejects.toMatchObject({status:503});const before=await f.observed();
        expect(before).toMatchObject({intent:'uncertain',revision:0,chunks:[{content:'actual committed original'}],receipts:[{state:'succeeded'}]});
        f.state.off=true;const reply=await f.coordinator.finish(await f.intent());expect(reply).toMatchObject({upserted:1,dataRevision:1});
        expect(await f.coordinator.finish(await f.intent())).toEqual(reply);const after=await f.observed();
        expect(after).toMatchObject({intent:'succeeded',revision:1,chunks:before.chunks});expect(after.receipts).toEqual(before.receipts);
    });
    it('blocks a new disabled write before creating a business receipt or chunk, retaining its uncertainty barrier',async()=>{
        const f=await fixture();f.state.off=true;await expect(f.coordinator.finish(await f.intent())).rejects.toMatchObject({status:403});
        expect(await f.observed()).toEqual({intent:'uncertain',revision:0,chunks:[],receipts:[]});
        await expect(f.coordinator.requireIdle(pool,f.project)).rejects.toMatchObject({status:409});
        f.state.off=false;expect(await f.coordinator.finish(await f.intent())).toMatchObject({upserted:1,dataRevision:1});
        expect((await f.observed()).chunks).toHaveLength(1);
    });
    it('keeps the barrier while an admitted original waits on its running receipt and is denied after a disabled replay',async()=>{
        const f=await fixture(),holder=await pool.connect();let original:Promise<unknown>|undefined;
        await pool.query("INSERT INTO rag_write_receipts(id,project_key,generation_id,payload_hash,state) VALUES($1,$2,$3,$4,'running')",[f.id,f.project,f.generation,f.hash]);
        try{
            await holder.query('BEGIN');await holder.query('SELECT * FROM rag_write_receipts WHERE id=$1 FOR UPDATE',[f.id]);
            f.rpc.mockImplementationOnce(async()=>{
                original=f.service.applyDelta(f.input);void original.catch(()=>undefined);
                await vi.waitFor(async()=>expect((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM rag_write_receipts WHERE id=$1 FOR UPDATE%'",[database])).rows).toHaveLength(1),{timeout:3000});
                throw new ServiceUnavailableException('own response lost while original SQL waits');
            });
            await expect(f.coordinator.finish(await f.intent())).rejects.toMatchObject({status:503});f.state.off=true;
            await expect(f.coordinator.finish(await f.intent())).rejects.toMatchObject({status:403});
            expect(await f.observed()).toMatchObject({intent:'uncertain',revision:0,chunks:[],receipts:[{state:'running'}]});
            await expect(f.coordinator.requireIdle(pool,f.project)).rejects.toMatchObject({status:409});
            await holder.query('COMMIT');await expect(original).rejects.toMatchObject({status:403,response:{code:'feature-disabled'}});
            expect(await f.observed()).toMatchObject({intent:'uncertain',revision:0,chunks:[],receipts:[{state:'running'}]});
            expect((await observer.query('SELECT project_key FROM rag_index_state WHERE project_key=$1 UNION ALL SELECT project_key FROM rag_generations WHERE project_key=$1',[f.project])).rows).toEqual([]);
            await expect(f.coordinator.requireIdle(pool,f.project)).rejects.toMatchObject({status:409});
            f.state.off=false;
            expect(await f.coordinator.finish(await f.intent())).toMatchObject({upserted:1,dataRevision:1});
            expect((await f.observed()).chunks).toHaveLength(1);
        }finally{await holder.query('ROLLBACK');holder.release();await original?.catch(()=>undefined);}
    });
    it('keeps a missing-receipt barrier when fresh authorization denies a previously admitted late request',async()=>{
        const f=await fixture(),gate={entered:deferred(),release:deferred()};let original:Promise<unknown>|undefined;f.state.featureGate=gate;
        try{
            f.rpc.mockImplementationOnce(async()=>{original=f.service.applyDelta(f.input);void original.catch(()=>undefined);await gate.entered.promise;throw new ServiceUnavailableException('own response lost before receipt insertion');});
            await expect(f.coordinator.finish(await f.intent())).rejects.toMatchObject({status:503});f.state.off=true;
            await expect(f.coordinator.finish(await f.intent())).rejects.toMatchObject({status:403});
            expect(await f.observed()).toEqual({intent:'uncertain',revision:0,chunks:[],receipts:[]});
            await expect(f.coordinator.requireIdle(pool,f.project)).rejects.toMatchObject({status:409});
            gate.release.resolve();await expect(original).rejects.toMatchObject({status:403,response:{code:'feature-disabled'}});
            expect(await f.observed()).toMatchObject({intent:'uncertain',revision:0,chunks:[],receipts:[{state:'running'}]});
            expect((await observer.query('SELECT project_key FROM rag_index_state WHERE project_key=$1 UNION ALL SELECT project_key FROM rag_generations WHERE project_key=$1',[f.project])).rows).toEqual([]);
            await expect(f.coordinator.requireIdle(pool,f.project)).rejects.toMatchObject({status:409});
            f.state.off=false;
            expect(await f.coordinator.finish(await f.intent())).toMatchObject({upserted:1,dataRevision:1});
        }finally{gate.release.resolve();await original?.catch(()=>undefined);}
    });
    it.each(['project','generation','payload']as const)('rejects an exact-receipt %s mismatch without changing it',async mismatch=>{
        const f=await fixture();await f.service.applyDelta(f.input);const before=await f.observed();
        await expect(rag.completedWrite(mismatch==='project'?'other-project':f.project,mismatch==='generation'?randomUUID():f.generation,{id:f.id,payloadHash:mismatch==='payload'?'f'.repeat(64):f.hash})).rejects.toMatchObject({status:400});
        expect(await f.observed()).toEqual(before);
    });
    it('rechecks catalog authorization before returning a completed receipt while disabled',async()=>{
        const f=await fixture();await f.service.applyDelta(f.input);const before=await f.observed(),lookup=vi.spyOn(rag,'completedWrite');
        f.state.off=true;f.state.denyAuthorization=true;await expect(f.service.applyDelta(f.input)).rejects.toMatchObject({status:503});
        expect(lookup).not.toHaveBeenCalled();expect(await f.observed()).toEqual(before);
    });
    it('preserves definitive generic authorization failures',async()=>{
        const f=await fixture();f.rpc.mockRejectedValueOnce(new ForbiddenException('own definitive authorization denial'));
        await expect(f.coordinator.finish(await f.intent())).rejects.toMatchObject({status:403});
        expect(await f.observed()).toEqual({intent:'failed',revision:0,chunks:[],receipts:[]});
        await expect(f.coordinator.requireIdle(pool,f.project)).resolves.toBeUndefined();
    });
    it('keeps a failed exact receipt definitive while disabled without creating chunks',async()=>{
        const f=await fixture();await pool.query("INSERT INTO rag_write_receipts(id,project_key,generation_id,payload_hash,state,error) VALUES($1,$2,$3,$4,'failed',$5::jsonb)",
            [f.id,f.project,f.generation,f.hash,JSON.stringify({message:'own previously rejected write'})]);f.state.off=true;
        await expect(f.coordinator.finish(await f.intent())).rejects.toMatchObject({status:400});
        expect(await f.observed()).toMatchObject({intent:'failed',revision:0,chunks:[],receipts:[{state:'failed'}]});
        await expect(f.coordinator.requireIdle(pool,f.project)).resolves.toBeUndefined();
    });
});
