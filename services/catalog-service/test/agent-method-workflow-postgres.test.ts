import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {AccessDb} from '../src/access/access-db';
import {DeviceJobs} from '../src/devices/device-jobs';
import {completeDeviceJob} from '../src/devices/device-completion';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';
import type {ProjectEmbeddingService} from '../src/models/project-embedding.service';
import {connection,database,reset,admin,developer} from './agent-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';

describe.skipIf(!connection)('method workflow durable queue — owned PostgreSQL',()=>{
    let fixture:Awaited<ReturnType<typeof database>>,jobs:DeviceJobs,device:Device;
    beforeAll(async()=>{fixture=await database();},30000);
    afterAll(async()=>fixture?.close());
    beforeEach(async()=>{
        await reset(fixture.pool);
        device={id:'device-methods',email:admin.email,role:admin.activeRole,name:'QA',fingerprint:'fixture',last_seen:null,revoked:false,
            report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','agent-method-workflow-v1'],bindings:[{projectId:'prj-agents',bindingId,instanceId,valid:true}]}};
        await fixture.pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7)',[device.id,device.email,device.role,device.name,device.fingerprint,'method-fixture-token',device.report]);
        const access=new AccessDb();Object.defineProperty(access,'pool',{value:fixture.pool});
        const store={pool:fixture.pool,access,owned:async(actor:{email:string},id:string)=>{if(actor.email!==device.email||id!==device.id)throw Error('not owned');return device;}} as unknown as DeviceStore;
        jobs=new DeviceJobs(store,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans,{} as ProjectEmbeddingService);
    });
    const intent=()=>({kind:'run-agent-method-workflow',projectId:'prj-agents',deviceId:device.id,requestKey:randomUUID(),expectedBindingId:bindingId,expectedInstanceId:instanceId,
        workflow:{method:'openspec' as const,instruction:'QA fixture task',checks:[{command:'npm',args:['test']}]}});
    const completion=(payload:Record<string,unknown>)=>({protocol:'agent-method-workflow-v1',workflowId:payload.workflowId,method:payload.method,methodVersion:payload.methodVersion,runtime:'opencode',state:'succeeded',stage:'completed',codeChanged:true,
        changes:[{path:'src/qa.ts',beforeSha256:'a'.repeat(64),afterSha256:'b'.repeat(64)}],artifacts:[],checks:[{command:'npm',args:['test'],exitCode:0,signal:null,state:'passed'}]});

    it('accepts one immutable intent, preserves enqueue/completion ACK and records one durable job',async()=>{
        const input=intent(),first=await jobs.create(admin,input),again=await jobs.create(admin,input);expect(again.id).toBe(first.id);expect(first.workflowId).toBe(input.requestKey);
        await expect(jobs.create(admin,{...input,workflow:{...input.workflow,instruction:'Different intent'}})).rejects.toThrow(/Ключ/);
        const claimed=(await jobs.claim(device))!;expect(claimed.id).toBe(first.id);expect(claimed.payload).toMatchObject({workflowId:input.requestKey,bindingId,instanceId,methodVersion:'1.15.0'});
        const accepted={lease:claimed.lease,state:'succeeded' as const,message:'QA complete',result:completion(claimed.payload)};
        expect(await completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).toMatchObject({ok:true});
        expect(await completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).toMatchObject({ok:true,repeated:true});
        expect((await fixture.pool.query('SELECT state,result FROM bridge_jobs WHERE id=$1',[claimed.id])).rows[0]).toMatchObject({state:'succeeded',result:accepted.result});
        expect((await fixture.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count).toBe(1);
    },15000);

    it('rejects developer execution and an unrelated instance before queue admission',async()=>{
        await expect(jobs.create(developer,intent())).rejects.toThrow();
        await expect(jobs.create(admin,{...intent(),expectedInstanceId:randomUUID()})).rejects.toThrow(/Папка/);
        expect((await fixture.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count).toBe(0);
    });

    it('cannot accept a stale binding or revoked grant as successful completion',async()=>{
        await jobs.create(admin,intent());const claimed=(await jobs.claim(device))!;
        const accepted={lease:claimed.lease,state:'succeeded' as const,message:'QA complete',result:completion(claimed.payload)};
        await fixture.pool.query("UPDATE bridge_devices SET report=jsonb_set(report,'{bindings,0,instanceId}',to_jsonb($2::text)) WHERE id=$1",[device.id,randomUUID()]);
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).rejects.toThrow(/Папка/);
        await fixture.pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[device.id,device.report]);
        await fixture.pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id='prj-agents' AND principal_name=$1",[admin.email]);
        await expect(completeDeviceJob(fixture.pool,device.id,claimed.id,accepted)).rejects.toThrow(/отозван/);
        expect((await fixture.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[claimed.id])).rows[0].state).toBe('running');
    });
});
