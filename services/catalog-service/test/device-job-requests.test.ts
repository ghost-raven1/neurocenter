import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {enqueueDeviceJob} from '../src/devices/device-enqueue';
import {DeviceJobs} from '../src/devices/device-jobs';
import {digest,type DeviceStore} from '../src/devices/device-store';
import {findDeviceJobRequest} from '../src/devices/device-job-requests';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';
import {recordDeviceOperation} from '../src/devices/device-operations';

vi.mock('../src/devices/device-job-access',async importOriginal=>({
    ...await importOriginal<typeof import('../src/devices/device-job-access')>(),
    reclaimUnauthorizedQueuedJobs:vi.fn().mockResolvedValue(false),
}));
vi.mock('../src/devices/device-operations',()=>({recordDeviceOperation:vi.fn(),notifyDeviceOperations:vi.fn()}));

const email='owner@example.test',role='Разработчик';
const actor={email,activeRole:role};
const payload={assetKind:'mcp',assetId:'tool',bindingId:'binding',planId:'plan',planRevision:1,package:{manifest:{sha256:'a'.repeat(64)}}};
const claims={email,userRoles:[role],projects:[{projectId:'project',projectName:'Проект',role}],pluginIds:[],skillPaths:[]};
type StoredJob={id:string;deviceId:string;projectId:string;email:string;role:string;kind:string;state:string;message:string;payload:Record<string,unknown>;requestKey:string;requestHash:string};
type Receipt={email:string;key:string;deviceId:string;hash:string|null;jobId:string};

/** Изолированная очередь сохраняет durable rows и откатывает незавершённую SQL-транзакцию. */
function queue(){
    let jobs:StoredJob[]=[],receipts:Receipt[]=[];
    let snapshot:{jobs:StoredJob[];receipts:Receipt[]}|undefined;
    let receiptError=false;
    const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});
    const publicRow=(job:StoredJob)=>({id:job.id,deviceId:job.deviceId,projectId:job.projectId,kind:job.kind,state:job.state,role:job.role,payload:job.payload});
    const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
        if(sql==='BEGIN'){snapshot=structuredClone({jobs,receipts});return result();}
        if(sql==='ROLLBACK'){if(snapshot)({jobs,receipts}=snapshot);return result();}
        if(sql==='COMMIT'){snapshot=undefined;return result();}
        if(sql.startsWith('SELECT id,role FROM bridge_devices'))return result([{id:params[0],role}]);
        if(sql==='SELECT 1 FROM projects WHERE id=$1')return result([{id:'project'}]);
        if(sql.startsWith('INSERT INTO bridge_job_requests')){
            if(receiptError)throw new Error('receipt unavailable');
            const [owner,key,deviceId,hash,jobId]=params as string[];
            if(!receipts.some(row=>row.email===owner&&row.key===key))receipts.push({email:owner,key,deviceId,hash,jobId});
            return result();
        }
        if(sql.includes('FROM bridge_job_requests')){
            const receipt=receipts.find(row=>row.email===params[0]&&row.key===params[1]);
            const job=jobs.find(row=>row.id===receipt?.jobId);
            return result(job&&receipt?[{...publicRow(job),request_hash:receipt.hash,request_device_id:receipt.deviceId}]:[]);
        }
        if(sql.includes('request_hash FROM bridge_jobs WHERE email=')){
            const job=jobs.find(row=>row.email===params[0]&&row.requestKey===params[1]);
            return result(job?[{...publicRow(job),request_hash:job.requestHash}]:[]);
        }
        if(sql.includes('ORDER BY created_at LIMIT 1 FOR UPDATE')){
            return result(jobs.filter(job=>job.deviceId===params[0]&&job.projectId===params[1]
                &&job.payload.assetKind===params[2]&&job.payload.assetId===params[3]&&['queued','running','reconciling'].includes(job.state)).slice(0,1).map(publicRow));
        }
        if(sql.startsWith('SELECT count(*)'))return result([{count:String(jobs.filter(job=>job.deviceId===params[0]&&['queued','running','reconciling'].includes(job.state)).length)}]);
        if(sql.startsWith('INSERT INTO bridge_jobs')){
            const [id,deviceId,owner,savedRole,projectId,kind,savedPayload,requestKey,requestHash]=params as [string,string,string,string,string,string,Record<string,unknown>,string,string];
            // Существующая БД сохраняет старый DEFAULT, пока INSERT не задаёт сообщение явно.
            const columns=sql.match(/^INSERT INTO bridge_jobs\(([^)]+)\)/)![1].split(',');
            const message=columns.includes('message')?String(params[columns.indexOf('message')]):'Ожидает MCP';
            if(!jobs.some(job=>job.email===owner&&job.requestKey===requestKey))jobs.push({id,deviceId,email:owner,role:savedRole,projectId,kind,payload:savedPayload,requestKey,requestHash,state:'queued',message});
            return result();
        }
        throw new Error('Unexpected query: '+sql);
    });
    const release=vi.fn();
    const pool={query,connect:async()=>({query,release})} as unknown as Pool;
    const incoming=(changes:Record<string,unknown>={})=>({id:'new-job',deviceId:'computer',email,role,projectId:'project',kind:'install',payload,
        requestKey:'22222222-2222-2222-2222-222222222222',requestHash:'b'.repeat(64),...changes});
    const seed=(changes:Partial<StoredJob>={})=>{
        const job:StoredJob={...incoming(),id:'original-job',requestKey:'11111111-1111-1111-1111-111111111111',requestHash:'c'.repeat(64),state:'queued',message:'Ожидает MCP',...changes};
        jobs.push(job);receipts.push({email:job.email,key:job.requestKey,deviceId:job.deviceId,hash:job.requestHash,jobId:job.id});return job;
    };
    const enqueue=(changes:Record<string,unknown>={})=>enqueueDeviceJob(pool,'id,device_id AS "deviceId",kind,state',incoming(changes),async()=>claims);
    return {pool,query,release,incoming,seed,enqueue,get jobs(){return jobs;},get receipts(){return receipts;},failReceipt(){receiptError=true;},allowReceipt(){receiptError=false;}};
}

