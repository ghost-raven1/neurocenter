import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {completeDeviceJob} from '../src/devices/device-completion';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {completionFaultPool} from './device-completion-postgres.fixture';
import {runtimeCachePostgresFixture} from './runtime-cache-policy-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const adminUrl=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!adminUrl).sequential('Owner runtime cache policy through the actual durable device queue',()=>{
    let f:Awaited<ReturnType<typeof runtimeCachePostgresFixture>>;
    const evidence:unknown[]=[];
    beforeAll(async()=>{f=await runtimeCachePostgresFixture(adminUrl!);});
    beforeEach(async()=>{vi.clearAllMocks();await f.reset();vi.stubGlobal('fetch',vi.fn(async()=>({ok:true})));});
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{
        vi.restoreAllMocks();if(!f)return;const cleanup=await f.dispose();
        if(process.env.RUNTIME_CACHE_TEST_RECEIPT)await writeFile(process.env.RUNTIME_CACHE_TEST_RECEIPT,JSON.stringify({evidence,cleanup},null,2)+'\n',{flag:'wx',mode:0o600});
        expect(cleanup).toMatchObject({dropped:true,originalDatabasesPreserved:true,newDatabasesRemaining:[]});
    });
    async function running(payload=f.set){
        const queued=await f.service.create(f.actor,f.input(payload));
        const job=await f.service.claim(f.device);expect(job?.id).toBe(queued.id);return job!;
    }
    const completion=(lease:string,result:Record<string,unknown>)=>({lease,state:'succeeded' as const,message:'untrusted client message',result});

    it('a developer inspects their machine without a project or enabled business feature',async()=>{
        f.enabled(false);const job=await running(f.inspect);
        await expect(f.service.authorize(f.device,job.id,job.lease)).resolves.toMatchObject({ok:true,projectId:null});
        const result={...f.report(f.inspect),usedBytes:3*1024**3};
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,result))).resolves.toMatchObject({ok:true,repeated:false});
        expect(await f.row(job.id)).toMatchObject({state:'succeeded',project_id:null,result});
        expect((await f.service.list(f.actor)).map(row=>row.id)).toContain(job.id);
        evidence.push({case:'inspect-off',state:(await f.row(job.id)).state,globalHistory:true});
    });
    it('SET is gated before queue admission, while an accepted request key stays recoverable OFF',async()=>{
        const request=f.input();f.enabled(false);
        await expect(f.service.create(f.actor,request)).rejects.toMatchObject({status:403});
        expect((await f.observer.query('SELECT id FROM bridge_jobs')).rows).toHaveLength(0);
        f.enabled(true);const first=await f.service.create(f.actor,request);f.enabled(false);
        expect(await f.service.create(f.actor,request)).toMatchObject({id:first.id,state:'queued'});
        await expect(f.service.create(f.actor,{...request,runtimeCachePolicy:{...f.set,limitBytes:4*1024**3}})).rejects.toMatchObject({status:409});
        expect(await f.service.claim(f.device)).toBeNull();expect(await f.row(String(first.id))).toMatchObject({state:'failed'});
        expect((await f.observer.query('SELECT id FROM bridge_jobs')).rows).toHaveLength(1);
        expect((await f.observer.query('SELECT job_id FROM bridge_job_requests')).rows).toHaveLength(1);
    });
    it('fresh role loss under enqueue device lock rolls back both job and idempotency receipt',async()=>{
        f.claims.mockImplementationOnce(async()=>({email:f.actor.email,userRoles:[f.actor.activeRole],projects:[]}));
        f.roles([]);await expect(f.service.create(f.actor,f.input())).rejects.toMatchObject({status:403});
        for(const table of ['bridge_jobs','bridge_job_requests','operations'])expect((await f.observer.query('SELECT 1 FROM '+table)).rows).toHaveLength(0);
    });
    it.each(['role','capability'] as const)('claim rechecks %s and refuses an already queued setting',async cause=>{
        const queued=await f.service.create(f.actor,f.input());
        if(cause==='role')f.roles([]);
        else await f.observer.query("UPDATE bridge_devices SET report=jsonb_set(report,'{capabilities}','[]') WHERE id=$1",[f.device.id]);
        expect(await f.service.claim(f.device)).toBeNull();expect(await f.row(String(queued.id))).toMatchObject({state:'failed'});
    });
    it.each(['flag','role'] as const)('running SET requires a fresh %s immediately before local write',async cause=>{
        const job=await running();if(cause==='flag')f.enabled(false);else f.roles([]);
        await expect(f.service.authorize(f.device,job.id,job.lease)).rejects.toMatchObject({status:403});
        expect(await f.row(job.id)).toMatchObject({state:'running',result:null});
    });
    it.each(['revoked','owner','capability','role'] as const)('last authority read fences %s changes while feature lookup waits',async cause=>{
        const job=await running();
        vi.mocked(requireFeaturesEnabled).mockImplementationOnce(async()=>{
            if(cause==='role')f.roles([]);
            else if(cause==='revoked')await f.observer.query('UPDATE bridge_devices SET revoked=true WHERE id=$1',[f.device.id]);
            else if(cause==='owner')await f.observer.query('UPDATE bridge_devices SET email=$2 WHERE id=$1',[f.device.id,'other@example.test']);
            else await f.observer.query("UPDATE bridge_devices SET report=jsonb_set(report,'{capabilities}','[]') WHERE id=$1",[f.device.id]);
        });
        await expect(f.service.authorize(f.device,job.id,job.lease)).rejects.toMatchObject({status:cause==='role'?403:409});
    });
    it.each(['inspect','set'] as const)('a fresh cleanup-only report preserves inspection but fences a target write: %s',async action=>{
        const capabilities=[...f.device.report.capabilities as string[],'runtime-cache-target-v2','bridge-update-cleanup-v1'];
        const device={...f.device,report:{...f.device.report,capabilities}};
        await f.observer.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[device.id,device.report]);
        const payload=action==='inspect'?{schemaVersion:2 as const,action}:{schemaVersion:2 as const,action,expectedRevision:0,limitBytes:1024**2};
        const queued=await f.service.create(f.actor,f.input(payload)),job=await f.service.claim(device);expect(job?.id).toBe(queued.id);
        vi.mocked(requireFeaturesEnabled).mockImplementationOnce(async()=>{
            await f.observer.query("UPDATE bridge_devices SET report=jsonb_set(report,'{capabilities}',$2::jsonb) WHERE id=$1",[device.id,JSON.stringify(capabilities.filter(value=>value!=='runtime-cache-target-v2'))]);
        });
        const authorized=f.service.authorize(device,job!.id,job!.lease);
        if(action==='inspect')await expect(authorized).resolves.toMatchObject({ok:true,projectId:null});
        else await expect(authorized).rejects.toMatchObject({status:409});
        expect(await f.row(job!.id)).toMatchObject({state:'running',result:null});
    });
    it('a soft target smaller than usage completes and replays the same receipt with the feature off',async()=>{
        const device={...f.device,report:{...f.device.report,capabilities:[...f.device.report.capabilities as string[],'runtime-cache-target-v2']}};
        await f.observer.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[device.id,device.report]);
        const queued=await f.service.create(f.actor,f.input({schemaVersion:2,action:'set',expectedRevision:0,limitBytes:1024**2})),job=await f.service.claim(device);expect(job?.id).toBe(queued.id);
        const {RUNTIME_CACHE_TARGET_LIMITS:bounds}=await import('../../shared/runtime-cache-policy.cjs');
        const result={schemaVersion:2,revision:1,limitBytes:1024**2,usedBytes:2*1024**2,defaultBytes:bounds.defaultBytes,minBytes:bounds.minBytes,maxBytes:bounds.maxBytes,
            observedAt:new Date().toISOString(),cleanup:{enabled:true,keepPrevious:2,minAgeDays:7}};
        const input=completion(job!.lease,result);
        await expect(completeDeviceJob(f.pool,device.id,job!.id,input)).resolves.toMatchObject({repeated:false});
        f.enabled(false);await expect(completeDeviceJob(f.pool,device.id,job!.id,input)).resolves.toMatchObject({repeated:true});
        expect(await f.row(job!.id)).toMatchObject({state:'succeeded',result});
        expect((await f.observer.query('SELECT operation_id FROM operations')).rows).toHaveLength(1);
    });
    it('foreign devices, project-shaped input, observers and old bridge capabilities cannot configure this cache',async()=>{
        await expect(f.service.create({...f.actor,email:'other@example.test'},f.input())).rejects.toMatchObject({status:403});
        await expect(f.service.create(f.actor,{...f.input(),projectId:'not-a-project'})).rejects.toMatchObject({status:400});
        f.roles(['Наблюдатель']);await expect(f.service.create({...f.actor,activeRole:'Наблюдатель'},f.input())).rejects.toMatchObject({status:403});f.roles([f.actor.activeRole]);
        await f.observer.query("UPDATE bridge_devices SET report=jsonb_set(report,'{capabilities}','[]') WHERE id=$1",[f.device.id]);
        await expect(f.service.create(f.actor,f.input())).rejects.toMatchObject({status:409});
        expect((await f.observer.query('SELECT id FROM bridge_jobs')).rows).toHaveLength(0);
    });
    it('lost COMMIT acknowledgement recovers the exact receipt OFF without another operation or setting job',async()=>{
        const job=await running(),result=f.report(),input=completion(job.lease,result),fault=completionFaultPool(f.pool,'commit-ack',false);
        await expect(completeDeviceJob(fault.pool,f.device.id,job.id,input)).rejects.toBe(fault.failure);
        f.enabled(false);await expect(completeDeviceJob(f.pool,f.device.id,job.id,input)).resolves.toEqual({ok:true,repeated:true});
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,{...result,usedBytes:result.usedBytes+1}))).rejects.toMatchObject({status:409});
        expect(await f.row(job.id)).toMatchObject({state:'succeeded',result});
        expect((await f.observer.query('SELECT operation_id FROM operations')).rows).toHaveLength(1);
        expect((await f.observer.query('SELECT id FROM bridge_jobs')).rows).toHaveLength(1);
        evidence.push({case:'lost-commit-ack',state:(await f.row(job.id)).state,repeated:true,jobs:1,operations:1});
    });
    it('a locally saved receipt survives lease expiry and flag OFF without obtaining a new write permit',async()=>{
        const job=await running(),result=f.report();
        await f.observer.query("UPDATE bridge_jobs SET state='reconciling',lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);f.enabled(false);
        await expect(f.service.authorize(f.device,job.id,job.lease)).rejects.toMatchObject({status:409});
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,result))).resolves.toMatchObject({repeated:false});
        expect(await f.row(job.id)).toMatchObject({state:'succeeded',result});
    });
    it.each(['wrong-limit','wrong-revision','below-usage','private-value'] as const)('receipt rejects %s before changing queue or history',async cause=>{
        const job=await running(),result:Record<string,unknown>=f.report();
        if(cause==='wrong-limit')result.limitBytes=4*1024**3;
        else if(cause==='wrong-revision')result.revision=5;
        else if(cause==='below-usage')result.usedBytes=4*1024**3;
        else result.path='/private';
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,result))).rejects.toMatchObject({status:409});
        expect(await f.row(job.id)).toMatchObject({state:'running',result:null});
    });
    it('same-value unchanged receipt is valid and active cancel/generic retry remain unavailable',async()=>{
        const queued=await f.service.create(f.actor,f.input());f.enabled(false);
        await expect(f.service.cancel(f.actor,String(queued.id))).resolves.toEqual({ok:true});
        await expect(f.service.retry(f.actor,String(queued.id),randomUUID())).rejects.toMatchObject({status:409});
        f.enabled(true);const job=await running();
        await expect(f.service.cancel(f.actor,job.id)).rejects.toMatchObject({status:409});
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,{...f.report(),revision:0}))).resolves.toMatchObject({ok:true});
        expect(await f.row(job.id)).toMatchObject({state:'succeeded'});
    });
    it.each(['queued','cancelled'])('a %s job cannot claim a local settings receipt',async state=>{
        const job=await running();await f.observer.query('UPDATE bridge_jobs SET state=$2 WHERE id=$1',[job.id,state]);
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,f.report()))).rejects.toMatchObject({status:409});
        expect(await f.row(job.id)).toMatchObject({state,result:null});
    });
    it('failed completion carries no local values and cannot later be replaced by another outcome',async()=>{
        const job=await running();f.enabled(false);
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,{lease:job.lease,state:'failed',message:'private',result:{path:'/private'}})).rejects.toMatchObject({status:409});
        const failed={lease:job.lease,state:'failed' as const,message:'private',result:{}};
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,failed)).resolves.toMatchObject({repeated:false});
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,failed)).resolves.toMatchObject({repeated:true});
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,f.report()))).rejects.toMatchObject({status:409});
        expect(await f.row(job.id)).toMatchObject({state:'failed',result:{}});
        expect((await f.row(job.id)).message).not.toContain('private');
    });
});
