import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client,Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {ServiceUnavailableException,ForbiddenException,Module} from '@nestjs/common';
import type {Request} from 'express';
import {ProjectEmbeddingRepository,initialGeneration} from '../src/models/project-embedding.repository';
import {ProjectRagCoordinator} from '../src/models/project-rag-coordinator';
import {ProjectReindexService} from '../src/models/project-reindex.service';
import {setupModelHistory,modelFromRow,readPinnedModel} from '../src/models/model-history';
import {setupSecurityEvents} from '../src/access/security-events';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import type {ModelsService} from '../src/models/models.service';
import type {ModelRuntime} from '../src/models/model-runtime';
import type {IProjectReindexPlan} from '../src/models/project-reindex.types';
import {RagDb,type IUpsertRow} from '../../rag-sync-service/src/rag/rag-db';
import {indexSnapshotHash,rowFingerprint,ragRequestHash} from '../../shared/rag-index-contract.cjs';
import {operationSchema} from './operation-schema.fixture';

vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>{}}));
const connection=process.env.RAG_CONTRACT_TEST_PG_URL,request={} as Request;
const descriptor=(dimension:number)=>({runtime:'ollama',capability:'embedding',model:`fixture:${dimension}`,manifestSha256:'a'.repeat(64),dimension,description:'',source:'manual'});
const row=(id:string):IUpsertRow=>({id,filePath:id+'.ts',content:id,description:null,startLine:1,endLine:1,language:'typescript',kind:'code',role:null,quirkType:null,tags:null,contentHash:createHash('sha256').update(id).digest('hex'),embedding:[1,2,3]});

