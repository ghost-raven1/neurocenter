import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type {IAccessClaims} from '../src/access/access.model';
import {completeDeviceJob} from '../src/devices/device-completion';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {DeviceStore} from '../src/devices/device-store';
import type {Job} from '../src/devices/device-job.model';
import {completionFaultPool,deviceCompletionFixture,ownedDeviceTestAdminUrl} from './device-completion-postgres.fixture';
import {installCompletion,inspectionCompletion,ragDevice,ragInstallJob,ragInstallSet,ragInspectionFixtureSchema,seedRagInstall,ragInstance,ragProject} from './rag-install-inspection.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
const adminUrl=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!adminUrl).sequential('RAG auto-inspection durable serial continuation on owned PostgreSQL',()=>{
    let f:Awaited<ReturnType<typeof deviceCompletionFixture>>;
    const evidence:unknown[]=[];
    beforeAll(async()=>{ownedDeviceTestAdminUrl(adminUrl!);f=await deviceCompletionFixture(adminUrl!);await ragInspectionFixtureSchema(f.pool);});
    beforeEach(async()=>{await f.pool.query('TRUNCATE bridge_job_requests,bridge_jobs,bridge_devices,operations,projects CASCADE');vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));});
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{
        if(!f)return;const cleanup=await f.dispose();
        if(process.env.RAG_INSPECTION_TEST_RECEIPT)await writeFile(process.env.RAG_INSPECTION_TEST_RECEIPT,JSON.stringify({evidence,cleanup},null,2)+'\n',{flag:'wx',mode:0o600});
        expect(cleanup).toMatchObject({dropped:true,originalDatabasesPreserved:true,newDatabasesRemaining:[]});
    });
    const children=async()=>(await f.observer.query<Job>("SELECT * FROM bridge_jobs WHERE kind='inspect-installation' ORDER BY created_at,id")).rows;
    async function seed(set=ragInstallSet()){
        const device=ragDevice(),job=ragInstallJob(device,set);await seedRagInstall(f.pool,device,job);return{device,job,input:installCompletion(job)};
    }
    async function finish(child:Job,failed=false){
        const lease=randomUUID();await f.pool.query("UPDATE bridge_jobs SET state='running',lease=$2,lease_until=now()+interval '3 minutes' WHERE id=$1",[child.id,lease]);
        child={...child,lease};return completeDeviceJob(f.pool,child.device_id,child.id,inspectionCompletion(child,failed));
    }
    function service(device:ReturnType<typeof ragDevice>,claims:()=>Promise<IAccessClaims>){
        const value=new DeviceJobs({pool:f.pool,access:{claims}} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
        vi.spyOn(value as unknown as {expire():Promise<void>},'expire').mockResolvedValue(undefined);return value;
    }
    it('serially verifies both exact frozen MCP/plugin packages, without declaring index or runtime ready',async()=>{
        const j=await seed();await completeDeviceJob(f.pool,j.device.id,j.job.id,j.input);
        let queued=await children();evidence.push({case:'first-completion-readback',installState:(await f.observer.query('SELECT state FROM bridge_jobs WHERE id=$1',[j.job.id])).rows[0].state,childCount:queued.length});
        expect(queued).toHaveLength(1);expect(queued[0]).toMatchObject({state:'queued',device_id:j.device.id,email:j.device.email,role:j.device.role,project_id:ragProject});
        expect(queued[0].payload.package).toEqual((j.job.payload.installSet as ReturnType<typeof ragInstallSet>).packages[0]);
        expect(queued[0].payload.autoRagInspection).toMatchObject({schemaVersion:1,installJobId:j.job.id,position:0,instanceId:ragInstance});
        await finish(queued[0]);queued=await children();expect(queued).toHaveLength(2);expect(queued.filter(row=>row.state==='queued')).toHaveLength(1);
        const next=queued.find(row=>row.state==='queued')!;expect(next.payload.autoRagInspection).toMatchObject({position:1});
        expect(next.payload.package).toEqual((j.job.payload.installSet as ReturnType<typeof ragInstallSet>).packages[1]);
        await finish(next);expect((await children()).filter(row=>['queued','running'].includes(row.state))).toEqual([]);
        expect((await f.observer.query("SELECT kind FROM bridge_jobs WHERE kind IN ('connect-rag-model','sync-rag','probe-runtime')")).rows).toEqual([]);
        for(const row of await children())expect((row as unknown as {result:{readiness:string}}).result.readiness).toBe('unverified');
        evidence.push({case:'serial-exact-packages',children:2,paidCalls:0});
    });
    it('duplicate and concurrent install completion ACKs enqueue only one first child and one journal',async()=>{
        const j=await seed(),acks=await Promise.all([completeDeviceJob(f.pool,j.device.id,j.job.id,j.input),completeDeviceJob(f.observer,j.device.id,j.job.id,j.input)]);
        expect(acks.map(value=>value.repeated).sort()).toEqual([false,true]);expect(await children()).toHaveLength(1);
        expect((await f.pool.query('SELECT * FROM operations WHERE operation_id=$1',['bridge-'+j.job.id])).rows).toHaveLength(1);
        expect((await f.pool.query('SELECT * FROM bridge_job_requests')).rows).toHaveLength(1);
    });
    it('a failed install and a cancelled install never create inspection jobs',async()=>{
        const j=await seed();await completeDeviceJob(f.pool,j.device.id,j.job.id,installCompletion(j.job,true));expect(await children()).toEqual([]);
        const other=ragInstallJob(j.device,ragInstallSet());other.state='cancelled';await seedRagInstall(f.pool,j.device,other);
        await expect(completeDeviceJob(f.pool,j.device.id,other.id,installCompletion(other))).rejects.toMatchObject({status:409});expect(await children()).toEqual([]);
    });
    it('failure to write the follow-up rolls back the install status and all journals',async()=>{
        const j=await seed();await f.pool.query("ALTER TABLE bridge_jobs ADD CONSTRAINT own_fail_inspection CHECK(kind<>'inspect-installation')");
        try{await expect(completeDeviceJob(f.pool,j.device.id,j.job.id,j.input)).rejects.toMatchObject({code:'23514'});}finally{await f.pool.query('ALTER TABLE bridge_jobs DROP CONSTRAINT own_fail_inspection');}
        expect((await f.observer.query('SELECT state FROM bridge_jobs WHERE id=$1',[j.job.id])).rows[0].state).toBe('running');expect(await children()).toEqual([]);
        expect((await f.observer.query('SELECT * FROM operations')).rows).toEqual([]);
    });
    it('lost COMMIT ACK preserves the child and exact retry cannot add a duplicate',async()=>{
        const j=await seed(),fault=completionFaultPool(f.pool,'commit-ack',true);
        await expect(completeDeviceJob(fault.pool,j.device.id,j.job.id,j.input)).rejects.toBe(fault.failure);expect(await children()).toHaveLength(1);
        expect(await completeDeviceJob(f.pool,j.device.id,j.job.id,j.input)).toMatchObject({repeated:true});expect(await children()).toHaveLength(1);
    });
    it('cancelled queued inspection stops the serial chain; a failed completed inspection can advance',async()=>{
        const j=await seed();await completeDeviceJob(f.pool,j.device.id,j.job.id,j.input);const first=(await children())[0];
        first.lease=randomUUID();await f.pool.query("UPDATE bridge_jobs SET state='cancelled',lease=$2 WHERE id=$1",[first.id,first.lease]);
        for(let attempt=0;attempt<2;attempt++)await expect(completeDeviceJob(f.pool,first.device_id,first.id,inspectionCompletion(first))).rejects.toMatchObject({status:409});
        expect(await children()).toHaveLength(1);
        const second=await seed();await completeDeviceJob(f.pool,second.device.id,second.job.id,second.input);
        const next=(await children()).find(row=>(row.payload.autoRagInspection as {installJobId:string}).installJobId===second.job.id)!;await finish(next,true);
        expect((await children()).filter(row=>row.state==='queued')).toHaveLength(1);
    });
    it('one-for-one continuation keeps one hundred accepted installs within the existing queue bound',async()=>{
        const device=ragDevice(),jobs=Array.from({length:100},()=>ragInstallJob(device,ragInstallSet()));
        for(const job of jobs)await seedRagInstall(f.pool,device,job);
        for(const job of jobs)await completeDeviceJob(f.pool,device.id,job.id,installCompletion(job));
        expect((await f.pool.query("SELECT count(*)::int AS count FROM bridge_jobs WHERE state IN ('queued','running','reconciling')")).rows[0].count).toBe(100);
        expect(await children()).toHaveLength(100);await finish((await children())[0]);
        expect((await f.pool.query("SELECT count(*)::int AS count FROM bridge_jobs WHERE state IN ('queued','running','reconciling')")).rows[0].count).toBe(100);
    });
    it.each(['role','capability','binding','instance'] as const)('fresh %s revocation prevents delivery of automatic file reads',async change=>{
        const j=await seed();await completeDeviceJob(f.pool,j.device.id,j.job.id,j.input);
        const claims:IAccessClaims={email:j.device.email,userRoles:[j.device.role],projects:[{projectId:ragProject,projectName:'Owned',role:j.device.role}],pluginIds:[],skillPaths:[]};
        if(change==='role')claims.projects=[];
        else if(change==='capability')j.device.report.capabilities=['durable-completions','managed-installations','package-v5'];
        else j.device.report.bindings=[{projectId:ragProject,bindingId:change==='binding'?'c'.repeat(64):j.job.payload.bindingId,instanceId:change==='instance'?randomUUID():ragInstance,valid:true}];
        expect(await service(j.device,async()=>claims).claim(j.device)).toBeNull();expect((await children())[0].state).toBe('failed');
    });
    it('fresh identity is rechecked again after claim before the worker can read files',async()=>{
        const j=await seed();await completeDeviceJob(f.pool,j.device.id,j.job.id,j.input);
        const claims:IAccessClaims={email:j.device.email,userRoles:[j.device.role],projects:[{projectId:ragProject,projectName:'Owned',role:j.device.role}],pluginIds:[],skillPaths:[]};
        const jobs=service(j.device,async()=>claims),claimed=await jobs.claim(j.device);expect(claimed?.kind).toBe('inspect-installation');
        j.device.report.bindings=[];await expect(jobs.authorize(j.device,claimed!.id,claimed!.lease)).rejects.toMatchObject({status:409});
    });
});