describe('Ключ запроса хранит связь с объединённым заданием',()=>{
    beforeEach(()=>vi.clearAllMocks());
    afterEach(()=>vi.restoreAllMocks());
    it('Новое задание явно сохраняет «Ожидает моста» в старой БД и истории без дубля при повторе',async()=>{
        const q=queue();
        await q.enqueue();
        const insert=q.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO bridge_jobs'))!;
        const columns=insert[0].match(/^INSERT INTO bridge_jobs\(([^)]+)\)/)![1].split(',');
        expect(columns).toContain('message');
        expect(insert[1]![columns.indexOf('message')]).toBe('Ожидает моста');
        expect(q.jobs[0].message).toBe('Ожидает моста');
        expect(recordDeviceOperation).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:'new-job'}),'QUEUED',0,'Ожидает моста');
        await q.enqueue();
        expect(q.jobs).toHaveLength(1);expect(recordDeviceOperation).toHaveBeenCalledOnce();
    });
    it.each(['install','uninstall','apply-local-change'])('После потери ответа и завершения %s повтор возвращает тот же job',async kind=>{
        const q=queue(),original=q.seed({kind});
        expect(await q.enqueue({kind})).toMatchObject({id:original.id,state:'queued'});
        original.state='succeeded';
        expect(await q.enqueue({kind})).toMatchObject({id:original.id,state:'succeeded'});
        expect(q.jobs).toHaveLength(1);
        expect(q.receipts.find(row=>row.key===q.incoming().requestKey)).toMatchObject({jobId:original.id,hash:q.incoming().requestHash});
        expect(q.release).toHaveBeenCalledTimes(2);
    });
    it.each(['failed','cancelled'])('Один ключ не повторяет уже %s объединённое задание',async state=>{
        const q=queue(),original=q.seed();await q.enqueue();original.state=state;
        expect(await q.enqueue()).toMatchObject({id:original.id,state});expect(q.jobs).toHaveLength(1);
    });
    it.each([{requestHash:'d'.repeat(64)},{deviceId:'other',requestHash:'d'.repeat(64)},{role:'Наблюдатель',requestHash:'d'.repeat(64)}])('Нельзя заменить параметры уже объединённого запроса: %j',async changes=>{
        const q=queue(),original=q.seed();await q.enqueue();original.state='succeeded';
        await expect(q.enqueue(changes)).rejects.toHaveProperty('status',409);
        expect(q.jobs).toHaveLength(1);expect(q.receipts).toHaveLength(2);
    });
    it('Даже совпавший hash не разрешает использовать ключ другого устройства',async()=>{
        const q=queue(),original=q.seed();await q.enqueue();original.state='succeeded';
        await expect(q.enqueue({deviceId:'other'})).rejects.toHaveProperty('status',409);expect(q.jobs).toHaveLength(1);
    });
    it('Ошибка сохранения нового ключа откатывает создание job и допускает безопасный повтор',async()=>{
        const q=queue();q.failReceipt();
        await expect(q.enqueue()).rejects.toThrow('receipt unavailable');expect(q.jobs).toHaveLength(0);
        q.allowReceipt();expect(await q.enqueue()).toMatchObject({id:'new-job'});expect(q.jobs).toHaveLength(1);expect(q.receipts).toHaveLength(1);
    });
    it('Неподтверждённый alias не возвращает успех и не портит исходное задание',async()=>{
        const q=queue();q.seed();q.failReceipt();
        await expect(q.enqueue()).rejects.toThrow('receipt unavailable');expect(q.jobs).toHaveLength(1);expect(q.receipts).toHaveLength(1);
        q.allowReceipt();expect(await q.enqueue()).toMatchObject({id:'original-job'});expect(q.jobs).toHaveLength(1);
    });
    it('Повтор через API читает alias до новой подготовки установки и оставляет проверку текущих прав',async()=>{
        const q=queue();
        const input={deviceId:'computer',projectId:'project',kind:'install',requestKey:q.incoming().requestKey};
        const requestHash=digest(JSON.stringify({role,request:Object.entries(input).sort(([a],[b])=>a.localeCompare(b))}));
        const original=q.seed();await q.enqueue({requestHash});original.state='succeeded';
        const owned=vi.fn().mockResolvedValue({id:'computer',email,role,report:{}}),readClaims=vi.fn().mockResolvedValue(claims);
        const store={pool:q.pool,owned,access:{claims:readClaims}} as unknown as DeviceStore;
        const jobs=new DeviceJobs(store,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans);
        await expect(jobs.create(actor,input)).resolves.toMatchObject({id:original.id,state:'succeeded'});
        expect(owned).toHaveBeenCalledWith(actor,'computer');expect(readClaims).toHaveBeenCalledOnce();
        readClaims.mockResolvedValue({...claims,userRoles:[]});
        await expect(jobs.create(actor,input)).rejects.toHaveProperty('status',403);expect(q.jobs).toHaveLength(1);
    });
    it.each([null,''])('Пустой legacy hash не подменяется hash исходного job: %s',async hash=>{
        const q=queue(),original=q.seed();q.receipts[0].hash=hash;
        await expect(q.enqueue({requestKey:original.requestKey,requestHash:original.requestHash})).rejects.toHaveProperty('status',409);
        expect(q.jobs).toHaveLength(1);
    });
    it('Служебные hash и scope receipt не попадают в публичный ответ',async()=>{
        const q=queue(),original=q.seed();
        await expect(findDeviceJobRequest(q.pool,'id',q.incoming({requestKey:original.requestKey,requestHash:original.requestHash})))
            .resolves.not.toHaveProperty('request_hash');
        const saved=await q.enqueue({requestKey:original.requestKey,requestHash:original.requestHash});
        for(const field of ['request_hash','request_device_id','role','payload'])expect(saved).not.toHaveProperty(field);
    });
});
