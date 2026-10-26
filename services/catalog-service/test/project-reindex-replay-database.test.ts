import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {ConflictException,ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';
import {ProjectReindexService} from '../src/models/project-reindex.service';
import {ProjectRagClient} from '../src/models/project-rag-client';
import {modelFromRow} from '../src/models/model-history';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import type {ModelsService} from '../src/models/models.service';
import type {ProjectRagCoordinator} from '../src/models/project-rag-coordinator';
import type {ModelRuntime} from '../src/models/model-runtime';
import type {DeviceJobs} from '../src/devices/device-jobs';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const connection=process.env.RAG_CONTRACT_TEST_PG_URL,request={}as Request;

/** Real SQL receipts and dropped HTTP responses; model inference and the device validator stay controlled. */
describe.skipIf(!connection).sequential('Accepted reindex replay after lost HTTP acknowledgement',()=>{
    const database='nc_reindex_replay_'+randomUUID().replaceAll('-','');
    let admin:Pool,pool:Pool,observer:Pool,created=false;
    const servers:Server[]=[];
    beforeAll(async()=>{
        const url=new URL(connection!);
        if(url.hostname!=='127.0.0.1'||!url.port||url.port==='5432'||url.pathname!=='/postgres')throw Error('Use an owned loopback PostgreSQL admin connection outside5432.');
        admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:1000});observer=new Pool({connectionString:url.href,max:1});
        await pool.query(`CREATE TABLE projects(id text PRIMARY KEY);
            CREATE TABLE project_access(project_id text PRIMARY KEY,level int NOT NULL);
            CREATE TABLE install_targets(project_id text PRIMARY KEY,approved boolean NOT NULL);
            CREATE TABLE model_catalog(id text PRIMARY KEY,name text,descriptor jsonb,revision int,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
            CREATE TABLE project_models(project_id text,model_id text);
            CREATE TABLE project_reindex_plans(id uuid PRIMARY KEY,project_id text,request_key text,actor text,active_role text,state text,digest text,data jsonb,
                approved boolean DEFAULT false,progress int DEFAULT 0,message text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
                connection_job_id uuid,connection_request_key uuid,connection_error text,UNIQUE(project_id,request_key));
            CREATE TABLE bridge_jobs(id uuid PRIMARY KEY,email text,project_id text,state text,message text,percent int);`);
        await pool.query('INSERT INTO model_catalog(id,name,descriptor,revision) VALUES($1,$1,$2,1)',
            ['model-replay',JSON.stringify({runtime:'ollama',capability:'embedding',model:'fixture:3',manifestSha256:'a'.repeat(64),dimension:3})]);
    });
    afterEach(async()=>{vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();})));});
    afterAll(async()=>{await pool?.end();await observer?.end();if(created)await admin.query('DROP DATABASE '+database);await admin?.end();});
    async function listen(server:Server){servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+(server.address()as {port:number}).port;}
    async function fixture(validateWithSinglePool=false){
        const project='prj-'+randomUUID(),target={deviceId:randomUUID(),assetId:'rag-fixture',assetKind:'mcp',version:1,
            expectedManifest:'b'.repeat(64),expectedBindingId:'c'.repeat(64),expectedInstanceId:randomUUID()};
        await pool.query('INSERT INTO projects VALUES($1)',[project]);await pool.query('INSERT INTO project_access VALUES($1,3)',[project]);
        await pool.query('INSERT INTO install_targets VALUES($1,true)',[project]);await pool.query('INSERT INTO project_models VALUES($1,$2)',[project,'model-replay']);
        const model=modelFromRow((await pool.query('SELECT * FROM model_catalog')).rows[0]);
        const input={modelId:model.id,expectedModelPin:projectEmbeddingPin(model),expectedSelectionRevision:0,requestKey:randomUUID(),connection:target};
        const acl=vi.fn(async(_request:Request,id:string,minimum=1)=>{
            const saved=await observer.query('SELECT level FROM project_access WHERE project_id=$1',[id]);
            if(!saved.rows[0]||saved.rows[0].level<minimum)throw new ForbiddenException();return {id};
        });
        const models={pool,actor:async()=>({email:'admin@example.test',activeRole:'Админ проекта'}),resolveProject:acl};
        const validate=vi.fn(async()=>{
            const saved=await (validateWithSinglePool?pool:observer).query('SELECT approved FROM install_targets WHERE project_id=$1',[project]);
            if(!saved.rows[0]?.approved)throw new ConflictException('Installation approval revoked.');
        });
        let sourceCalls=0;
        const ragUrl=await listen(createServer((req,res)=>{
            if(req.url!=='/internal/project-rag/source'){res.writeHead(500).end();return;}
            sourceCalls++;req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify({hash:'d'.repeat(64),rows:1,bytes:20,availableBytes:10000}));
        }));
        const previous=process.env.RAG_SERVICE_URL;process.env.RAG_SERVICE_URL=ragUrl;const client=new ProjectRagClient();
        if(previous===undefined)delete process.env.RAG_SERVICE_URL;else process.env.RAG_SERVICE_URL=previous;
        const context={projectId:project,revision:0,dataRevision:0,generation:'previous-generation',profile:null,snapshot:null};
        const coordinator={client,requireIdle:async(db:PoolClient)=>{await db.query('SELECT 1');},context:async()=>context};
        const service=new ProjectReindexService(models as unknown as ModelsService,coordinator as unknown as ProjectRagCoordinator,{}as ModelRuntime,{validateReindexTarget:validate}as unknown as DeviceJobs);
        const saved=async()=>(await observer.query('SELECT * FROM project_reindex_plans WHERE project_id=$1',[project])).rows;
        const lostAck=async()=>{
            const url=await listen(createServer(async(req,res)=>{req.resume();try{await service.create(request,project,input);res.destroy();}catch(error){res.writeHead(500).end(String(error));}}));
            await expect(fetch(url,{method:'POST',body:JSON.stringify(input)})).rejects.toThrow();
            const rows=await saved();expect(rows).toHaveLength(1);expect(rows[0].state).toBe('needs_input');return rows[0];
        };
        return {project,target,input,service,validate,acl,saved,lostAck,sourceCalls:()=>sourceCalls,
            level:async(value:number)=>observer.query('UPDATE project_access SET level=$2 WHERE project_id=$1',[project,value]),
            revoke:()=>observer.query('UPDATE install_targets SET approved=false WHERE project_id=$1',[project])};
    }
    it('returns the accepted receipt after target revocation, role downgrade and OFF without another source request',async()=>{
        const f=await fixture(),accepted=await f.lostAck();await f.revoke();await f.level(1);
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('rag_sync OFF'));
        const replay=await f.service.create(request,f.project,f.input);
        expect(replay).toMatchObject({id:accepted.id,state:'needs_input',data:{connection:f.target}});
        expect(f.validate).toHaveBeenCalledOnce();expect(f.sourceCalls()).toBe(1);expect(await f.saved()).toHaveLength(1);
    });
    it.each(['modelId','expectedModelPin','expectedSelectionRevision','connection'])('rejects a changed %s under the accepted key with409',async field=>{
        const f=await fixture();await f.lostAck();await f.revoke();
        const changes={modelId:'other-model',expectedModelPin:'f'.repeat(64),expectedSelectionRevision:1,connection:{...f.target,expectedBindingId:'e'.repeat(64)}};
        await expect(f.service.create(request,f.project,{...f.input,[field]:changes[field as keyof typeof changes]})).rejects.toMatchObject({status:409});
        expect(f.validate).toHaveBeenCalledOnce();expect(f.sourceCalls()).toBe(1);expect(await f.saved()).toHaveLength(1);
    });
    it('checks read access again after receipt lookup and rejects access revoked during that lookup',async()=>{
        const f=await fixture();await f.lostAck();
        f.acl.mockImplementationOnce(async()=>{await f.level(0);return {id:f.project};});
        await expect(f.service.create(request,f.project,f.input)).rejects.toMatchObject({status:403});
        expect(f.validate).toHaveBeenCalledOnce();expect(f.sourceCalls()).toBe(1);
    });
    it('admits new plans only with admin access, ON and a current approved target',async()=>{
        const f=await fixture();await f.level(1);await expect(f.service.create(request,f.project,f.input)).rejects.toMatchObject({status:403});
        await f.level(3);vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('OFF'));
        await expect(f.service.create(request,f.project,f.input)).rejects.toMatchObject({status:403});
        vi.mocked(requireFeaturesEnabled).mockResolvedValue(undefined);await f.revoke();
        await expect(f.service.create(request,f.project,f.input)).rejects.toMatchObject({status:409});
        expect(f.sourceCalls()).toBe(0);expect(await f.saved()).toHaveLength(0);
    });
    it('validates a new target without holding the only models pool connection',async()=>{
        const f=await fixture(true),plan=await f.service.create(request,f.project,f.input);
        expect(plan.state).toBe('needs_input');expect(f.sourceCalls()).toBe(1);expect(f.validate).toHaveBeenCalledOnce();
    });
    it('serializes concurrent identical requests to one accepted plan and one source preparation',async()=>{
        const f=await fixture();let count=0,release!:()=>void;const validated=new Promise<void>(resolve=>{release=resolve;});
        f.validate.mockImplementation(async()=>{if(++count===2)release();await validated;});
        const plans=await Promise.all([f.service.create(request,f.project,f.input),f.service.create(request,f.project,f.input)]);
        expect(plans[0].id).toBe(plans[1].id);expect(await f.saved()).toHaveLength(1);expect(f.sourceCalls()).toBe(1);
    });
});
