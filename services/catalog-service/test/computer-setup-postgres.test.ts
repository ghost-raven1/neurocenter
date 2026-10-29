import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {completeDeviceJob,type DeviceCompletion} from '../src/devices/device-completion';
import {DeviceStore,digest} from '../src/devices/device-store';
import {computerSetupReceiptIdentity} from '../src/devices/computer-setup-jobs';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {completionFaultPool} from './device-completion-postgres.fixture';
import {computerSetupPostgresFixture} from './computer-setup-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const adminUrl=process.env.COMPUTER_SETUP_TEST_PG_URL;

/** No database socket opens without the suite-specific non-default-port owned PostgreSQL URL. */
describe.skipIf(!adminUrl).sequential('User CLI observation through real PostgreSQL authority and durable queue',()=>{
    let f:Awaited<ReturnType<typeof computerSetupPostgresFixture>>;
    const evidence:unknown[]=[];
    beforeAll(async()=>{f=await computerSetupPostgresFixture(adminUrl!);});
    beforeEach(async()=>{vi.clearAllMocks();await f.reset();vi.stubGlobal('fetch',vi.fn(async()=>({ok:true})));});
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{
        vi.restoreAllMocks();if(!f)return;const cleanup=await f.dispose();
        if(process.env.COMPUTER_SETUP_TEST_RECEIPT)await writeFile(process.env.COMPUTER_SETUP_TEST_RECEIPT,JSON.stringify({evidence,cleanup},null,2)+'\n',{flag:'wx',mode:0o600});
        expect(cleanup).toMatchObject({dropped:true,originalDatabasesPreserved:true,newDatabasesRemaining:[]});
    });
    const completion=(lease:string,result:Record<string,unknown>,state:DeviceCompletion['state']='succeeded'):DeviceCompletion=>({lease,state,message:'/private/API_KEY=do-not-publish',result});
    async function running(){const request=f.input(),queued=await f.service.create(f.actor,request),job=await f.service.claim(f.device);expect(job?.id).toBe(queued.id);return {request,job:job!};}
    const emptyQueue=async()=>{for(const table of ['bridge_jobs','bridge_job_requests','operations'])expect((await f.observer.query('SELECT 1 FROM '+table)).rows).toHaveLength(0);};
    const revoke=async(cause:string)=>{
        if(cause==='account')await f.observer.query('UPDATE platform_users SET enabled=false WHERE email=$1',[f.actor.email]);
        else if(cause==='membership')await f.observer.query('DELETE FROM project_members WHERE principal_name=$1',[f.actor.email]);
        else if(cause==='project')await f.observer.query('DELETE FROM projects WHERE id=$1',[f.anchor]);
        else if(cause==='device-role')await f.observer.query("UPDATE bridge_devices SET role='unknown' WHERE id=$1",[f.device.id]);
        else if(cause==='owner')await f.observer.query("UPDATE bridge_devices SET email='other@fixture.test' WHERE id=$1",[f.device.id]);
        else if(cause==='capability')await f.observer.query("UPDATE bridge_devices SET report=jsonb_set(report,'{capabilities}','[]') WHERE id=$1",[f.device.id]);
        else await f.observer.query('UPDATE bridge_devices SET revoked=true WHERE id=$1',[f.device.id]);
    };

    it.each(['Главный админ','Админ проекта','Разработчик','Наблюдатель'])('role %s can observe an owned machine without binding or selected project',async role=>{
        await f.observer.query('UPDATE platform_users SET is_main_admin=$2 WHERE email=$1',[f.actor.email,role==='Главный админ']);
        await f.observer.query('UPDATE project_members SET role=$2 WHERE principal_name=$1',[f.actor.email,role]);
        await f.observer.query('UPDATE bridge_devices SET role=$2 WHERE id=$1',[f.device.id,role]);
        const actor={...f.actor,activeRole:role},device={...f.device,role},queued=await f.service.create(actor,f.input()),job=await f.service.claim(device);
        expect(job?.id).toBe(queued.id);await expect(f.service.authorize(device,job!.id,job!.lease)).resolves.toMatchObject({ok:true,projectId:null});
        await completeDeviceJob(f.pool,device.id,job!.id,completion(job!.lease,f.observation(job!.id)));
        expect(await f.row(job!.id)).toMatchObject({state:'succeeded',project_id:null,result:{status:'installed',version:'1.14.48'}});
        expect((await f.observer.query('SELECT type,actor,project_id FROM operations')).rows).toEqual([{type:'VERIFY',actor:f.actor.email,project_id:null}]);
    });
    it('fresh disabled-account check under enqueue lock rejects an earlier valid claims snapshot',async()=>{
        const original=f.claims.getMockImplementation()!;
        f.claims.mockImplementationOnce(async email=>{const claims=await original(email);await revoke('account');return claims;});
        await expect(f.service.create(f.actor,f.input())).rejects.toMatchObject({status:403});await emptyQueue();
    });
    it.each(['membership','project'])('fresh %s loss under enqueue lock rejects cached browser permission',async cause=>{
        const original=f.claims.getMockImplementation()!;
        f.claims.mockImplementationOnce(async email=>{const claims=await original(email);await revoke(cause);return claims;});
        await expect(f.service.create(f.actor,f.input())).rejects.toMatchObject({status:403});await emptyQueue();
    });
    it.each(['account','membership','project','device-role','owner','capability','revoked'])('claim refuses fresh %s revocation on an already queued job',async cause=>{
        const queued=await f.service.create(f.actor,f.input());await revoke(cause);
        expect(await f.service.claim(f.device)).toBeNull();expect(await f.row(String(queued.id))).toMatchObject({state:'failed',result:null});
    });
    it.each(['account','membership','project','device-role','owner','capability','revoked'])('one final SQL snapshot fences %s committed after earlier authorization reads',async cause=>{
        const {job}=await running(),query=f.pool.query.bind(f.pool);let changed=false;
        const hook=vi.spyOn(f.pool,'query').mockImplementation((async(sql:string,...args:unknown[])=>{
            // Matches old and fixed final CAS queries, reproducing the stale multi-read authority defect.
            if(!changed&&sql.includes('job.lease_until>clock_timestamp()')){changed=true;await revoke(cause);}
            return (query as (...args:unknown[])=>Promise<unknown>)(sql,...args);
        }) as typeof f.pool.query);
        try{await expect(f.service.authorize(f.device,job.id,job.lease)).rejects.toMatchObject({status:['account','membership','project'].includes(cause)?403:409});expect(changed).toBe(true);}
        finally{hook.mockRestore();}
        expect(await f.row(job.id)).toMatchObject({state:'running',result:null});
    });
    it.each(['lease','payload','cancel'] as const)('final authority fences a concurrent %s change',async cause=>{
        const {job}=await running();
        vi.mocked(requireFeaturesEnabled).mockImplementationOnce(async()=>{
            if(cause==='lease')await f.observer.query('UPDATE bridge_jobs SET lease=$2 WHERE id=$1',[job.id,randomUUID()]);
            else if(cause==='payload')await f.observer.query("UPDATE bridge_jobs SET payload=payload||'{\"extra\":true}' WHERE id=$1",[job.id]);
            else await f.service.cancel(f.actor,job.id);
        });
        await expect(f.service.authorize(f.device,job.id,job.lease)).rejects.toMatchObject({status:409});
        expect((await f.row(job.id)).result).toBeNull();
    });
    it.each(['Разработчик','Наблюдатель'])('independent active/device role grants require the current %s membership',async role=>{
        await f.observer.query("INSERT INTO projects(id,name) VALUES('prj-cli-developer','Developer role')");
        await f.observer.query("INSERT INTO project_members(project_id,principal_name,role) VALUES('prj-cli-developer',$1,'Разработчик')",[f.actor.email]);
        const actor={...f.actor,activeRole:'Разработчик'},queued=await f.service.create(actor,f.input()),job=await f.service.claim(f.device);expect(job?.id).toBe(queued.id);
        await f.observer.query('DELETE FROM project_members WHERE principal_name=$1 AND role=$2',[f.actor.email,role]);
        await expect(f.service.authorize(f.device,job!.id,job!.lease)).rejects.toMatchObject({status:403});
        await expect(completeDeviceJob(f.pool,f.device.id,job!.id,completion(job!.lease,f.observation(job!.id)))).rejects.toMatchObject({status:403});
        expect(await f.row(job!.id)).toMatchObject({state:'running',result:null});
    });
    it('OFF rejects new work and claim but preserves exact replay, receipt, global history and cancellation',async()=>{
        const request=f.input();f.enabled(false);await expect(f.service.create(f.actor,request)).rejects.toMatchObject({status:403});await emptyQueue();
        f.enabled(true);const accepted=await f.service.create(f.actor,request);f.enabled(false);
        expect(await f.service.create(f.actor,request)).toMatchObject({id:accepted.id});
        expect(await f.service.requestReceipt(f.actor,request.requestKey)).toMatchObject({job:{id:accepted.id,projectId:null}});
        expect((await f.service.list(f.actor)).map(row=>row.id)).toContain(accepted.id);
        await expect(f.service.cancel(f.actor,String(accepted.id))).resolves.toEqual({ok:true});
        await expect(f.service.cancel(f.actor,String(accepted.id))).resolves.toEqual({ok:true});
        expect(await f.service.create(f.actor,request)).toMatchObject({id:accepted.id,state:'cancelled'});
        f.enabled(true);const next=await f.service.create(f.actor,f.input());f.enabled(false);
        expect(await f.service.claim(f.device)).toBeNull();expect(await f.row(String(next.id))).toMatchObject({state:'failed'});
    });
    it('request keys stay bound to the exact selected owned computer after OFF',async()=>{
        const request=f.input(),accepted=await f.service.create(f.actor,request),other=randomUUID();
        await f.observer.query('INSERT INTO bridge_devices(id,email,role,report) VALUES($1,$2,$3,$4)',[other,f.actor.email,f.actor.activeRole,f.device.report]);f.enabled(false);
        await expect(f.service.create(f.actor,{...request,deviceId:other})).rejects.toMatchObject({status:409});
        expect(await f.service.create(f.actor,request)).toMatchObject({id:accepted.id});
        expect((await f.observer.query('SELECT id FROM bridge_jobs')).rows).toHaveLength(1);
        expect((await f.observer.query('SELECT job_id FROM bridge_job_requests')).rows).toEqual([{job_id:accepted.id}]);
    });
    it.each(['installed','missing','failed','timed-out'])('persists %s with static history and no local process output',async status=>{
        const {job}=await running(),state=['installed','missing'].includes(status)?'succeeded':'failed',result=f.observation(job.id,status);
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,result,state))).resolves.toEqual({ok:true,repeated:false});
        expect(await f.row(job.id)).toMatchObject({state,result});
        const stored=await f.observer.query('SELECT message,result FROM bridge_jobs UNION ALL SELECT error,log FROM operations');
        expect(JSON.stringify(stored.rows)).not.toMatch(/API_KEY|do-not-publish|\/private/);
    });
    it('generic failed {} remains unverified and replays without fabricated observation after OFF/revocation',async()=>{
        const {job}=await running(),input=completion(job.lease,{},'failed');f.enabled(false);
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,input)).resolves.toMatchObject({repeated:false});await revoke('account');
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,input)).resolves.toMatchObject({repeated:true});
        const stored=await f.row(job.id);expect(stored).toMatchObject({state:'failed',result:{}});expect(stored.message).not.toMatch(/API_KEY|найден|готов/);
    });
    it.each(['account','membership','project','device-role','owner','capability','revoked'])('first completion refuses current %s loss, without saving observation or history',async cause=>{
        const {job}=await running();await revoke(cause);
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,f.observation(job.id)))).rejects.toMatchObject({status:cause==='capability'?409:403});
        expect(await f.row(job.id)).toMatchObject({state:'running',result:null});
        expect((await f.observer.query('SELECT state FROM operations')).rows).toEqual([{state:'RUNNING'}]);
    });
    it('lost COMMIT ACK and lease expiry recover the exact receipt OFF without another job or operation',async()=>{
        const {job,request}=await running(),input=completion(job.lease,f.observation(job.id));
        await f.observer.query("UPDATE bridge_jobs SET state='reconciling',lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);f.enabled(false);
        const fault=completionFaultPool(f.pool,'commit-ack',false);
        await expect(completeDeviceJob(fault.pool,f.device.id,job.id,input)).rejects.toBe(fault.failure);await revoke('membership');
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,input)).resolves.toEqual({ok:true,repeated:true});
        expect((await f.observer.query('SELECT id FROM bridge_jobs')).rows).toHaveLength(1);
        expect((await f.observer.query('SELECT job_id FROM bridge_job_requests WHERE request_key=$1',[request.requestKey])).rows).toEqual([{job_id:job.id}]);
        expect((await f.observer.query('SELECT state FROM operations')).rows).toEqual([{state:'SUCCEEDED'}]);
        evidence.push({case:'lost-completion-commit-ack',state:(await f.row(job.id)).state,exactReplayAfterRevocation:true});
    });
    it('active cancellation wins against late ACK and cannot be overwritten by observation',async()=>{
        const {job}=await running();f.enabled(false);await f.service.cancel(f.actor,job.id);await revoke('membership');
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,f.observation(job.id)))).resolves.toEqual({ok:true,repeated:true,cancelled:true});
        expect(await f.row(job.id)).toMatchObject({state:'cancelled',result:null});
        expect((await f.observer.query('SELECT state FROM operations')).rows).toEqual([{state:'CANCELLED'}]);
    });
    it('real receipt identity is terminal-only, current-token and exact device/job/lease bound after revocation',async()=>{
        const {job}=await running(),token='a'.repeat(64);
        await f.observer.query('UPDATE bridge_devices SET token_hash=$2 WHERE id=$1',[f.device.id,digest(token)]);
        expect(await computerSetupReceiptIdentity(f.observer,token,job.id,job.lease)).toBeUndefined();
        await completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,f.observation(job.id)));await revoke('revoked');await revoke('account');
        expect(await computerSetupReceiptIdentity(f.observer,token,job.id,job.lease)).toMatchObject({id:f.device.id,revoked:true});
        for(const [selectedToken,id,lease]of [[token,randomUUID(),job.lease],[token,job.id,randomUUID()],['b'.repeat(64),job.id,job.lease]])
            expect(await computerSetupReceiptIdentity(f.observer,selectedToken,id,lease)).toBeUndefined();
        await f.observer.query('UPDATE bridge_devices SET token_hash=$2 WHERE id=$1',[f.device.id,digest('b'.repeat(64))]);
        expect(await computerSetupReceiptIdentity(f.observer,token,job.id,job.lease)).toBeUndefined();
        await f.observer.query('UPDATE bridge_devices SET token_hash=$2,email=$3 WHERE id=$1',[f.device.id,digest(token),'other@fixture.test']);
        expect(await computerSetupReceiptIdentity(f.observer,token,job.id,job.lease)).toBeUndefined();
        await f.observer.query('UPDATE bridge_devices SET email=$2 WHERE id=$1',[f.device.id,f.actor.email]);
        await f.observer.query('DELETE FROM bridge_jobs WHERE id=$1',[job.id]);
        expect(await computerSetupReceiptIdentity(f.observer,token,job.id,job.lease)).toBeUndefined();
    });
    it('first completion holds the actual membership row until its result and journal commit',async()=>{
        const {job}=await running();let release!:()=>void,reached!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;}),boundary=new Promise<void>(resolve=>{reached=resolve;});
        const wrapper={connect:async()=>{
            const client=await f.pool.connect(),query=client.query.bind(client);
            return {query:async(sql:string,...args:unknown[])=>{
                if(sql.startsWith('UPDATE bridge_jobs SET state=$2')){reached();await gate;}
                return (query as (...args:unknown[])=>Promise<unknown>)(sql,...args);
            },release:client.release.bind(client)};
        }} as unknown as Pool;
        const finish=completeDeviceJob(wrapper,f.device.id,job.id,completion(job.lease,f.observation(job.id)));
        await Promise.race([boundary,finish.then(()=>{throw Error('Expected the first completion boundary before COMMIT.');})]);
        const pid=(await f.observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const removal=f.observer.query('DELETE FROM project_members WHERE principal_name=$1',[f.actor.email]);
        try{
            const deadline=Date.now()+2000;let blocked=false;
            while(Date.now()<deadline){
                blocked=(await f.probe.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
                if(blocked)break;
                await new Promise(resolve=>setTimeout(resolve,10));
            }
            expect(blocked).toBe(true);
        }finally{release();await finish;await removal;}
        expect(await f.row(job.id)).toMatchObject({state:'succeeded',result:{status:'installed'}});
        expect((await f.probe.query('SELECT 1 FROM project_members')).rows).toHaveLength(0);
        evidence.push({case:'completion-membership-revocation-lock',serializedUntilCommit:true});
    });
    it('actual DeviceStore.revoke and CLI completion share device-before-job locks without deadlock',async()=>{
        const {job}=await running();let release!:()=>void,reached!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;}),boundary=new Promise<void>(resolve=>{reached=resolve;});
        const wrapper={connect:async()=>{
            const client=await f.pool.connect(),query=client.query.bind(client);
            return {query:async(sql:string,...args:unknown[])=>{
                const output=await (query as (...args:unknown[])=>Promise<unknown>)(sql,...args);
                if(sql.startsWith('SELECT * FROM bridge_jobs WHERE id=$1')){reached();await gate;}return output;
            },release:client.release.bind(client)};
        }} as unknown as Pool;
        const finish=completeDeviceJob(wrapper,f.device.id,job.id,completion(job.lease,f.observation(job.id)));
        await Promise.race([boundary,finish.then(()=>{throw Error('Expected job lock before completion.');})]);
        const revokeClient=await f.probe.connect(),pid=(await revokeClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const revokeStore={pool:{query:f.probe.query.bind(f.probe),connect:async()=>revokeClient},
            owned:DeviceStore.prototype.owned.bind({pool:f.probe} as DeviceStore)} as unknown as DeviceStore;
        const revocation=DeviceStore.prototype.revoke.call(revokeStore,f.actor,f.device.id);
        try{
            const deadline=Date.now()+2000;let blocked=false;
            while(Date.now()<deadline){
                blocked=(await f.observer.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
                if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
            }
            expect(blocked).toBe(true);
        }finally{release();await Promise.all([finish,revocation]);}
        expect(await f.row(job.id)).toMatchObject({state:'succeeded',result:{status:'installed'}});
        expect((await f.observer.query('SELECT revoked FROM bridge_devices WHERE id=$1',[f.device.id])).rows[0].revoked).toBe(true);
        evidence.push({case:'completion-actual-device-revoke-race',noDeadlock:true,completedBeforeRevocation:true});
    });
    it.each(['device','job','time','status','version','output','empty-success'] as const)('invalid %s receipt rolls back before history mutation',async cause=>{
        const {job}=await running(),result=f.observation(job.id);
        if(cause==='device')result.deviceId=randomUUID();else if(cause==='job')result.jobId=randomUUID();else if(cause==='time')result.checkedAt='yesterday';
        else if(cause==='status')result.status='failed';else if(cause==='version')result.version='1.14.48\nprivate';else if(cause==='output')result.stdout='private';
        await expect(completeDeviceJob(f.pool,f.device.id,job.id,completion(job.lease,cause==='empty-success'?{}:result))).rejects.toMatchObject({status:409});
        expect(await f.row(job.id)).toMatchObject({state:'running',result:null});
    });
});
