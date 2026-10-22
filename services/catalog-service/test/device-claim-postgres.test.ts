import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {Device,DeviceStore} from '../src/devices/device-store';
import {completionFaultPool,deviceCompletionFixture,ownedDeviceTestAdminUrl} from './device-completion-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const adminUrl=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!adminUrl).sequential('Device claim durability on owned PostgreSQL',()=>{
    let f:Awaited<ReturnType<typeof deviceCompletionFixture>>;
    const evidence:unknown[]=[];
    const device:Device={id:randomUUID(),email:'own@example.test',role:'Разработчик',name:'QA',fingerprint:'fixture',last_seen:null,revoked:false,
        report:{protocolVersion:2,capabilities:['durable-completions','managed-installations']}};
    beforeAll(async()=>{ownedDeviceTestAdminUrl(adminUrl!);f=await deviceCompletionFixture(adminUrl!);});
    beforeEach(async()=>{await f.pool.query('TRUNCATE bridge_devices,bridge_jobs,operations');await f.pool.query('INSERT INTO bridge_devices(id) VALUES($1)',[device.id]);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));});
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{
        if(!f)return;const cleanup=await f.dispose();
        if(process.env.DEVICE_COMPLETION_TEST_RECEIPT)await writeFile(process.env.DEVICE_COMPLETION_TEST_RECEIPT,JSON.stringify({evidence,cleanup},null,2)+'\n',{flag:'wx',mode:0o600});
        expect(cleanup).toMatchObject({dropped:true,originalDatabasesPreserved:true,newDatabasesRemaining:[]});
    });
    function jobs(pool=f.pool){
        const service=new DeviceJobs({pool,access:{claims:async()=>({email:device.email,userRoles:[device.role],projects:[]})}} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
        // Expiry has separate transitions; this fixture exercises the actual claim transaction and journal only.
        vi.spyOn(service as unknown as {expire():Promise<void>},'expire').mockResolvedValue(undefined);return service;
    }
    async function job(){
        const id=randomUUID();await f.pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,kind,state,percent,payload,lease,lease_until)
            VALUES($1,$2,$3,$4,'choose-root','queued',0,'{}',$5,now()+interval '3 minutes')`,[id,device.id,device.email,device.role,randomUUID()]);return id;
    }
    const state=async(id:string)=>(await f.observer.query('SELECT state,lease FROM bridge_jobs WHERE id=$1',[id])).rows[0];
    it.each(['journal-ack','commit-before'] as const)('%s with failed rollback cannot claim a job through a later borrower',async fault=>{
        const id=await job(),before=await state(id),injected=completionFaultPool(f.pool,fault,true),error=await jobs(injected.pool).claim(device).then(()=>null,error=>error);
        let backend;for(let attempt=0;attempt<100;attempt++){backend=(await f.observer.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[injected.pid()])).rows[0];if(backend?.state!=='idle in transaction')break;await new Promise(resolve=>setTimeout(resolve,5));}
        await f.pool.query('BEGIN');await f.pool.query('SELECT 1');await f.pool.query('COMMIT');
        const after=await state(id),journal=(await f.observer.query('SELECT * FROM operations')).rows;
        evidence.push({fault,backend,before,after,journalCount:journal.length,originalErrorPreserved:error===injected.failure,discarded:!!injected.releaseError()});
        expect.soft(error).toBe(injected.failure);expect.soft(backend?.state).not.toBe('idle in transaction');expect.soft(injected.releaseError()).toBeTruthy();
        expect(after).toEqual(before);expect(journal).toEqual([]);
        expect(await jobs().claim(device)).toMatchObject({id,state:'running'});
    });
    it('healthy and lost-COMMIT claims each commit one lease without a second delivery',async()=>{
        const first=await job(),service=jobs();expect(await service.claim(device)).toMatchObject({id:first,state:'running'});expect(await service.claim(device)).toBeNull();
        await f.pool.query('TRUNCATE bridge_jobs,operations');const second=await job(),injected=completionFaultPool(f.pool,'commit-ack',false);
        await expect(jobs(injected.pool).claim(device)).rejects.toBe(injected.failure);
        expect(await state(second)).toMatchObject({state:'running'});expect((await f.observer.query('SELECT * FROM operations')).rows).toHaveLength(1);
        expect(await service.claim(device)).toBeNull();
    });
});
