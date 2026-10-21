import 'reflect-metadata';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client,Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {ForbiddenException,NotFoundException,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {Request} from 'express';
import {OperationActionsService} from '../src/operations/operation-actions.service';
import {OperationActionsController} from '../src/operations/operation-actions.controller';
import {OperationRepository} from '../src/operations/operation-repository';
import {setupProjectReindexOperations} from '../src/operations/project-reindex-operations';
import {DeviceJobs} from '../src/devices/device-jobs';
import {recordDeviceOperation} from '../src/devices/device-operations';
import {ProjectReindexService} from '../src/models/project-reindex.service';
import {projectLevel} from '../src/access/access.model';

vi.mock('../src/devices/device-operations',async original=>({...await original<typeof import('../src/devices/device-operations')>(),notifyDeviceOperations:vi.fn()}));
const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
describe.skipIf(!connection)('Generic journal dispatch — actual HTTP/PostgreSQL and existing executors',()=>{
    const name='nc_operation_'+randomUUID().replaceAll('-',''),email='fixture@example.test',project='prj-fixture';
    let admin:Client,pool:Pool,repository:OperationRepository,actions:OperationActionsService,jobs:DeviceJobs,reindex:ProjectReindexService,app:INestApplication,base:string;
    let role='Админ проекта',revoked=false,projectRevoked=false,loseAck=false,created=false;
    const claims=()=>({email,userRoles:revoked?[]:[role],projects:projectRevoked?[]:[{projectId:project,projectName:'Fixture',role:'Админ проекта'}],pluginIds:[],skillPaths:[]});
    const headers=()=>({'content-type':'application/json','x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole:role}))});
    const request=()=>({headers:headers()}) as unknown as Request;
    const post=async(id:string,action:string,body:unknown)=>{const response=await fetch(base+'/api/operations/'+id+'/'+action,{method:'POST',headers:headers(),body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
    const operation=async(id:string)=>{const row=await repository.get(id);if(!row)throw Error('fixture operation missing');return actions.decorate(request(),row);};
    const input=async(id:string,key=randomUUID())=>({requestKey:key,expectedDigest:(await operation(id)).actions!.digest});
    const bridge=async(state='failed',kind='inspect-installation',actor=email)=>{
        const id=randomUUID();await pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,state,message,payload,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,'fixture status','{}',$8)",[id,randomUUID(),actor,role,project,kind,state,randomUUID()]);
        await recordDeviceOperation(pool as never,{id,kind,project_id:project,email:actor},state.toUpperCase(),0,'fixture status');return 'bridge-'+id;
    };
    const rag=async(state='failed',actor=email)=>{
        const id=randomUUID();await pool.query("INSERT INTO project_reindex_plans(id,project_id,request_key,actor,active_role,state,digest,data,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'fixture plan')",
            [id,project,randomUUID(),actor,role,state,'a'.repeat(64),{context:{generation:'old'},sourceSnapshot:'b'.repeat(64),profile:{provider:'openai',model:'fixture',dimension:3},rowCount:1}]);return 'rag-reindex-'+id;
    };
    beforeAll(async()=>{
        const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only temporary localhost DB allowed');
        admin=new Client({connectionString:connection});await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;pool=new Pool({connectionString:url.toString(),max:12});
        await pool.query(`CREATE TABLE projects(id text PRIMARY KEY,name text);INSERT INTO projects VALUES('${project}','Fixture');
            CREATE TABLE operations(operation_id text PRIMARY KEY,type text,project_id text,resource_type text,resource_id text,actor text,state text,percent integer,
                bytes_done bigint DEFAULT 0,bytes_total bigint DEFAULT 0,started_at timestamptz,finished_at timestamptz,error text,log jsonb,retries integer DEFAULT 0,created_at timestamptz DEFAULT now());
            CREATE TABLE bridge_jobs(id text PRIMARY KEY,device_id text,email text,role text,project_id text,kind text,state text,message text,payload jsonb,request_key uuid,
                percent integer,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(email,request_key));
            CREATE TABLE project_reindex_plans(id uuid PRIMARY KEY,project_id text,request_key text,actor text,active_role text,state text,digest text,data jsonb,message text,
                approved boolean DEFAULT true,progress integer DEFAULT 0,connection_job_id uuid,connection_error text,connection_request_key uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());`);
        await setupProjectReindexOperations(pool);repository=new OperationRepository(pool);
        const models={pool,actor:async()=>{const c=claims();if(!c.userRoles.includes(role))throw new ForbiddenException();return {email,activeRole:role,claims:c};},resolveProject:async(_req:unknown,id:string,level:number)=>{
            if(projectLevel(claims(),role,id)<level)throw new ForbiddenException();return{id};}};
        jobs=new DeviceJobs({pool,access:{claims:async()=>claims()}} as never,{} as never,{} as never,{} as never,{} as never);
        vi.spyOn(jobs,'create').mockImplementation(async(actor,value)=>{
            const existing=(await pool.query('SELECT * FROM bridge_jobs WHERE email=$1 AND request_key=$2',[actor.email,value.requestKey])).rows[0];if(existing)return {...existing,message:existing.message};
            const id=randomUUID();await pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,state,message,payload,request_key) VALUES($1,$2,$3,$4,$5,$6,'queued','queued fixture',$7,$8)",[id,value.deviceId,actor.email,actor.activeRole,value.projectId,value.kind,value,value.requestKey]);
            await recordDeviceOperation(pool as never,{id,kind:value.kind,project_id:value.projectId!,email:actor.email},'QUEUED',0,'queued fixture');return{id,state:'queued',message:'queued fixture'};
        });
        reindex=new ProjectReindexService(models as never,{client:{call:vi.fn(async()=>({}))},context:async()=>({generation:'old'})} as never,{} as never,jobs);
        vi.spyOn(reindex as never,'launch' as never).mockImplementation(()=>undefined);
        const catalog={ensureSchema:async()=>{},getOperation:async(id:string,scope:never)=>{const result=await repository.get(id,scope);if(!result)throw new NotFoundException();return result;}};
        const dispatchPool={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return {query:async(sql:string,values?:unknown[])=>{
            if(loseAck&&sql.startsWith('UPDATE operation_action_requests SET result')){loseAck=false;throw Error('fixture lost receipt ACK');}return client.query(sql,values);
        },release:(discard?:boolean)=>client.release(discard)};}};
        actions=new OperationActionsService(catalog as never,{...models,pool:dispatchPool} as never,jobs,reindex);await actions.onModuleInit();
        Reflect.defineMetadata('design:paramtypes',[OperationActionsService],OperationActionsController);class FixtureModule{}
        app=await NestFactory.create({module:FixtureModule,controllers:[OperationActionsController],providers:[{provide:OperationActionsService,useValue:actions}]},{logger:false});await app.listen(0,'127.0.0.1');base=await app.getUrl();
    },30000);
    beforeEach(()=>{role='Админ проекта';revoked=false;projectRevoked=false;loseAck=false;vi.mocked(jobs.create).mockClear();});
    afterAll(async()=>{await app?.close();await pool?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin?.end();});
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
