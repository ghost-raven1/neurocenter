import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const dist=process.env.DEVICE_REQUEST_TEST_DIST||fileURLToPath(new URL('../../services/catalog-service/dist/',import.meta.url));
const {DeviceStore}=require(path.join(dist,'devices/device-store.js'));
const {enqueueDeviceJob}=require(path.join(dist,'devices/device-enqueue.js'));
const {recordDeviceOperation}=require(path.join(dist,'devices/device-operations.js'));
const {OperationRepository}=require(path.join(dist,'operations/operation-repository.js'));
const adminUrl=process.env.DEVICE_REQUEST_TEST_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin=new Pool({connectionString:adminUrl,max:1});
const database='nc_bridge_requests_test_'+randomBytes(8).toString('hex');
const email='owner@example.test',role='Разработчик',projectId='request-project';
const cases=[],backgroundErrors=[];
let created=false,dropped=false,store,secondPool,cleaning=false;
const originalFetch=globalThis.fetch;

try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;
    process.env.CATALOG_PG_URL=url.href;
    // Проверяется только своя БД: уведомление не отправляется работающим сервисам.
    globalThis.fetch=async()=>({ok:true});
    store=new DeviceStore({});await store.onModuleInit();
    const pool=store.pool;
    secondPool=new Pool({connectionString:url.href,max:3});
    for(const current of [pool,secondPool])current.on('error',error=>{if(!cleaning)backgroundErrors.push(error.code||'unknown');});
    await pool.query(`CREATE TABLE projects(id text PRIMARY KEY);
        INSERT INTO projects(id) VALUES('${projectId}');
        CREATE TABLE operations(operation_id text PRIMARY KEY,type text,project_id text,resource_type text,
        resource_id text,actor text,state text,percent integer,started_at timestamptz,finished_at timestamptz,error text,log jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),bytes_done bigint NOT NULL DEFAULT 0,bytes_total bigint NOT NULL DEFAULT 0,retries integer NOT NULL DEFAULT 0)`);
    const device=async(owner=email)=>{
        const id=randomUUID();await pool.query(`INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash)
            VALUES($1,$2,$3,'Изолированная очередь',$4,$5)`,[id,owner,role,'a'.repeat(64),randomBytes(32).toString('hex')]);return id;
    };
    const input=(deviceId,changes={})=>({id:randomUUID(),deviceId,email,role,projectId,kind:'install',requestKey:randomUUID(),requestHash:randomBytes(32).toString('hex'),
        payload:{assetKind:'mcp',assetId:randomUUID(),bindingId:'binding',planId:'plan',planRevision:1,package:{manifest:{sha256:'a'.repeat(64)}}},...changes});
    const enqueue=(incoming,current=pool)=>enqueueDeviceJob(current,'id,device_id AS "deviceId",kind,state',incoming,async()=>({
        email:incoming.email,userRoles:[role],projects:[{projectId,projectName:'Изолированный проект',role}],pluginIds:[],skillPaths:[],
    }));
    const count=async(table,where,params)=>(await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,params)).rows[0].n;
    const check=async(name,action)=>{await action();cases.push({name,passed:true});};

    await check('Потеря ответа после dedup не создаёт повторную job после завершения',async()=>{
        const original=input(await device());await enqueue(original);
        const alias={...original,id:randomUUID(),requestKey:randomUUID(),requestHash:randomBytes(32).toString('hex')};
        assert.equal((await enqueue(alias)).id,original.id);
        await pool.query("UPDATE bridge_jobs SET state='succeeded' WHERE id=$1",[original.id]);
        assert.deepEqual(await enqueue(alias,secondPool),{id:original.id,deviceId:original.deviceId,kind:'install',state:'succeeded'});
        assert.equal(await count('bridge_jobs','device_id=$1',[original.deviceId]),1);
        assert.equal(await count('bridge_job_requests','job_id=$1',[original.id]),2);
        assert.equal(await count('operations','resource_id=$1',[original.id]),1);
        await assert.rejects(enqueue({...alias,requestHash:'f'.repeat(64)}),error=>error.status===409);
    });
    await check('Два SQL pool с одинаковым ключом создают одну job и одну операцию',async()=>{
        const request=input(await device());
        const result=await Promise.all([enqueue(request),enqueue({...request,id:randomUUID()},secondPool)]);
        assert.equal(result[0].id,result[1].id);
        assert.equal(await count('bridge_jobs','device_id=$1',[request.deviceId]),1);
        assert.equal(await count('bridge_job_requests','email=$1 AND request_key=$2',[email,request.requestKey]),1);
        assert.equal(await count('operations','resource_id=$1',[result[0].id]),1);
    });
    await check('Две вкладки с разными ключами сохраняют durable aliases одной job',async()=>{
        const request=input(await device()),other={...request,id:randomUUID(),requestKey:randomUUID(),requestHash:randomBytes(32).toString('hex')};
        const result=await Promise.all([enqueue(request),enqueue(other,secondPool)]);
        assert.equal(result[0].id,result[1].id);
        assert.equal(await count('bridge_jobs','device_id=$1',[request.deviceId]),1);
        assert.equal(await count('bridge_job_requests','job_id=$1',[result[0].id]),2);
        await pool.query("UPDATE bridge_jobs SET state='succeeded' WHERE id=$1",[result[0].id]);
        assert.equal((await enqueue(request,secondPool)).id,result[0].id);
        assert.equal((await enqueue(other)).id,result[0].id);
    });
    await check('Гонка одного ключа на разных устройствах откатывает проигравшие job и audit',async()=>{
        const first=input(await device()),second=input(await device(),{requestKey:first.requestKey});
        const results=await Promise.allSettled([enqueue(first),enqueue(second,secondPool)]);
        const accepted=results.filter(row=>row.status==='fulfilled'),rejected=results.filter(row=>row.status==='rejected');
        assert.equal(accepted.length,1);assert.equal(rejected.length,1);assert.equal(rejected[0].reason.status,409);
        const ids=[first.id,second.id];
        assert.equal(await count('bridge_jobs','id=ANY($1::text[])',[ids]),1);
        assert.equal(await count('operations','resource_id=ANY($1::text[])',[ids]),1);
        assert.equal(await count('bridge_job_requests','email=$1 AND request_key=$2',[email,first.requestKey]),1);
    });
    await check('Alias и новая job на другом устройстве используют единую namespace ключей',async()=>{
        const original=input(await device());await enqueue(original);
        const alias={...original,id:randomUUID(),requestKey:randomUUID(),requestHash:randomBytes(32).toString('hex')};
        const other=input(await device(),{requestKey:alias.requestKey});
        const results=await Promise.allSettled([enqueue(alias),enqueue(other,secondPool)]);
        assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
        assert.equal(results.filter(row=>row.status==='rejected'&&row.reason.status===409).length,1);
        const receipt=(await pool.query('SELECT job_id,request_hash FROM bridge_job_requests WHERE email=$1 AND request_key=$2',[email,alias.requestKey])).rows[0];
        assert.ok([original.id,other.id].includes(receipt.job_id));
        assert.equal(await count('bridge_jobs','id=$1',[other.id]),receipt.job_id===other.id?1:0);
        assert.equal(await count('operations','resource_id=$1',[other.id]),receipt.job_id===other.id?1:0);
    });
    await check('Ошибка receipt откатывает job и допускает успешный повтор того же ключа',async()=>{
        const request=input(await device());
        await pool.query(`ALTER TABLE bridge_job_requests ADD CONSTRAINT reject_fixture_receipt CHECK(request_key<>'${request.requestKey}') NOT VALID`);
        await assert.rejects(enqueue(request),error=>error.code==='23514');
        assert.equal(await count('bridge_jobs','id=$1',[request.id]),0);
        assert.equal(await count('operations','resource_id=$1',[request.id]),0);
        await pool.query('ALTER TABLE bridge_job_requests DROP CONSTRAINT reject_fixture_receipt');
        assert.equal((await enqueue(request)).id,request.id);
    });
    await check('Ошибка audit откатывает receipt и job той же транзакцией',async()=>{
        const request=input(await device());
        await pool.query(`ALTER TABLE operations ADD CONSTRAINT reject_fixture_operation CHECK(resource_id<>'${request.id}') NOT VALID`);
        await assert.rejects(enqueue(request),error=>error.code==='23514');
        assert.equal(await count('bridge_jobs','id=$1',[request.id]),0);
        assert.equal(await count('bridge_job_requests','email=$1 AND request_key=$2',[email,request.requestKey]),0);
        await pool.query('ALTER TABLE operations DROP CONSTRAINT reject_fixture_operation');
    });
    await check('FK запрещает осиротевший alias, удаление job каскадно удаляет все её ключи',async()=>{
        const request=input(await device());await enqueue(request);
        await enqueue({...request,id:randomUUID(),requestKey:randomUUID(),requestHash:'e'.repeat(64)});
        await assert.rejects(pool.query(`INSERT INTO bridge_job_requests(email,request_key,device_id,request_hash,job_id)
            VALUES($1,$2,$3,$4,$5)`,[email,randomUUID(),request.deviceId,'a'.repeat(64),randomUUID()]),error=>error.code==='23503');
        assert.equal(await count('bridge_job_requests','job_id=$1',[request.id]),2);
        await pool.query('DELETE FROM bridge_jobs WHERE id=$1',[request.id]);
        assert.equal(await count('bridge_job_requests','job_id=$1',[request.id]),0);
    });
    await check('Одинаковый requestKey двух аккаунтов принадлежит отдельным личным очередям',async()=>{
        const first=input(await device()),second={...input(await device('another@example.test')),email:'another@example.test',requestKey:first.requestKey};
        const values=await Promise.all([enqueue(first),enqueue(second,secondPool)]);
        assert.notEqual(values[0].id,values[1].id);
        assert.equal(await count('bridge_job_requests','request_key=$1',[first.requestKey]),2);
    });
    const operations=new OperationRepository(pool);
    const projected=async(kind,{jobProject=projectId,operationProject=jobProject,operationEmail=email,exists=true}={})=>{
        const id=randomUUID(),deviceId=await device();
        if(exists)await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state)
            VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8,'failed')`,[id,deviceId,email,role,jobProject,kind,randomUUID(),'a'.repeat(64)]);
        await recordDeviceOperation(pool,{id,kind,email:operationEmail,project_id:operationProject},'FAILED',0,'Изолированная проверка повтора');
        return operations.get('bridge-'+id);
    };
    await check('Detail и список операций используют подтверждённый вид задания и его уровень повтора',async()=>{
        const expected=[];
        for(const [kind,retrySupported,minimumLevel] of [['inspect-installation',true,1],['install',true,2],['bind-project',false,2],
            ['probe-runtime',false,2],['open-rag-ui',false,2],['apply-local-change',false,2],['unknown-kind',false,2]]){
            const operation=await projected(kind);const policy={kind,retrySupported,minimumLevel};
            assert.deepEqual(operation.bridgeJob,policy);expected.push([operation.operationId,policy]);
        }
        const root=await projected('choose-root',{jobProject:null});assert.deepEqual(root.bridgeJob,{kind:'choose-root',retrySupported:true,minimumLevel:2});
        const list=await operations.list(1,100);
        for(const [id,policy]of expected)assert.deepEqual(list.items.find(item=>item.operationId===id)?.bridgeJob,policy);
    });
    await check('Чужой actor, другой проект и отсутствующее задание не получают право повтора',async()=>{
        for(const scope of [{operationEmail:'another@example.test'},{operationProject:'other-project'},{exists:false}]){
            const operation=await projected('inspect-installation',scope);assert.equal(operation.bridgeJob,undefined);
        }
    });
    assert.deepEqual(backgroundErrors,[]);
}finally{
    globalThis.fetch=originalFetch;cleaning=true;
    await secondPool?.end();await store?.onModuleDestroy();
    if(created){await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);dropped=true;}
    await admin.end();
}
const result={checkedAt:new Date().toISOString(),isolatedDatabase:database,ownDatabaseDropped:dropped,cases,passed:cases.length,backgroundErrors};
if(process.env.EVIDENCE_FILE)await writeFile(process.env.EVIDENCE_FILE,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
