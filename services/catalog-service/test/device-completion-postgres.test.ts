import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {completeDeviceJob,type DeviceCompletion} from '../src/devices/device-completion';
import {completionFaultPool,deviceCompletionFixture,ownedDeviceTestAdminUrl} from './device-completion-postgres.fixture';

const adminUrl=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!adminUrl).sequential('Device completion durability on owned PostgreSQL',()=>{
    let f:Awaited<ReturnType<typeof deviceCompletionFixture>>;
    const evidence:unknown[]=[];
    beforeAll(async()=>{ownedDeviceTestAdminUrl(adminUrl!);f=await deviceCompletionFixture(adminUrl!);});
    beforeEach(async()=>{await f.pool.query('TRUNCATE bridge_jobs,operations');vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));});
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{
        if(!f)return;
        const cleanup=await f.dispose();
        if(process.env.DEVICE_COMPLETION_TEST_RECEIPT)await writeFile(process.env.DEVICE_COMPLETION_TEST_RECEIPT,JSON.stringify({evidence,cleanup},null,2)+'\n',{flag:'wx',mode:0o600});
        expect(cleanup).toMatchObject({dropped:true,originalDatabasesPreserved:true,newDatabasesRemaining:[]});
    });
    async function job(){
        const id=randomUUID(),lease=randomUUID(),deviceId=randomUUID();
        await f.pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,kind,state,percent,payload,lease,lease_until)
            VALUES($1,$2,'own@example.test','Разработчик','choose-root','running',15,'{}',$3,now()+interval '3 minutes')`,[id,deviceId,lease]);
        const input:DeviceCompletion={lease,state:'succeeded',message:'Готово',result:{root:'/owned-fixture'}};
        return{id,deviceId,input};
    }
    const state=async(id:string)=>(await f.observer.query('SELECT state,result FROM bridge_jobs WHERE id=$1',[id])).rows[0];
    const operations=async(id:string)=>(await f.observer.query('SELECT * FROM operations WHERE operation_id=$1',['bridge-'+id])).rows;
    async function backendState(pid:number){
        for(let attempt=0;attempt<100;attempt++){
            const backend=(await f.observer.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
            if(backend?.state!=='idle in transaction')return backend;
            await new Promise(resolve=>setTimeout(resolve,5));
        }
        return(await f.observer.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
    }
    it('commits one result and journal; exact retry is read-only and a conflicting retry refuses',async()=>{
        const j=await job();expect(await completeDeviceJob(f.pool,j.deviceId,j.id,j.input)).toEqual({ok:true,repeated:false});
        const saved=await state(j.id),journal=await operations(j.id);
        expect(saved).toEqual({state:'succeeded',result:j.input.result});expect(journal).toHaveLength(1);
        expect(await completeDeviceJob(f.pool,j.deviceId,j.id,j.input)).toEqual({ok:true,repeated:true});
        await expect(completeDeviceJob(f.pool,j.deviceId,j.id,{...j.input,result:{root:'/different'}})).rejects.toMatchObject({status:409});
        expect(await state(j.id)).toEqual(saved);expect(await operations(j.id)).toEqual(journal);
    });
    it('concurrent duplicate ACKs commit once and acknowledge the durable result once',async()=>{
        const j=await job(),acks=await Promise.all([completeDeviceJob(f.pool,j.deviceId,j.id,j.input),completeDeviceJob(f.observer,j.deviceId,j.id,j.input)]);
        expect(acks.map(ack=>ack.repeated).sort()).toEqual([false,true]);expect(await operations(j.id)).toHaveLength(1);
    });
    it('a foreign device or stale lease cannot mutate the job or journal',async()=>{
        const j=await job();
        for(const [deviceId,input] of [[randomUUID(),j.input],[j.deviceId,{...j.input,lease:randomUUID()}]] as const)
            await expect(completeDeviceJob(f.pool,deviceId,j.id,input)).rejects.toMatchObject({status:409});
        expect(await state(j.id)).toEqual({state:'running',result:null});expect(await operations(j.id)).toEqual([]);
    });
    it('a real journal constraint failure rolls back the status and retains a healthy reusable session',async()=>{
        const j=await job(),pid=(await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await f.pool.query("ALTER TABLE operations ADD CONSTRAINT own_reject_completion CHECK (state<>'SUCCEEDED')");
        try{await expect(completeDeviceJob(f.pool,j.deviceId,j.id,j.input)).rejects.toMatchObject({code:'23514'});}
        finally{await f.pool.query('ALTER TABLE operations DROP CONSTRAINT own_reject_completion');}
        expect(await state(j.id)).toEqual({state:'running',result:null});expect(await operations(j.id)).toEqual([]);
        expect((await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);
        expect(await completeDeviceJob(f.pool,j.deviceId,j.id,j.input)).toEqual({ok:true,repeated:false});
    });
    it.each(['journal-ack','begin-ack','commit-before'] as const)('%s plus an unconfirmed rollback cannot leak a transaction or commit through the next borrower',async fault=>{
        const j=await job(),injected=completionFaultPool(f.pool,fault,true);
        await expect(completeDeviceJob(injected.pool,j.deviceId,j.id,j.input)).rejects.toBe(injected.failure);
        const backend=await backendState(injected.pid());
        const before=await state(j.id),beforeJournal=await operations(j.id);
        // A new borrower committing its own transaction must never commit an earlier failed request.
        await f.pool.query('BEGIN');await f.pool.query('SELECT 1');await f.pool.query('COMMIT');
        const after=await state(j.id),afterJournal=await operations(j.id);
        evidence.push({fault,backend,before,beforeJournalCount:beforeJournal.length,after,afterJournalCount:afterJournal.length,discarded:!!injected.releaseError()});
        expect.soft(backend?.state).not.toBe('idle in transaction');
        expect.soft(injected.releaseError()).toBeTruthy();
        expect(after).toEqual({state:'running',result:null});expect(afterJournal).toEqual([]);
        expect(await completeDeviceJob(f.pool,j.deviceId,j.id,j.input)).toEqual({ok:true,repeated:false});
    });
    it('lost COMMIT acknowledgement preserves a durable receipt and exact retry does not duplicate the journal',async()=>{
        const j=await job(),injected=completionFaultPool(f.pool,'commit-ack',true);
        await expect(completeDeviceJob(injected.pool,j.deviceId,j.id,j.input)).rejects.toBe(injected.failure);
        const saved=await state(j.id),journal=await operations(j.id);
        expect(saved).toEqual({state:'succeeded',result:j.input.result});expect(journal).toHaveLength(1);
        expect(await completeDeviceJob(f.pool,j.deviceId,j.id,j.input)).toEqual({ok:true,repeated:true});
        expect(await operations(j.id)).toEqual(journal);
    });
});
