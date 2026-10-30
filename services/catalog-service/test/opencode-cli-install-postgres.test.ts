import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {ConflictException} from '@nestjs/common';
import {computerSetupPostgresFixture} from './computer-setup-postgres.fixture';
import {completeDeviceJob} from '../src/devices/device-completion';
import {DeviceJobs} from '../src/devices/device-jobs';
import {DeviceStore} from '../src/devices/device-store';
import {digest} from '../src/devices/device-store';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const adminUrl=process.env.COMPUTER_SETUP_TEST_PG_URL,kind='install-opencode-cli';
const source={buildId:'a'.repeat(64),target:'darwin-arm64',version:'1.14.48',sha256:'b'.repeat(64)};
describe.skipIf(!adminUrl).sequential('Bridge-bundled installation through real queue and authority',()=>{
    let f:Awaited<ReturnType<typeof computerSetupPostgresFixture>>;
    const approval={requireOpenCode:vi.fn(async()=>{})},evidence:unknown[]=[];
    beforeAll(async()=>{f=await computerSetupPostgresFixture(adminUrl!,approval);});
    beforeEach(async()=>{
        vi.clearAllMocks();await f.reset();approval.requireOpenCode.mockImplementation(async()=>{});
        vi.stubGlobal('fetch',vi.fn(async()=>({ok:true})));
        await f.observer.query("UPDATE project_members SET role='Разработчик' WHERE principal_name=$1",[f.actor.email]);
        f.device.role='Разработчик';f.device.report={protocolVersion:2,capabilities:['durable-completions','managed-installations','opencode-cli-v1','opencode-cli-install-v1'],buildId:source.buildId,runtimeArtifactTarget:source.target,openCodeInstallSupply:source};
        await f.observer.query('UPDATE bridge_devices SET role=$2,report=$3 WHERE id=$1',[f.device.id,f.device.role,f.device.report]);
    });
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{vi.restoreAllMocks();if(!f)return;const cleanup=await f.dispose();
        if(process.env.COMPUTER_SETUP_TEST_RECEIPT)await writeFile(process.env.COMPUTER_SETUP_TEST_RECEIPT,JSON.stringify({evidence,cleanup},null,2)+'\n',{flag:'wx',mode:0o600});
        expect(cleanup).toMatchObject({dropped:true,originalDatabasesPreserved:true,newDatabasesRemaining:[]});});
    const actor=()=>({...f.actor,activeRole:'Разработчик'});
    const request=(key=randomUUID())=>({deviceId:f.device.id,kind,scope:'global' as const,requestKey:key});
    const result=(id:string)=>({schemaVersion:1,scope:'global',deviceId:f.device.id,source,jobId:id,checkedAt:new Date().toISOString(),status:'installed',installedVersion:'1.14.48',commandVersion:null,commandReady:false,nextAction:'inspect-path'});
    const completion=(job:{id:string;lease:string},change:Record<string,unknown>={})=>({lease:job.lease,state:'succeeded' as const,message:'private output must be ignored',result:{...result(job.id),...change}});
    async function running(){const input=request(),queued=await f.service.create(actor(),input),job=await f.service.claim(f.device);expect(job?.id).toBe(queued.id);return {input,job:job!};}
    it('creates a projectless write job with an immutable approved bundled source',async()=>{
        const {job}=await running();expect(job).toMatchObject({project_id:null,kind,payload:{schemaVersion:1,scope:'global',deviceId:f.device.id,source}});
        await expect(f.service.authorize(f.device,job.id,job.lease)).resolves.toMatchObject({ok:true,projectId:null});
        expect(approval.requireOpenCode).toHaveBeenCalledWith(source);evidence.push({case:'projectless-source',job:job.id,source});
    });
    it.each([['linux-x64','linux-x64-glibc'],['linux-arm64','linux-arm64-glibc'],['linux-x64-musl','linux-x64-musl'],['linux-arm64-musl','linux-arm64-musl']])('authorizes actual bridge package %s against compatible runtime %s',async(target,runtime)=>{
        const selectedSource={...source,target};f.device.report={...f.device.report,runtimeArtifactTarget:runtime,openCodeInstallSupply:selectedSource};
        await f.observer.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[f.device.id,f.device.report]);
        const {job}=await running();expect(job.payload.source).toEqual(selectedSource);
        await expect(f.service.authorize(f.device,job.id,job.lease)).resolves.toMatchObject({ok:true});
        expect(approval.requireOpenCode).toHaveBeenLastCalledWith(selectedSource);
    });
    it('rejects observer installation even with a copied valid capability and source',async()=>{
        await f.observer.query("UPDATE project_members SET role='Наблюдатель' WHERE principal_name=$1",[f.actor.email]);
        await f.observer.query("UPDATE bridge_devices SET role='Наблюдатель' WHERE id=$1",[f.device.id]);
        await expect(f.service.create(f.actor,request())).rejects.toMatchObject({status:403});
        expect((await f.observer.query('SELECT 1 FROM bridge_jobs')).rows).toEqual([]);expect(approval.requireOpenCode).not.toHaveBeenCalled();
    });
    it.each(['capability','source'])('missing %s refuses admission without queue side effects',async missing=>{
        const report={...f.device.report,...(missing==='source'?{openCodeInstallSupply:undefined}:{capabilities:['durable-completions','managed-installations','opencode-cli-v1']})};
        await f.observer.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[f.device.id,report]);
        await expect(f.service.create(actor(),request())).rejects.toMatchObject({status:409});expect((await f.observer.query('SELECT 1 FROM bridge_jobs')).rows).toEqual([]);
    });
    it('canonical supply rejection fails closed; an exact accepted request still replays when OFF',async()=>{
        approval.requireOpenCode.mockRejectedValueOnce(new ConflictException('Unapproved supply'));
        await expect(f.service.create(actor(),request())).rejects.toMatchObject({status:409});
        const input=request(),first=await f.service.create(actor(),input);f.enabled(false);approval.requireOpenCode.mockRejectedValue(new ConflictException('Supply unavailable'));
        await expect(f.service.create(actor(),input)).resolves.toMatchObject({id:first.id});
        expect((await f.observer.query('SELECT 1 FROM bridge_jobs')).rows).toHaveLength(1);
    });
    it('absence of the canonical approval provider refuses a new install even with a valid device report',async()=>{
        const owned=DeviceStore.prototype.owned.bind({pool:f.pool} as DeviceStore);
        const service=new DeviceJobs({pool:f.pool,access:{claims:f.claims},owned} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
        vi.spyOn(service as unknown as {expire():Promise<void>},'expire').mockResolvedValue(undefined);
        await expect(service.create(actor(),request())).rejects.toMatchObject({status:409,response:{code:'computer-setup-supply-unavailable'}});
        expect((await f.observer.query('SELECT 1 FROM bridge_jobs')).rows).toHaveLength(0);
    });
    it('a source change committed after earlier reads fails the final authority snapshot',async()=>{
        const {job}=await running();approval.requireOpenCode.mockImplementationOnce(async()=>{
            await f.observer.query("UPDATE bridge_devices SET report=jsonb_set(report,'{openCodeInstallSupply,sha256}',to_jsonb($2::text)) WHERE id=$1",[f.device.id,'c'.repeat(64)]);
        });
        await expect(f.service.authorize(f.device,job.id,job.lease)).rejects.toMatchObject({status:409});expect((await f.row(job.id)).result).toBeNull();
    });
    it('role revocation during the canonical supply await refuses permission before a local effect',async()=>{
        const {job}=await running();approval.requireOpenCode.mockImplementationOnce(async()=>{await f.observer.query('DELETE FROM project_members WHERE principal_name=$1',[f.actor.email]);});
        await expect(f.service.authorize(f.device,job.id,job.lease)).rejects.toMatchObject({status:403});expect((await f.row(job.id)).result).toBeNull();
    });
    it('same-device bearer rotation during canonical approval fences the old authorize request',async()=>{
        const oldToken='1'.repeat(64),newToken='2'.repeat(64);await f.observer.query('UPDATE bridge_devices SET token_hash=$2 WHERE id=$1',[f.device.id,digest(oldToken)]);
        const {job}=await running();approval.requireOpenCode.mockImplementationOnce(async()=>{await f.observer.query('UPDATE bridge_devices SET token_hash=$2 WHERE id=$1',[f.device.id,digest(newToken)]);});
        await expect(f.service.authorize(f.device,job.id,job.lease,{requestToken:oldToken})).rejects.toMatchObject({status:409});
        await expect(f.service.authorize(f.device,job.id,job.lease,{requestToken:newToken})).resolves.toMatchObject({ok:true});
        expect(JSON.stringify(await f.row(job.id))).not.toContain(oldToken);
    });
    it('same-device bearer rotation after claim reads cannot issue a lease to the old token',async()=>{
        const oldToken='3'.repeat(64),newToken='4'.repeat(64);await f.observer.query('UPDATE bridge_devices SET token_hash=$2 WHERE id=$1',[f.device.id,digest(oldToken)]);
        const queued=await f.service.create(actor(),request());approval.requireOpenCode.mockImplementationOnce(async()=>{await f.observer.query('UPDATE bridge_devices SET token_hash=$2 WHERE id=$1',[f.device.id,digest(newToken)]);});
        await expect(f.service.claim(f.device,oldToken)).resolves.toBeNull();expect(await f.row(String(queued.id))).toMatchObject({state:'failed',result:null});
    });
    it('a copied CLI can succeed without PATH readiness, while altered source completion is rejected',async()=>{
        const {job}=await running();await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job,{source:{...source,sha256:'c'.repeat(64)}}))).rejects.toMatchObject({status:409});
        await completeDeviceJob(f.pool,f.device.id,job.id,completion(job));const row=await f.row(job.id);
        expect(row).toMatchObject({state:'succeeded',result:{status:'installed',commandReady:false,nextAction:'inspect-path'}});expect(row.message).not.toContain('private');
    });
    it('a late publication ACK cannot replace cancellation and OFF still allows cancellation',async()=>{
        const {job}=await running();f.enabled(false);await f.service.cancel(actor(),job.id);
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job))).resolves.toMatchObject({cancelled:true});
        expect(await f.row(job.id)).toMatchObject({state:'cancelled',result:null});
    });
});
