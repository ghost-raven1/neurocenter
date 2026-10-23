import 'reflect-metadata';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client,Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {ForbiddenException,NotFoundException,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {Request} from 'express';
import {OperationActionsService} from '../src/operations/operation-actions.service';
import {OperationActionStore} from '../src/operations/operation-action-store';
import {OperationActionsController} from '../src/operations/operation-actions.controller';
import {OperationRepository} from '../src/operations/operation-repository';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {DeviceJobs} from '../src/devices/device-jobs';
import {recordDeviceOperation} from '../src/devices/device-operations';
import {ProjectReindexService} from '../src/models/project-reindex.service';
import {projectLevel} from '../src/access/access.model';
import {DeviceCodexService} from '../src/models/device-codex.service';
import {SystemRoleService} from '../src/system-roles/system-role.service';
import {projectRoleOperation} from '../src/system-roles/system-role.operations';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {completeDeviceJob,type DeviceCompletion} from '../src/devices/device-completion';
import {DEVICE_CODEX_PROTOCOL} from '../../shared/device-codex-inference.cjs';

vi.mock('../src/devices/device-operations',async original=>({...await original<typeof import('../src/devices/device-operations')>(),notifyDeviceOperations:vi.fn()}));
vi.mock('../src/system-roles/system-role.operations',async original=>({...await original<typeof import('../src/system-roles/system-role.operations')>(),notifyRoleOperations:vi.fn()}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
describe.skipIf(!connection)('Generic journal dispatch — actual HTTP/PostgreSQL and existing executors',()=>{
    const name='nc_operation_'+randomUUID().replaceAll('-',''),email='fixture@example.test',project='prj-fixture';
    let admin:Client,pool:Pool,actionStore:OperationActionStore,repository:OperationRepository,actions:OperationActionsService,jobs:DeviceJobs,reindex:ProjectReindexService,app:INestApplication,base:string;
    let checkoutBarrier:{count:number;entered:()=>void;release:Promise<void>}|undefined;
    let codex:DeviceCodexService,roles:SystemRoleService;
    let role='Админ проекта',revoked=false,projectRevoked=false,loseAck=false,created=false;
    const claims=()=>({email,userRoles:revoked?[]:[role],projects:projectRevoked?[]:[{projectId:project,projectName:'Fixture',role:'Админ проекта'}],pluginIds:[],skillPaths:[]});
    const headers=()=>({'content-type':'application/json','x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole:role}))});
    const request=()=>({headers:headers()}) as unknown as Request;
    const post=async(id:string,action:string,body:unknown)=>{const response=await fetch(base+'/api/operations/'+id+'/'+action,{method:'POST',headers:headers(),body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
    const operation=async(id:string)=>{const row=await repository.get(id);if(!row)throw Error('fixture operation missing');return actions.decorate(request(),row);};
    const input=async(id:string,key=randomUUID())=>({requestKey:key,expectedDigest:(await operation(id)).actions!.digest});
    const bridge=async(state='failed',kind='inspect-installation',actor=email)=>{
        const id=randomUUID(),device=randomUUID();await pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES($1,$2,$3,'Disposable journal device',$1,$1)",[device,actor,role]);
        await pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,state,message,payload,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,'fixture status','{}',$8,$9)",[id,device,actor,role,project,kind,state,randomUUID(),'a'.repeat(64)]);
        await recordDeviceOperation(pool as never,{id,kind,project_id:project,email:actor},state.toUpperCase(),0,'fixture status');return 'bridge-'+id;
    };
    const rag=async(state='failed',actor=email)=>{
        const id=randomUUID();await pool.query("INSERT INTO project_reindex_plans(id,project_id,request_key,actor,active_role,state,digest,data,message,approved) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'fixture plan',true)",
            [id,project,randomUUID(),actor,role,state,'a'.repeat(64),{context:{generation:'old'},sourceSnapshot:'b'.repeat(64),profile:{provider:'openai',model:'fixture',dimension:3},rowCount:1}]);return 'rag-reindex-'+id;
    };
    const systemRole=async(state='running',actor=email)=>{
        const id=randomUUID(),active=['queued','running','applying'].includes(state);
        const row=(await pool.query(`INSERT INTO system_role_runs(id,agent_id,project_id,actor,actor_role,request_id,request_hash,request,snapshot,model,runner_instance,lease_token,lease_until,state,phase,steps,message,finished_at)
            VALUES($1,'agent-indexer',$2,$3,$4,$1,$5,$6,$7,'{}',$1,$1,CASE WHEN $8 THEN now()+interval '1 minute' ELSE NULL END,$9,$9,'[]','fixture role',CASE WHEN $10 THEN now() ELSE NULL END) RETURNING *`,
        [id,project,actor,role,'a'.repeat(64),{modelId:'model-fixture',expectedModelPin:'b'.repeat(64)},{targets:[]},active,state,!active&&state!=='awaiting_review'])).rows[0];
        await projectRoleOperation(pool,row);return 'system-role-'+id;
    };
    const codexCall=async(state='running')=>{
        const operationId=await bridge(state,'infer-device-codex'),id=operationId.slice(7),job=(await pool.query('SELECT device_id FROM bridge_jobs WHERE id=$1',[id])).rows[0];
        const modelId='model-fixture-'+randomUUID(),callId=randomUUID(),lease=randomUUID();
        await pool.query("INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,'{}')",[modelId]);
        await pool.query('UPDATE bridge_jobs SET lease=$2,lease_until=now()+interval \'1 minute\',payload=$3 WHERE id=$1',[id,lease,{protocol:DEVICE_CODEX_PROTOCOL,callId}]);
        await pool.query(`INSERT INTO device_model_calls(id,job_id,model_id,device_id,owner_email,actor_role,project_id,model_pin,runtime_model,connection_revision,request,required_features,deadline_at,dispatched_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'codex-fixture',1,'{}','[]',now()+interval '1 minute',now())`,[callId,id,modelId,job.device_id,email,role,project,'a'.repeat(64)]);
        const completion=(outcome:'succeeded'|'failed'):DeviceCompletion=>({lease,state:outcome,message:'untrusted fixture completion',result:outcome==='succeeded'?{
            protocol:DEVICE_CODEX_PROTOCOL,callId,response:{model:'codex-fixture',done:true,done_reason:'stop',message:{role:'assistant',content:'private fixture response'},prompt_eval_count:4,eval_count:8,usage_reported:true},
        }:{protocol:DEVICE_CODEX_PROTOCOL,callId,error:{code:'unknown-after-send'}}});
        return {operationId,id,deviceId:job.device_id,completion};
    };
    beforeAll(async()=>{
        const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only temporary localhost DB allowed');
        if(url.port==='5432'||!url.port)throw Error('Operation acceptance requires the explicitly owned QA port, never live 5432');
        admin=new Client({connectionString:connection});await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;pool=new Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:500});
        actionStore=new OperationActionStore({connectionString:url.toString(),connectionTimeoutMillis:500});
        await ensureCatalogSchema(pool);await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[project,'Fixture']);repository=new OperationRepository(pool);
        const models={pool,actor:async()=>{const c=claims();if(!c.userRoles.includes(role))throw new ForbiddenException();return {email,activeRole:role,claims:c};},resolveProject:async(_req:unknown,id:string,level:number)=>{
            if(projectLevel(claims(),role,id)<level)throw new ForbiddenException();return{id};}};
        const store={pool,access:{claims:async()=>claims()}};codex=new DeviceCodexService(models as never,store as never,{} as never,{} as never);
        jobs=new DeviceJobs(store as never,{} as never,{} as never,{} as never,{} as never,codex);
        vi.spyOn(jobs,'create').mockImplementation(async(actor,value)=>{
            const existing=(await pool.query('SELECT * FROM bridge_jobs WHERE email=$1 AND request_key=$2',[actor.email,value.requestKey])).rows[0];if(existing)return {...existing,message:existing.message};
            const id=randomUUID();await pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,state,message,payload,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,'queued','queued fixture',$7,$8,$9)",[id,value.deviceId,actor.email,actor.activeRole,value.projectId,value.kind,value,value.requestKey,'a'.repeat(64)]);
            await recordDeviceOperation(pool as never,{id,kind:value.kind,project_id:value.projectId!,email:actor.email},'QUEUED',0,'queued fixture');return{id,state:'queued',message:'queued fixture'};
        });
        reindex=new ProjectReindexService(models as never,{client:{call:vi.fn(async()=>({}))},context:async()=>({generation:'old'})} as never,{} as never,jobs);
        vi.spyOn(reindex as never,'launch' as never).mockImplementation(()=>undefined);
        const catalog={ensureSchema:async()=>{},getOperation:async(id:string,scope:never)=>{const result=await repository.get(id,scope);if(!result)throw new NotFoundException();return result;}};
        const lease=async(connect:typeof pool.connect)=>{const client=await connect();const barrier=checkoutBarrier;if(barrier){barrier.count++;if(barrier.count===5)barrier.entered();await barrier.release;}return {query:async(sql:string,values?:unknown[])=>{
            if(loseAck&&sql.startsWith('UPDATE operation_action_requests SET result')){loseAck=false;throw Error('fixture lost receipt ACK');}return client.query(sql,values);
        },release:(discard?:boolean)=>client.release(discard)};};
        const sessionConnect=actionStore.connect.bind(actionStore);vi.spyOn(actionStore,'connect').mockImplementation(()=>lease(sessionConnect) as never);
        const dispatchPool={query:pool.query.bind(pool),connect:()=>lease(pool.connect.bind(pool))};
        roles=new SystemRoleService(models as never,{} as never,catalog as never,{} as never,{} as never,{} as never);
        actions=new OperationActionsService(catalog as never,{...models,pool:dispatchPool} as never,jobs,reindex,{} as never,roles,actionStore);await actions.onModuleInit();
        Reflect.defineMetadata('design:paramtypes',[OperationActionsService],OperationActionsController);class FixtureModule{}
        app=await NestFactory.create({module:FixtureModule,controllers:[OperationActionsController],providers:[{provide:OperationActionsService,useValue:actions}]},{logger:false});await app.listen(0,'127.0.0.1');base=await app.getUrl();
    },30000);
    beforeEach(()=>{role='Админ проекта';revoked=false;projectRevoked=false;loseAck=false;checkoutBarrier=undefined;vi.mocked(jobs.create).mockClear();vi.mocked(requireFeaturesEnabled).mockClear();});
    afterAll(async()=>{await app?.close();await actionStore?.onApplicationShutdown();await pool?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin?.end();});
    it('Failed bridge retry creates one actual queue job for two keys/tabs and never rewrites the failed source operation',async()=>{
        const id=await bridge(),before=await repository.get(id),body=await input(id);
        const [a,b]=await Promise.all([post(id,'retry',body),post(id,'retry',{...body,requestKey:randomUUID()})]);
        expect(a.status).toBe(201);expect(b.body).toEqual(a.body);expect(vi.mocked(jobs.create)).toHaveBeenCalledOnce();expect(await repository.get(id)).toEqual(before);
    });
    it('Queued bridge cancellation executes the real atomic transition; running work refuses a stale preview',async()=>{
        const id=await bridge('queued'),body=await input(id);expect((await post(id,'cancel',body)).body.state).toBe('CANCELLED');expect((await repository.get(id))?.state).toBe('CANCELLED');
        const running=await bridge('queued'),stale=await input(running);await pool.query("UPDATE bridge_jobs SET state='running' WHERE id=$1",[running.slice(7)]);
        expect((await post(running,'cancel',stale)).status).toBe(409);expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[running.slice(7)])).rows[0].state).toBe('running');
    });
    it.each(['sync-learning-memory','import-learning-quirks','infer-device-codex'])('safe admitted %s cancellation reaches the real executor and remains in history',async kind=>{
        for(const state of ['running','reconciling']){
            const id=await bridge(state,kind),body=await input(id);
            expect((await operation(id)).actions!.cancel.supported).toBe(true);
            expect((await post(id,'cancel',body)).body.state).toBe('CANCELLED');
            expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[id.slice(7)])).rows[0].state).toBe('cancelled');
            expect((await operation(id)).state).toBe('CANCELLED');expect(vi.mocked(requireFeaturesEnabled)).not.toHaveBeenCalled();
        }
    });
    it('Codex executor cancellation and its operation projection commit together',async()=>{
        const id=await bridge('running','infer-device-codex');
        await jobs.cancel({email,activeRole:role},id.slice(7));
        expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[id.slice(7)])).rows[0].state).toBe('cancelled');
        expect((await operation(id)).state).toBe('CANCELLED');
        const saved=await operation(id);await jobs.cancel({email,activeRole:role},id.slice(7));
        expect(await operation(id)).toEqual(saved);
    });
    it.each(['succeeded','failed'] as const)('Codex actual %s private completion is reflected in public history without response text',async state=>{
        const call=await codexCall(),receipt=call.completion(state);
        expect(await completeDeviceJob(pool,call.deviceId,call.id,receipt)).toEqual({ok:true,repeated:false});
        expect((await operation(call.operationId)).state).toBe(state.toUpperCase());
        expect(JSON.stringify(await operation(call.operationId))).not.toContain('private fixture response');
        expect(await completeDeviceJob(pool,call.deviceId,call.id,receipt)).toEqual({ok:true,repeated:true});
    });
    it('late successful private receipt settles a failed uncertainty projection, while cancelled state stays cancelled',async()=>{
        for(const state of ['failed','cancelled']){
            const call=await codexCall(state);await completeDeviceJob(pool,call.deviceId,call.id,call.completion('succeeded'));
            const expected=state==='cancelled'?'CANCELLED':'SUCCEEDED';expect((await operation(call.operationId)).state).toBe(expected);
            expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[call.id])).rows[0].state).toBe(expected.toLowerCase());
        }
    });
    it.each(['succeeded','failed'] as const)('actual Codex %s COMMIT between preliminary read and cancel row lock cannot yield a false cancellation receipt',async state=>{
        const call=await codexCall(),body=await input(call.operationId),cancel=codex.cancel.bind(codex);
        let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
        const spy=vi.spyOn(codex,'cancel').mockImplementationOnce(async id=>{entered();await gate;return cancel(id);});
        const pending=post(call.operationId,'cancel',body);
        try{
            await ready;const receipt=call.completion(state);await completeDeviceJob(pool,call.deviceId,call.id,receipt);
            const before=(await pool.query('SELECT result,response_digest,cancelled_at FROM device_model_calls WHERE job_id=$1',[call.id])).rows[0];
            release();expect((await pending).status).toBe(409);
            expect((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[call.id])).rows[0].state).toBe(state);
            expect((await pool.query('SELECT result,response_digest,cancelled_at FROM device_model_calls WHERE job_id=$1',[call.id])).rows[0]).toEqual(before);
            expect(await completeDeviceJob(pool,call.deviceId,call.id,receipt)).toEqual({ok:true,repeated:true});
        }finally{release();await pending.catch(()=>undefined);spy.mockRestore();}
    });
    it.each(['queued','running','awaiting_review'])('own system-role %s cancellation uses the real revision-checked service',async state=>{
        const id=await systemRole(state),body=await input(id);
        expect((await operation(id)).actions).toMatchObject({executor:'system-role',cancel:{supported:true},retry:{supported:false}});
        expect((await post(id,'cancel',body)).body.state).toBe('CANCELLED');
        expect((await pool.query('SELECT state,revision FROM system_role_runs WHERE id=$1',[id.slice(12)])).rows[0]).toMatchObject({state:'cancelled',revision:1});
        expect((await operation(id)).state).toBe('CANCELLED');expect(vi.mocked(requireFeaturesEnabled)).not.toHaveBeenCalled();
    });
    it('applying and terminal system-role runs cannot be cancelled by stale active capabilities',async()=>{
        for(const state of ['applying','succeeded','failed','cancelled']){
            const id=await systemRole(state),body=await input(id);
            expect((await operation(id)).actions!.cancel.supported).toBe(false);expect((await post(id,'cancel',body)).status).toBe(409);
            expect((await pool.query('SELECT state FROM system_role_runs WHERE id=$1',[id.slice(12)])).rows[0].state).toBe(state);
        }
    });
    it.each(['succeeded','failed'] as const)('system-role %s owner completion between preview and cancel returns the actual saved state',async state=>{
        const id=await systemRole(),body=await input(id),cancel=roles.cancel.bind(roles);
        const spy=vi.spyOn(roles,'cancel').mockImplementationOnce(async(...args)=>{
            await roles.repository.transaction(async db=>{
                const row=await roles.repository.get(id.slice(12),db,true);if(!row)throw Error('owned role missing');
                await roles.repository.change(db,row,state,state,'Actual owner completion');
            });
            return cancel(...args);
        });
        try{
            const response=await post(id,'cancel',body);expect(response.body.state).toBe(state.toUpperCase());
            expect((await post(id,'cancel',body)).body).toEqual(response.body);expect(spy).toHaveBeenCalledOnce();expect((await operation(id)).state).toBe(state.toUpperCase());
        }finally{spy.mockRestore();}
    });
    it('five concurrent session locks leave the max-five models pool available for a real nested RAG cancellation',async()=>{
        const id=await rag('needs_input'),body=await input(id),cancel=vi.spyOn(reindex,'cancel');
        let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
        checkoutBarrier={count:0,entered,release:gate};
        const requests=Array.from({length:5},()=>post(id,'cancel',{...body,requestKey:randomUUID()}));
        try{
            await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('five explicit session checkouts did not arrive')),3000))]);
            expect(checkoutBarrier.count).toBe(5);release();
            const results=await Promise.all(requests);expect(results.map(result=>result.status)).toEqual([201,201,201,201,201]);
            expect(cancel).toHaveBeenCalledOnce();expect((await operation(id)).state).toBe('CANCELLED');expect(pool.options.max).toBe(5);
            expect((await pool.query('SELECT 1 AS alive')).rows).toEqual([{alive:1}]);
        }finally{release();await Promise.allSettled(requests);checkoutBarrier=undefined;cancel.mockRestore();}
    });
    it('fresh authority is rechecked after waiting for the real session lock and before any executor effect',async()=>{
        const id=await rag('needs_input'),body=await input(id),cancel=vi.spyOn(reindex,'cancel'),observer=new Client({connectionString:pool.options.connectionString});
        const lock='operation-action:'+email+':'+id;let pending:ReturnType<typeof post>|undefined;
        await observer.connect();await observer.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);
        try{
            pending=post(id,'cancel',body);
            await vi.waitFor(async()=>expect(Number((await observer.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_lock%'")).rows[0].n)).toBe(1),{timeout:3000});
            revoked=true;await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);
            expect((await pending).status).toBe(403);expect(cancel).not.toHaveBeenCalled();
            expect((await pool.query('SELECT state FROM project_reindex_plans WHERE id=$1',[id.slice(12)])).rows[0].state).toBe('needs_input');
        }finally{await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);await pending?.catch(()=>undefined);await observer.end();cancel.mockRestore();}
    });
    it.each(['cancelled','stale','needs_input','building'])('RAG %s cannot be retried as a failed generation',async state=>{
        const id=await rag(state),body=await input(id);expect((await operation(id)).actions?.retry.supported).toBe(false);expect((await post(id,'retry',body)).status).toBe(409);
        expect((await pool.query('SELECT state FROM project_reindex_plans WHERE id=$1',[id.slice(12)])).rows[0].state).toBe(state);
    });
    it('RAG failed retry/cancel uses existing services and a lost post-commit ACK never dispatches twice',async()=>{
        const id=await rag(),body=await input(id),retry=vi.spyOn(reindex,'retry');loseAck=true;
        expect((await post(id,'retry',body)).status).toBe(500);expect((await operation(id)).state).toBe('RUNNING');expect((await post(id,'retry',body)).status).toBe(201);expect(retry).toHaveBeenCalledOnce();retry.mockRestore();
        const cancelled=await rag('needs_input');expect((await post(cancelled,'cancel',await input(cancelled))).body.state).toBe('CANCELLED');expect((await operation(cancelled)).state).toBe('CANCELLED');
    });
    it('Fresh owner, role, project ACL, digest and key payload are checked before executor writes',async()=>{
        const own=await bridge(),body=await input(own);revoked=true;expect((await post(own,'retry',body)).status).toBe(403);revoked=false;
        projectRevoked=true;expect((await post(own,'retry',body)).status).toBe(404);projectRevoked=false;
        const foreign=await bridge('failed','inspect-installation','other@example.test');expect((await post(foreign,'retry',await input(foreign))).status).toBe(403);
        expect((await post(own,'retry',{...body,expectedDigest:'0'.repeat(64)})).status).toBe(409);expect((await post(own,'retry',{...body,actor:email})).status).toBe(400);
        expect(vi.mocked(jobs.create)).not.toHaveBeenCalled();expect((await post(own,'retry',body)).status).toBe(201);expect((await post(own,'cancel',body)).status).toBe(409);
    });
    it('The local bridge projection updates the RAG aggregate and historical handlers stay explicitly unsupported',async()=>{
        const id=await rag('applied'),job=await bridge('queued');await pool.query("UPDATE project_reindex_plans SET data=jsonb_set(data,'{connection}','{}'),connection_job_id=$2 WHERE id=$1",[id.slice(12),job.slice(7)]);
        expect((await operation(id)).state).toBe('QUEUED');await pool.query("UPDATE bridge_jobs SET state='succeeded',percent=100 WHERE id=$1",[job.slice(7)]);expect((await operation(id)).state).toBe('SUCCEEDED');
        const history={...(await operation(id)),resourceType:'tool-build',resourceId:randomUUID()};expect((await actions.decorate(request(),history)).actions).toMatchObject({executor:'tool-build',retry:{supported:false},cancel:{supported:false}});
    });
});