describe.skipIf(!connection)('Catalog CAS + durable sync receipts + real generation DB',()=>{
    const name='nc_reindex_'+randomUUID().replaceAll('-',''),modelId='model-fixture-three',nextId='model-fixture-five';
    let admin:Client,pool:Pool,rag:RagDb,repo:ProjectEmbeddingRepository,coordinator:ProjectRagCoordinator,service:ProjectReindexService,models:ModelsService;
    let key:string,deny=false,loseAck=false,loseJobAck=false,jobRejected=false,created=false;
    const target={deviceId:randomUUID(),assetId:'rag-fixture',assetKind:'mcp' as const,version:9,expectedManifest:'c'.repeat(64),expectedBindingId:'d'.repeat(64),expectedInstanceId:randomUUID()};
    const jobs={validateReindexTarget:vi.fn(async()=>{}),create:vi.fn(async(actor:{email:string},input:Record<string,unknown>)=>{
        if(jobRejected)throw new (await import('@nestjs/common')).ConflictException('fixture stale binding');
        const result=await pool.query("INSERT INTO bridge_jobs(id,email,project_id,request_key,state,message,payload) VALUES($1,$2,$3,$4,'queued','Компьютер не в сети. Ожидаем мост.',$5::jsonb) ON CONFLICT(project_id,request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *",[randomUUID(),actor.email,input.projectId,input.requestKey,JSON.stringify(input)]);
        if(loseJobAck){loseJobAck=false;throw new ServiceUnavailableException('lost job ACK');}return result.rows[0];
    })};
    const context=()=>coordinator.context(key);
    const card=async(id=nextId)=>modelFromRow((await pool.query('SELECT * FROM model_catalog WHERE id=$1',[id])).rows[0]);
    const make=async(id=nextId,connection?:typeof target)=>service.create(request,key,{expectedSelectionRevision:(await context()).revision,modelId:id,expectedModelPin:projectEmbeddingPin(await card(id)),requestKey:randomUUID(),...connection?{connection}:{}});
    const tick=()=> (service as unknown as {recover():Promise<void>}).recover();
    const applied=async(plan:IProjectReindexPlan)=>{let current=plan;for(let n=0;n<100&&!['applied','failed','stale','cancelled'].includes(current.state);n++){await tick();current=await service.get(request,key,plan.id);await new Promise(resolve=>setTimeout(resolve,10));}return current;};
    const snapshot=(values:IUpsertRow[],profile:NonNullable<Awaited<ReturnType<typeof context>>['profile']>)=>({hash:indexSnapshotHash(profile,Object.fromEntries(values.map(value=>[value.id,rowFingerprint(value)]))),rowCount:values.length,complete:true});
    const seed=async(values=[row('one')])=>{
        const pin=projectEmbeddingPin(await card(modelId)),profile={provider:'openai' as const,model:`neurocenter/${modelId}/sha256/${pin}`,dimension:3};
        await pool.query(`INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation,data_revision) VALUES($1,1,$2,$3,3,'admin@example.test',$4,0)`,[key,modelId,pin,initialGeneration(key)]);
        await rag.applyDelta(key,initialGeneration(key),values,[],{indexProfile:profile,snapshot:{...snapshot(values,profile),complete:false}});
        await rag.applyDelta(key,initialGeneration(key),[],[],{indexProfile:profile,snapshot:snapshot(values,profile)});return context();
    };
    const syncBody=async(values:IUpsertRow[])=>{const c=await context(),payload={projectKey:key,expectedGeneration:c.generation,expectedSelectionRevision:c.revision,expectedDataRevision:c.dataRevision,fingerprintVersion:1,indexProfile:c.profile,snapshot:{...snapshot(values,c.profile!),complete:false},chunks:values,deletes:[]};return {...payload,requestKey:ragRequestHash(payload)};};
    beforeAll(async()=>{
        const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only temporary localhost DB allowed');
        admin=new Client({connectionString:connection});await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;
        pool=new Pool({connectionString:url.toString(),max:12});rag=new RagDb({url:url.toString()});await rag.setup();
        await pool.query(`CREATE TABLE projects(id TEXT PRIMARY KEY);CREATE TABLE model_catalog(id TEXT PRIMARY KEY,name TEXT,descriptor JSONB,revision INTEGER,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());CREATE TABLE project_models(project_id TEXT REFERENCES projects(id),model_id TEXT REFERENCES model_catalog(id),PRIMARY KEY(project_id,model_id));CREATE TABLE bridge_jobs(id TEXT PRIMARY KEY,email TEXT,project_id TEXT,request_key UUID,state TEXT,message TEXT,percent INTEGER,payload JSONB,UNIQUE(project_id,request_key));`);
        await operationSchema(pool);
        await pool.query('INSERT INTO model_catalog(id,name,descriptor,revision) VALUES($1,$2,$3,1),($4,$5,$6,1)',[modelId,'Three',descriptor(3),nextId,'Five',descriptor(5)]);
        await setupModelHistory(pool);await setupSecurityEvents(pool);repo=new ProjectEmbeddingRepository(pool);await repo.setup();
        models={pool,ready:async()=>{},actor:async()=>({email:'admin@example.test',activeRole:'Главный админ'}),resolveProject:async(_request:unknown,id:string)=>{if(deny)throw new ForbiddenException();if(!(await pool.query('SELECT id FROM projects WHERE id=$1',[id])).rowCount)throw Error('Project missing');return{id};},isAssigned:async(project:string,id:string)=>!!(await pool.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2',[project,id])).rowCount,getPinned:async(id:string,pin:string)=>readPinnedModel(pool,id,pin)} as unknown as ModelsService;
        coordinator=new ProjectRagCoordinator(models);await coordinator.onModuleInit();await coordinator.onModuleDestroy();service=new ProjectReindexService(models,coordinator,{infer:async(model:{dimension:number},_operation:string,value:{input:string[]})=>({embeddings:value.input.map(()=>Array.from({length:model.dimension},(_,index)=>index+1))})} as unknown as ModelRuntime,jobs as unknown as import('../src/devices/device-jobs').DeviceJobs);await service.onModuleInit();await service.onModuleDestroy();
        vi.spyOn(coordinator.client,'call').mockImplementation(async(path:string,body?:unknown):Promise<any>=>{
            const input=body as any;
            if(path==='source')return {...await rag.generations.source(input.projectId,input.generation),availableBytes:1e10};
            if(path==='generations')return rag.generations.create(input.projectId,input.id,input.sourceGeneration,input.profile,input.sourceSnapshot);
            if(path==='write'){
                await coordinator.authorizeWrite(input);const p=input.payload,result=await rag.applyDelta(input.context.projectId,input.context.generation,p.chunks,p.deletes,{indexProfile:p.indexProfile,snapshot:p.snapshot},{id:input.id,payloadHash:input.payloadHash});
                if(loseAck){loseAck=false;throw new ServiceUnavailableException('lost ACK after real COMMIT');}return result;
            }
            const match=/^generations\/([^/?]+)(?:\/(build|cancel|retry))?/.exec(path);if(!match)throw Error(path);const project=input?.projectId??new URL('http://fixture/'+path).searchParams.get('projectId')!;
            if(match[2]==='build')return rag.generations.build(project,match[1],async(texts,profile)=>texts.map(()=>Array.from({length:profile.dimension},(_,i)=>i+1)));
            if(match[2]==='cancel')return rag.generations.cancel(project,match[1],input);
            if(match[2]==='retry')return rag.generations.retry(project,match[1]);return rag.generations.get(project,match[1]);
        });
    },30000);
    beforeEach(async()=>{deny=false;loseAck=false;loseJobAck=false;jobRejected=false;jobs.create.mockClear();jobs.validateReindexTarget.mockClear();key='prj-'+randomUUID();await pool.query('INSERT INTO projects(id) VALUES($1)',[key]);await pool.query('INSERT INTO project_models(project_id,model_id) VALUES($1,$2),($1,$3)',[key,modelId,nextId]);});
    afterAll(async()=>{await service?.onModuleDestroy();await coordinator?.onModuleDestroy();await Promise.all([pool?.end(),rag?.close()]);if(created)await admin.query(`DROP DATABASE "${name}"`);await admin?.end();});
    it('Zero: один intent подключает пустой проект атомарно',async()=>{
        const plan=await make();expect(plan).toMatchObject({state:'building',approved:true,data:{rowCount:0}});expect((await applied(plan)).state).toBe('applied');expect(await context()).toMatchObject({generation:plan.id,revision:1,dataRevision:1,profile:{dimension:5}});expect((await repo.read(key)).blocker).toBeUndefined();expect((await rag.summary(key,plan.id)).complete).toBe(true);
    });
    it('Durable target survives a lost enqueue ACK and restart; offline stays queued',async()=>{
        loseJobAck=true;const plan=await make(nextId,target);await applied(plan);await tick();
        const current=await service.get(request,key,plan.id);expect(current.local).toMatchObject({state:'queued',message:'Компьютер не в сети. Ожидаем мост.'});
        expect((await pool.query('SELECT payload FROM bridge_jobs WHERE project_id=$1',[key])).rows).toHaveLength(1);
        const payload=(await pool.query('SELECT payload FROM bridge_jobs WHERE project_id=$1',[key])).rows[0].payload;
        expect(payload).toMatchObject({...target,reindex:true,expectedEmbeddingRevision:1,expectedEmbeddingPin:plan.data.modelPin});expect(jobs.validateReindexTarget).toHaveBeenCalledOnce();
        await tick();expect((await service.get(request,key,plan.id)).local?.jobId).toBe(current.local?.jobId);
    });
    it('Changed local target after server promotion is explicit failure and retry preserves exact target',async()=>{
        jobRejected=true;const plan=await make(nextId,target);await applied(plan);
        expect((await service.get(request,key,plan.id)).local?.state).toBe('failed');expect((await context()).generation).toBe(plan.id);
        jobRejected=false;expect((await service.retryLocal(request,key,plan.id)).local?.state).toBe('queued');
        expect((await pool.query('SELECT payload FROM bridge_jobs WHERE project_id=$1',[key])).rows[0].payload).toMatchObject(target);
    });
    it('Lost create ACK retains the queued local state; concurrent retry creates one replacement job',async()=>{
        const requestKey=randomUUID(),input={expectedSelectionRevision:0,modelId:nextId,expectedModelPin:projectEmbeddingPin(await card()),requestKey,connection:target};
        const plan=await service.create(request,key,input);await applied(plan);await tick();const queued=await service.get(request,key,plan.id);
        expect((await service.create(request,key,input)).local).toEqual(queued.local);
        await pool.query("UPDATE bridge_jobs SET state='failed' WHERE id=$1",[queued.local!.jobId]);
        await Promise.all([service.retryLocal(request,key,plan.id),service.retryLocal(request,key,plan.id)]);
        expect((await pool.query('SELECT id FROM bridge_jobs WHERE project_id=$1',[key])).rows).toHaveLength(2);
    });
    it('One: подтверждение impact обязательно, прежний индекс сохраняется',async()=>{
        const before=await seed(),baseline=await rag.manifest(key,before.generation),plan=await make();expect(plan.state).toBe('needs_input');await tick();expect(await context()).toEqual(before);await expect(service.start(request,key,plan.id,{digest:'bad'})).rejects.toMatchObject({status:409});await service.start(request,key,plan.id,{digest:plan.digest});expect((await applied(plan)).state).toBe('applied');expect(await context()).toMatchObject({generation:plan.id,revision:2,dataRevision:1,profile:{dimension:5}});expect(await rag.manifest(key,before.generation)).toEqual(baseline);expect((await pool.query('SELECT * FROM security_events WHERE resource_id=$1',[key])).rowCount).toBe(1);
    });
    it('Many: конкурирующие кандидаты получают один head и один аудит',async()=>{
        const before=await seed(),a=await make(),b=await make();await Promise.all([service.start(request,key,a.id,{digest:a.digest}),service.start(request,key,b.id,{digest:b.digest})]);await applied(a);await applied(b);expect([(await service.get(request,key,a.id)).state,(await service.get(request,key,b.id)).state].sort()).toEqual(['applied','stale']);expect((await context()).revision).toBe(before.revision+1);expect((await pool.query('SELECT * FROM security_events WHERE resource_id=$1',[key])).rowCount).toBe(1);
    });
    it('Source race не теряет добавленные знания: stale, old active working',async()=>{
        const before=await seed(),plan=await make();await service.start(request,key,plan.id,{digest:plan.digest});await coordinator.sync(request,await syncBody([row('one'),row('two')]));expect((await applied(plan)).state).toBe('stale');expect(await context()).toMatchObject({generation:before.generation,revision:before.revision,dataRevision:1});expect((await rag.summary(key,before.generation)).rowCount).toBe(2);
    });
    it('Изменённый model pin и отозванные права запрещают переключение',async()=>{
        const before=await seed(),plan=await make();await service.start(request,key,plan.id,{digest:plan.digest});await pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{manifestSha256}',to_jsonb($2::text)) WHERE id=$1",[nextId,'b'.repeat(64)]);expect((await applied(plan)).state).toBe('stale');expect(await context()).toEqual(before);await pool.query('UPDATE model_catalog SET descriptor=$2::jsonb WHERE id=$1',[nextId,JSON.stringify(descriptor(5))]);const next=await make();deny=true;await expect(service.start(request,key,next.id,{digest:next.digest})).rejects.toMatchObject({status:403});deny=false;expect(await context()).toEqual(before);
    });
    it('Lost ACK после COMMIT: durable barrier, restart/replay даёт одну ревизию',async()=>{
        const before=await seed(),payload=await syncBody([row('one'),row('two')]);loseAck=true;await expect(coordinator.sync(request,payload)).rejects.toMatchObject({status:503});expect((await rag.summary(key,before.generation)).rowCount).toBe(2);expect((await context()).dataRevision).toBe(0);expect((await pool.query('SELECT state FROM project_rag_sync_intents WHERE project_id=$1',[key])).rows[0].state).toBe('uncertain');await expect(make()).rejects.toMatchObject({status:409});await expect(coordinator.sync(request,{...payload,requestKey:'b'.repeat(64)})).rejects.toMatchObject({status:409});const restarted=new ProjectRagCoordinator(models);restarted.client.call=coordinator.client.call.bind(coordinator.client);const output=await restarted.sync(request,payload);expect(output).toMatchObject({dataRevision:1,rowCount:2});expect(await restarted.sync(request,payload)).toEqual(output);expect((await context()).dataRevision).toBe(1);await expect(restarted.sync(request,{...payload,deletes:['one']})).rejects.toMatchObject({status:409});
    });
    it('Отмена до create оставляет tombstone для позднего worker',async()=>{
        const before=await seed(),plan=await make();expect((await service.cancel(request,key,plan.id)).state).toBe('cancelled');expect(await rag.generations.create(key,plan.id,before.generation,plan.data.profile,plan.data.sourceSnapshot!)).toMatchObject({state:'cancelled'});await tick();expect(await context()).toEqual(before);
    });
    it('Applied generation нельзя удалить отменой',async()=>{const plan=await make();await applied(plan);const before=await context();await expect(service.cancel(request,key,plan.id)).rejects.toMatchObject({status:409});expect(await context()).toEqual(before);});
    it('Cancelled generation receipt remains cancelled after a lost catalog acknowledgement',async()=>{
        const before=await seed(),plan=await make();
        await rag.generations.create(key,plan.id,before.generation,plan.data.profile,plan.data.sourceSnapshot!);
        await rag.generations.cancel(key,plan.id,{profile:plan.data.profile,sourceGeneration:before.generation,sourceSnapshot:plan.data.sourceSnapshot!});
        await service.start(request,key,plan.id,{digest:plan.digest});
        expect((await applied(plan)).state).toBe('cancelled');expect(await context()).toEqual(before);
        await expect(service.retry(request,key,plan.id)).rejects.toMatchObject({status:409});
    });
    it('Audit failure откатывает pointer+selection+applied; retry использует ready receipt',async()=>{
        const before=await seed(),plan=await make();await pool.query(`CREATE FUNCTION fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='${key}' THEN RAISE EXCEPTION 'fixture audit failure';END IF;RETURN NEW;END $$;CREATE TRIGGER fixture_reindex_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION fixture_audit_failure()`);
        try{await service.start(request,key,plan.id,{digest:plan.digest});expect((await applied(plan)).state).toBe('failed');expect(await context()).toEqual(before);expect((await rag.generations.get(key,plan.id)).state).toBe('ready');}finally{await pool.query('DROP TRIGGER fixture_reindex_audit ON security_events;DROP FUNCTION fixture_audit_failure()');}await service.retry(request,key,plan.id);expect((await applied(plan)).state).toBe('applied');expect((await context()).revision).toBe(before.revision+1);
    });
    it('Real HTTP controllers: catalog generation promotion, pinned reads, sync receipts and no bypass writer',async()=>{
        const before=await seed(),savedEnv={catalog:process.env.CATALOG_SERVICE_URL,rag:process.env.RAG_SERVICE_URL,token:process.env.NEUROCENTER_INTERNAL_TOKEN,flags:process.env.FEATURE_FLAGS_SERVICE_URL};
        const {NestFactory}=await import('@nestjs/core'),{NestFactory:RagNestFactory}=await import('../../rag-sync-service/node_modules/@nestjs/core/index.js'),{ProjectReindexController,ProjectReindexInferenceController}=await import('../src/models/project-reindex.controller'),
            {ProjectRagSyncController,ProjectRagContextController}=await import('../src/models/project-rag.controller'),{ProjectRagClient}=await import('../src/models/project-rag-client'),
            {RagService}=await import('../../rag-sync-service/src/rag/rag.service'),{ProjectDatabases}=await import('../../rag-sync-service/src/rag/project-databases'),
            {ProjectRagController}=await import('../../rag-sync-service/src/rag/project-rag.controller'),{RagController}=await import('../../rag-sync-service/src/rag/rag.controller');
        const databases={withProject:async<T>(id:string,action:(db:RagDb,id:string)=>Promise<T>)=>{expect(id).toBe(key);return action(rag,id);}},ragService=new RagService(databases as unknown as InstanceType<typeof ProjectDatabases>);
        for(const [controller,deps] of [[ProjectReindexController,[ProjectReindexService]],[ProjectReindexInferenceController,[ProjectReindexService]],
            [ProjectRagSyncController,[ProjectRagCoordinator]],[ProjectRagContextController,[ProjectRagCoordinator]],[ProjectRagController,[RagService,ProjectDatabases]],[RagController,[RagService]]] as const)Reflect.defineMetadata('design:paramtypes',deps,controller);
        class CatalogHttpFixture{}class RagHttpFixture{}
        Module({controllers:[ProjectReindexController,ProjectReindexInferenceController,ProjectRagSyncController,ProjectRagContextController],providers:[{provide:ProjectReindexService,useValue:service},{provide:ProjectRagCoordinator,useValue:coordinator}]})(CatalogHttpFixture);
        Module({controllers:[ProjectRagController,RagController],providers:[{provide:RagService,useValue:ragService},{provide:ProjectDatabases,useValue:databases}]})(RagHttpFixture);
        const catalogApp=await NestFactory.create(CatalogHttpFixture,{logger:false}),ragApp=await RagNestFactory.create(RagHttpFixture,{logger:false});
        process.env.NEUROCENTER_INTERNAL_TOKEN='isolated-http-fixture-token';
        ragApp.use((req:{path:string;headers:Record<string,string>},res:{status:(code:number)=>{json:(body:unknown)=>void};json:(body:unknown)=>void},next:()=>void)=>{
            if(req.path.startsWith('/internal/')&&req.headers['x-neurocenter-internal']!==process.env.NEUROCENTER_INTERNAL_TOKEN){res.status(403).json({message:'Internal token required'});return;}
            if(req.path==='/internal/feature-flags/evaluated'){res.json({flags:{model_hosting:true,rag_sync:true,tool_builds:true}});return;}next();
        });
        try{
            await catalogApp.listen(0,'127.0.0.1');await ragApp.listen(0,'127.0.0.1');
            process.env.CATALOG_SERVICE_URL=await catalogApp.getUrl();process.env.RAG_SERVICE_URL=await ragApp.getUrl();process.env.FEATURE_FLAGS_SERVICE_URL=process.env.RAG_SERVICE_URL;
            const transport=new ProjectRagClient(),buildAcks:string[]=[];
            vi.mocked(coordinator.client.call).mockImplementation(async(...args)=>{const value=await transport.call<any>(...args);if(args[0].endsWith('/build'))buildAcks.push(value.state);return value;});
            const http=async(base:string,url:string,body?:unknown)=>{const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN!},...body===undefined?{}:{body:JSON.stringify(body)}});return{status:response.status,value:await response.json() as any};};
            const catalog=process.env.CATALOG_SERVICE_URL!,ragUrl=process.env.RAG_SERVICE_URL!,route=`/api/projects/${key}/embedding/reindex`;
            expect((await http(catalog,route)).value).toBe(null);
            const created=await http(catalog,route,{expectedSelectionRevision:before.revision,modelId:nextId,expectedModelPin:projectEmbeddingPin(await card()),requestKey:randomUUID()});
            expect(created.status).toBe(201);expect(created.value.state).toBe('needs_input');const plan=created.value as IProjectReindexPlan;
            expect((await http(ragUrl,`/api/rag/summary?projectKey=${key}`)).value).toMatchObject({generation:before.generation,dimension:3,rowCount:1});
            expect((await http(catalog,`${route}/${plan.id}/start`,{digest:'bad'})).status).toBe(409);
            expect((await http(catalog,`${route}/${plan.id}/start`,{digest:plan.digest})).status).toBe(201);
            const failures=vi.spyOn(service as unknown as {fail(id:string,error:unknown):Promise<void>},'fail');
            let last:unknown;for(let n=0;n<100;n++){await tick();const state=await http(catalog,`${route}/${plan.id}`);last=state.value;if(['applied','failed','stale','cancelled'].includes(state.value.state))break;await new Promise(resolve=>setTimeout(resolve,25));}expect(failures.mock.calls.map(([,error])=>String(error)+' '+JSON.stringify((error as any)?.response))).toEqual([]);expect(last).toMatchObject({state:'applied'});
            const active=await context();expect(active).toMatchObject({generation:plan.id,profile:{dimension:5},revision:2});
            expect((await http(ragUrl,`/api/rag/summary?projectKey=${key}`)).value).toMatchObject({generation:plan.id,dimension:5,rowCount:1,complete:true});
            const one={...row('one'),embedding:[1,2,3,4,5]},two={...row('two'),embedding:[1,2,3,4,5]},payload=await syncBody([one,two]);
            const old={...payload,expectedGeneration:before.generation,expectedSelectionRevision:before.revision};old.requestKey=ragRequestHash({...old,requestKey:undefined});
            expect((await http(catalog,'/api/rag/sync',old)).status).toBe(409);
            const wrote=await http(catalog,'/api/rag/sync',payload);expect(wrote.status).toBe(201);expect(wrote.value).toMatchObject({rowCount:2,dataRevision:2,generation:plan.id});
            expect((await http(catalog,'/api/rag/sync',payload)).value).toEqual(wrote.value);
            expect((await http(ragUrl,`/api/rag/manifest?projectKey=${key}`)).value).toMatchObject({generation:plan.id,dataRevision:2,selectedProfile:{dimension:5}});
            expect(await rag.manifest(key,before.generation)).toMatchObject({ids:{one:expect.any(String)}});
            expect((await http(ragUrl,'/api/rag/sync',payload)).status).toBe(404);
            expect((await fetch(ragUrl+'/internal/project-rag/write',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(403);
            expect((await fetch(catalog+`/internal/project-rag/context/${key}`)).status).toBe(403);

            // Real async ACK precedes a failed background batch: it must remain retryable, not stale.
            const previousActive=await context(),oldManifest=await rag.manifest(key,previousActive.generation);
            const infer=vi.spyOn((service as unknown as {runtime:ModelRuntime}).runtime,'infer');
            let releaseBatch!:()=>void;const batchGate=new Promise<void>(resolve=>{releaseBatch=resolve;});
            infer.mockImplementationOnce(async(model,_operation,value)=>{await batchGate;return {embeddings:(value.input as string[]).map(()=>Array(model.dimension!+1).fill(1))};});
            const candidate=(await http(catalog,route,{expectedSelectionRevision:previousActive.revision,modelId,expectedModelPin:projectEmbeddingPin(await card(modelId)),requestKey:randomUUID()})).value as IProjectReindexPlan;
            expect(candidate.state).toBe('needs_input');const previousAcks=buildAcks.length;await http(catalog,`${route}/${candidate.id}/start`,{digest:candidate.digest});
            for(let n=0;n<100&&buildAcks.length===previousAcks;n++){await tick();await new Promise(resolve=>setTimeout(resolve,10));}
            releaseBatch();
            expect(buildAcks.slice(previousAcks)).toContain('building');expect(await context()).toEqual(previousActive);
            const failed=await applied(candidate);infer.mockRestore();expect(failed.state).toBe('failed');expect(failed.message).toContain('Действующий индекс сохранён');
            expect(await context()).toEqual(previousActive);expect(await rag.manifest(key,previousActive.generation)).toEqual(oldManifest);
            expect((await rag.generations.get(key,candidate.id)).state).toBe('failed');
            expect((await http(catalog,`${route}/${candidate.id}/retry`,{})).status).toBe(201);
            const retried=await applied(candidate);expect(retried).toMatchObject({id:candidate.id,state:'applied'});
            expect(await context()).toMatchObject({generation:candidate.id,revision:previousActive.revision+1,profile:{dimension:3}});
            expect(await rag.manifest(key,previousActive.generation)).toEqual(oldManifest);

            // Genuine source conflicts cross HTTP as HttpException(409), not ConflictException.
            const activeBeforeRace=await context();
            const sourceRace=(await http(catalog,route,{expectedSelectionRevision:activeBeforeRace.revision,modelId:nextId,expectedModelPin:projectEmbeddingPin(await card()),requestKey:randomUUID()})).value as IProjectReindexPlan;
            expect(sourceRace.state).toBe('needs_input');
            expect((await http(catalog,'/api/rag/sync',await syncBody([row('one'),row('two'),row('three')]))).status).toBe(201);
            const changedSource=await context();await http(catalog,`${route}/${sourceRace.id}/start`,{digest:sourceRace.digest});
            expect((await applied(sourceRace)).state).toBe('stale');expect(await context()).toEqual(changedSource);
            expect((await rag.manifest(key,changedSource.generation)).ids).toHaveProperty('three');
        }finally{
            await Promise.all([catalogApp.close(),ragApp.close()]);
            for(const [key,value] of Object.entries({CATALOG_SERVICE_URL:savedEnv.catalog,RAG_SERVICE_URL:savedEnv.rag,NEUROCENTER_INTERNAL_TOKEN:savedEnv.token,FEATURE_FLAGS_SERVICE_URL:savedEnv.flags}))if(value===undefined)delete process.env[key];else process.env[key]=value;
        }
    },30000);
});
