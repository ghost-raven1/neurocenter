import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {AccessDb} from '../src/access/access-db';
import {DeviceStore,digest} from '../src/devices/device-store';
import {DeviceJobs} from '../src/devices/device-jobs';
import {enqueueDeviceJob} from '../src/devices/device-enqueue';
import {ownedDeviceTestAdminUrl,completionFaultPool} from './device-completion-postgres.fixture';
import {learningBridgeFingerprint,requireLearningBridgeReceipt,type LearningBridgeInput} from '../../../frontend/src/features/ProjectLearning/learningBridgeIntent';

const connection=process.env.DEVICE_JOB_RECEIPT_TEST_PG_URL;
const owner={email:'receipt-owner@fixture.test',activeRole:'Админ проекта'},foreign={email:'receipt-other@fixture.test',activeRole:'Главный админ'};
const project='receipt-project',anchor='receipt-role-anchor';

/** Production schema, AccessDb, enqueue, receipt reader and browser fingerprint share one caller-owned database. */
describe.skipIf(!connection).sequential('Device request receipt with real PostgreSQL',()=>{
    let admin:Pool,store:DeviceStore,access:AccessDb,jobs:DeviceJobs,database:string,created=false;
    const egress=vi.fn(async()=>new Response('{}',{status:200}));
    const view='id,device_id AS "deviceId",kind,state';
    beforeAll(async()=>{
        const url=ownedDeviceTestAdminUrl(connection!);admin=new Pool({connectionString:url.href,max:1});
        database='nc_receipt_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        vi.stubEnv('CATALOG_PG_URL',url.href);vi.stubEnv('SSO_DISABLE','false');vi.stubGlobal('fetch',egress);
        access=new AccessDb();await access.onModuleInit();store=new DeviceStore(access);await store.onModuleInit();
        jobs=new DeviceJobs(store,{} as never,{} as never,{} as never,{} as never);
        await store.pool.query('INSERT INTO projects(id,name) VALUES($1,$2),($3,$4)',[project,'Receipt fixture',anchor,'Retained role']);
        await store.pool.query('INSERT INTO platform_users(email,is_main_admin) VALUES($1,false),($2,true)',[owner.email,foreign.email]);
        await store.pool.query(`INSERT INTO project_members(project_id,user_id,principal_name,display_name,role)
            VALUES($1,$3,$3,'Owner','Админ проекта'),($2,$3,$3,'Owner','Админ проекта')`,[project,anchor,owner.email]);
    },60000);
    afterAll(async()=>{
        try{await store?.onModuleDestroy();await access?.onModuleDestroy();if(created)await admin.query('DROP DATABASE '+database);}
        finally{await admin?.end();vi.unstubAllGlobals();vi.unstubAllEnvs();}
    });
    const device=async(email=owner.email)=>{
        const id=randomUUID();await store.pool.query(`INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash)
            VALUES($1,$2,$3,'Receipt fixture',$4,$5)`,[id,email,owner.activeRole,'a'.repeat(64),digest(randomUUID())]);return id;
    };
    const input=async(kind:'sync-learning-memory'|'import-learning-quirks'='sync-learning-memory'):Promise<LearningBridgeInput>=>({
        kind,deviceId:await device(),projectId:project,requestKey:randomUUID(),assetId:'fixture-tool',assetKind:'mcp',version:7,
        expectedManifest:'b'.repeat(64),expectedBindingId:'a'.repeat(64),expectedInstanceId:randomUUID(),
        ...(kind==='sync-learning-memory'?{expectedLearningRevision:1,expectedLearningDigest:'c'.repeat(64),memoryMode:'sync' as const}:{expectedConfigurationRevisions:[]}),
    } as LearningBridgeInput);
    const queued=(request:LearningBridgeInput,kind:string=request.kind)=>({id:randomUUID(),deviceId:request.deviceId,email:owner.email,role:owner.activeRole,projectId:project,kind,
        requestKey:request.requestKey,requestHash:digest(JSON.stringify({role:owner.activeRole,request:Object.entries(request).sort(([a],[b])=>a.localeCompare(b))})),
        payload:{assetId:request.assetId,assetKind:request.assetKind,version:request.version,bindingId:request.expectedBindingId,instanceId:request.expectedInstanceId,
            package:{manifest:{sha256:request.expectedManifest}},fixturePrivate:'raw-memory-not-public'}});
    const enqueue=(request:LearningBridgeInput,pool:Pool=store.pool,kind:string=request.kind)=>enqueueDeviceJob(pool,view,queued(request,kind),()=>access.claims(owner.email));
    const snapshot=async()=>Object.fromEntries(await Promise.all(['bridge_jobs','bridge_job_requests','operations'].map(async table=>[
        table,(await store.pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY ${table==='operations'?'operation_id':table==='bridge_job_requests'?'request_key':'id'}),'[]'::jsonb) AS rows FROM ${table} row`)).rows[0].rows,
    ])));

    it('reads the accepted request after a real COMMIT whose acknowledgement was lost',async()=>{
        const request=await input(),fault=completionFaultPool(store.pool,'commit-ack',false);
        await expect(enqueue(request,fault.pool)).rejects.toBe(fault.failure);
        const receipt=await jobs.requestReceipt(owner,request.requestKey);
        expect(receipt.job).toMatchObject({kind:request.kind,state:'queued',deviceId:request.deviceId,version:'7'});
        expect(receipt.requestFingerprint).toBe(await learningBridgeFingerprint(request,owner.activeRole));
        const serialized=JSON.parse(JSON.stringify(receipt));
        expect(requireLearningBridgeReceipt(serialized,{actorRole:owner.activeRole,input:request,requestFingerprint:receipt.requestFingerprint!}).id).toBe(receipt.job.id);
        expect(JSON.stringify(receipt)).not.toContain('raw-memory-not-public');
        for(const key of ['request_hash','request_device_id','request_fingerprint','payload','role','email'])expect(receipt.job).not.toHaveProperty(key);
        const counts=await store.pool.query('SELECT count(*)::int AS n FROM bridge_jobs WHERE device_id=$1',[request.deviceId]);expect(counts.rows[0].n).toBe(1);
    });
    it('reads an install alias fingerprint rather than the original job fingerprint, outside the last 100 terminal jobs',async()=>{
        const request=await input(),first=queued(request,'install');await enqueueDeviceJob(store.pool,view,first,()=>access.claims(owner.email));
        const alias={...first,id:randomUUID(),requestKey:randomUUID(),requestHash:'d'.repeat(64)};
        const duplicate=await enqueueDeviceJob(store.pool,view,alias,()=>access.claims(owner.email));expect(duplicate.id).toBe(first.id);
        await store.pool.query("UPDATE bridge_jobs SET state='succeeded',created_at='2000-01-01' WHERE id=$1",[first.id]);
        await store.pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state)
            SELECT gen_random_uuid()::text,$1,$2,$3,$4,'fixture-terminal','{}',gen_random_uuid()::text,$5,'succeeded' FROM generate_series(1,110)`,
        [first.deviceId,owner.email,owner.activeRole,project,'e'.repeat(64)]);
        const recent=(await store.pool.query("SELECT id FROM bridge_jobs WHERE email=$1 AND state='succeeded' ORDER BY created_at DESC LIMIT 100",[owner.email])).rows;
        expect(recent.some(row=>row.id===first.id)).toBe(false);
        expect(await jobs.requestReceipt(owner,alias.requestKey)).toMatchObject({requestFingerprint:alias.requestHash,job:{id:first.id,state:'succeeded'}});
        expect((await jobs.requestReceipt(owner,request.requestKey)).requestFingerprint).toBe(first.requestHash);
    });
    it('keeps learning snapshots distinct and refuses a changed body under the same key',async()=>{
        const original=await input(),changed={...original,requestKey:randomUUID(),expectedLearningRevision:2,memoryMode:'cleanup'} as LearningBridgeInput;
        const a=await enqueue(original),b=await enqueue(changed);expect(a.id).not.toBe(b.id);
        const first=await jobs.requestReceipt(owner,original.requestKey),second=await jobs.requestReceipt(owner,changed.requestKey);
        expect(first.requestFingerprint).not.toBe(second.requestFingerprint);
        const substituted={...changed,requestKey:original.requestKey};
        await expect(enqueue(substituted)).rejects.toHaveProperty('status',409);
        const wrong={actorRole:owner.activeRole,input:substituted,requestFingerprint:await learningBridgeFingerprint(substituted,owner.activeRole)};
        expect(()=>requireLearningBridgeReceipt(JSON.parse(JSON.stringify(first)),wrong)).toThrow();
        const quirks=await input('import-learning-quirks');await enqueue(quirks);
        const receipt=await jobs.requestReceipt(owner,quirks.requestKey),newConfig={...quirks,expectedConfigurationRevisions:[{assetId:quirks.assetId,manifest:quirks.expectedManifest,revision:'d'.repeat(64)}]};
        const changedFingerprint=await learningBridgeFingerprint(newConfig,owner.activeRole);
        expect(()=>requireLearningBridgeReceipt(JSON.parse(JSON.stringify(receipt)),{actorRole:owner.activeRole,input:newConfig,requestFingerprint:changedFingerprint})).toThrow();
    });
    it('does not let another account or its main administrator read a private request',async()=>{
        const request=await input();await enqueue(request);
        await expect(jobs.requestReceipt(foreign,request.requestKey)).rejects.toHaveProperty('status',404);
        await expect(jobs.requestReceipt(owner,randomUUID())).rejects.toHaveProperty('status',404);
    });
    it('reads allowed history under a current observer role, including a revoked or expired computer',async()=>{
        const request=await input();await enqueue(request);
        await store.pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1 AND principal_name=$2",[project,owner.email]);
        await store.pool.query("UPDATE bridge_devices SET revoked=true,expires_at=now()-interval '1 day' WHERE id=$1",[request.deviceId]);
        try{expect((await jobs.requestReceipt({...owner,activeRole:'Наблюдатель'},request.requestKey)).job.deviceId).toBe(request.deviceId);}
        finally{await store.pool.query("UPDATE project_members SET role='Админ проекта' WHERE project_id=$1 AND principal_name=$2",[project,owner.email]);}
    });
    it('rereads database permissions after project access and then the active role are revoked',async()=>{
        const request=await input();await enqueue(request);
        await store.pool.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2',[project,owner.email]);
        try{
            await expect(jobs.requestReceipt(owner,request.requestKey)).rejects.toHaveProperty('status',404);
            await store.pool.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2',[anchor,owner.email]);
            await expect(jobs.requestReceipt(owner,request.requestKey)).rejects.toHaveProperty('status',403);
        }finally{await store.pool.query(`INSERT INTO project_members(project_id,user_id,principal_name,display_name,role)
            VALUES($1,$3,$3,'Owner','Админ проекта'),($2,$3,$3,'Owner','Админ проекта')`,[project,anchor,owner.email]);}
    });
    it('rejects inconsistent alias, job and device ownership instead of trusting a matching key',async()=>{
        const request=await input();await enqueue(request);const another=await device(foreign.email);
        await store.pool.query('UPDATE bridge_job_requests SET device_id=$1 WHERE email=$2 AND request_key=$3',[another,owner.email,request.requestKey]);
        await expect(jobs.requestReceipt(owner,request.requestKey)).rejects.toHaveProperty('status',404);
        await store.pool.query('UPDATE bridge_job_requests SET device_id=$1 WHERE email=$2 AND request_key=$3',[request.deviceId,owner.email,request.requestKey]);
        await store.pool.query('UPDATE bridge_devices SET email=$1 WHERE id=$2',[foreign.email,request.deviceId]);
        await expect(jobs.requestReceipt(owner,request.requestKey)).rejects.toHaveProperty('status',404);
    });
    it.each(['','invalid'])('reads a legacy alias with %s fingerprint without asserting exact input identity',async hash=>{
        const request=await input();await enqueue(request);
        await store.pool.query('UPDATE bridge_job_requests SET request_hash=$1 WHERE email=$2 AND request_key=$3',[hash,owner.email,request.requestKey]);
        expect((await jobs.requestReceipt(owner,request.requestKey)).requestFingerprint).toBeNull();
    });
    it('is a read-only transaction and preserves cancelled partial results, queue leases and operations',async()=>{
        const request=await input();const job=await enqueue(request);
        const partial={schemaVersion:1,status:'partial',imported:2,skipped:1,remaining:3};
        await store.pool.query("UPDATE bridge_jobs SET state='cancelled',result=$2::jsonb WHERE id=$1",[job.id,JSON.stringify(partial)]);
        const before=await snapshot(),calls=egress.mock.calls.length,client=await store.pool.connect();
        try{
            await client.query('BEGIN READ ONLY');
            const reader=new DeviceJobs({pool:client,access} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
            expect((await reader.requestReceipt(owner,request.requestKey)).job).toMatchObject({id:job.id,state:'cancelled',result:partial});
            await expect(reader.requestReceipt(owner,randomUUID())).rejects.toHaveProperty('status',404);
        }finally{await client.query('ROLLBACK');client.release();}
        expect(await snapshot()).toEqual(before);expect(egress).toHaveBeenCalledTimes(calls);
    });
});
