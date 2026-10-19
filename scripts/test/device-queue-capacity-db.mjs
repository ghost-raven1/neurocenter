import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const dist=process.env.DEVICE_QUEUE_TEST_DIST || fileURLToPath(new URL('../../services/catalog-service/dist/',import.meta.url));
const {CatalogService}=require(path.join(dist,'catalog/catalog.service.js'));
const {AccessDb}=require(path.join(dist,'access/access-db.js'));
const {AccessController}=require(path.join(dist,'access/access.controller.js'));
const {DeviceStore}=require(path.join(dist,'devices/device-store.js'));
const {DeviceJobs}=require(path.join(dist,'devices/device-jobs.js'));
const {DeviceController}=require(path.join(dist,'devices/device.controller.js'));
const {enqueueDeviceJob}=require(path.join(dist,'devices/device-enqueue.js'));
const {REVOKED_QUEUE_MESSAGE}=require(path.join(dist,'devices/device-job-access.js'));
const {ServiceUnavailableException}=require('@nestjs/common');
const adminUrl=process.env.DEVICE_QUEUE_TEST_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin=new Pool({connectionString:adminUrl,max:2});
const database='nc_queue_capacity_test_'+randomBytes(8).toString('hex');
const reportPath=process.env.DEVICE_QUEUE_TEST_REPORT || fileURLToPath(new URL('../../output/continuation-20261018/catalog/queue-capacity.json',import.meta.url));
// Параллельный folder-аудит root имеет только этот собственный префикс БД.
const concurrentPrefix=/^nc_skill_audit_test_[a-f0-9]+$/;
const beforeDatabases=(await admin.query('SELECT oid,datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.filter(row=>!concurrentPrefix.test(row.datname));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let pool,catalog,access,store,created=false,ownDatabaseDropped=false,fatal,cleaning=false;
const backgroundErrors=[];
const scenarios=[];
let observation;

try {
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;
    process.env.CATALOG_PG_URL=url.href;process.env.NODE_ENV='production';process.env.SSO_DISABLE='false';
    process.env.NEUROCENTER_INTERNAL_TOKEN=randomBytes(32).toString('hex');process.env.API_GATEWAY_URL='http://127.0.0.1:9';
    pool=new Pool({connectionString:url.href,max:4});pool.on('error',error=>{if(!cleaning)backgroundErrors.push(error.code||'unknown');});
    catalog=new CatalogService();await catalog.ensureSchema();access=new AccessDb();await access.onModuleInit();
    store=new DeviceStore(access);await store.onModuleInit();
    const jobs=new DeviceJobs(store,{}, {}, {}),controller=new DeviceController(store,jobs,{},{}),authorization=new AccessController(access);
    const email='owner@example.test',deviceId=randomUUID();
    const actor={email,activeRole:'Разработчик'};
    const req={headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN,'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))}};
    await pool.query("INSERT INTO projects(id,name) VALUES('prj-old','Отозванный проект'),('prj-current','Доступный проект'),('prj-read','Чтение')");
    await pool.query('INSERT INTO platform_users(email) VALUES($1)',[email]);
    await pool.query(`INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES
        ('prj-old','old',$1,'Разработчик','Разработчик'),('prj-current','current',$1,'Разработчик','Разработчик'),('prj-read','read',$1,'Читатель','Наблюдатель')`,[email]);
    await pool.query(`INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,last_seen,report)
        VALUES($1,$2,'Разработчик','Offline-компьютер',$3,$4,NULL,$5)`,
    [deviceId,email,'a'.repeat(64),randomBytes(32).toString('hex'),{protocolVersion:2,capabilities:['durable-completions','managed-installations']}]);
    const firstId=randomUUID();
    for(let i=0;i<100;i++)await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash)
        VALUES($1,$2,$3,'Разработчик','prj-old','sync-rag','{}',$4,$5)`,[i===0?firstId:randomUUID(),deviceId,email,randomUUID(),'a'.repeat(64)]);
    const snapshot=async()=>(await pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows;
    const before=await snapshot();
    assert.equal((await controller.listJobs(req)).length,100);
    await pool.query("DELETE FROM project_members WHERE project_id='prj-old' AND principal_name=$1",[email]);
    assert.equal((await authorization.authorize(process.env.NEUROCENTER_INTERNAL_TOKEN,{...actor,method:'GET',path:'/api/device-jobs'})).allowed,true);
    const visible=await controller.listJobs(req);assert.equal(visible.length,0);
    let cancelStatus;
    try{await controller.cancel(req,firstId);}catch(error){cancelStatus=error.status;}
    assert.equal(cancelStatus,404);
    const requestKey=randomUUID();
    const input={deviceId,projectId:'prj-current',kind:'sync-rag',requestKey};
    assert.equal((await authorization.authorize(process.env.NEUROCENTER_INTERNAL_TOKEN,{...actor,method:'POST',path:'/api/device-jobs',body:input})).allowed,true);
    const saved=await controller.create(req,input);
    assert.equal(saved.state,'queued');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bridge_jobs WHERE request_key=$1',[requestKey])).rows[0].n,1);
    const counts=(await pool.query("SELECT count(*)::int AS all_jobs,count(*) FILTER(WHERE state='queued')::int AS queued,count(*) FILTER(WHERE state='cancelled')::int AS cancelled,count(*) FILTER(WHERE state IN ('running','reconciling'))::int AS started FROM bridge_jobs")).rows[0];
    const offline=(await pool.query('SELECT last_seen IS NULL AS offline FROM bridge_devices WHERE id=$1',[deviceId])).rows[0].offline;
    assert.deepEqual(counts,{all_jobs:101,queued:1,cancelled:100,started:0});assert.equal(offline,true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bridge_jobs WHERE device_id=$1 AND state='cancelled' AND message=$2",[deviceId,REVOKED_QUEUE_MESSAGE])).rows[0].n,100);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM operations WHERE state='CANCELLED' AND log->0->>'message'=$1",[REVOKED_QUEUE_MESSAGE])).rows[0].n,100);
    assert.equal(before.length,100);
    observation={offline:true,visibleJobsBeforeEnqueue:visible.length,physicalJobsAfterEnqueue:counts,oldJobCancelStatus:cancelStatus,newRequestCreated:true};
    scenarios.push('Authorize → DeviceController → enqueue освобождает 100 недоступных queued на offline устройстве и создаёт новое действие доступного проекта');
    scenarios.push('Все 100 отмен и их операции получают фиксированную причину отзыва прав; очередь не требует запуска worker или раскрытия старого проекта');

    const makeDevice=async()=>{
        const id=randomUUID();await pool.query(`INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,last_seen,report)
            VALUES($1,$2,'Разработчик','Отдельная очередь',$3,$4,NULL,'{}')`,[id,email,'a'.repeat(64),randomBytes(32).toString('hex')]);return id;
    };
    const addJobs=async(device,n,{projectId='prj-current',state='queued',role='Разработчик'}={})=>{
        const ids=[];for(let i=0;i<n;i++){
            const id=randomUUID();ids.push(id);await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,lease,lease_until)
                VALUES($1,$2,$3,$4,$5,'sync-rag','{}',$6,$7,$8,$9,now()+interval '3 minutes')`,[id,device,email,role,projectId,randomUUID(),'a'.repeat(64),state,randomUUID()]);
        }return ids;
    };
    const deviceRows=async device=>(await pool.query('SELECT * FROM bridge_jobs WHERE device_id=$1 ORDER BY id',[device])).rows;
    const newInput=(device,changes={})=>({id:randomUUID(),deviceId:device,email,role:'Разработчик',projectId:'prj-current',kind:'sync-rag',payload:{},requestKey:randomUUID(),requestHash:randomBytes(32).toString('hex'),...changes});
    const enqueue=(incoming,read=()=>access.claims(email))=>enqueueDeviceJob(pool,'id,state,project_id AS "projectId"',incoming,read);
    const allValid=await makeDevice();await addJobs(allValid,100);
    const validBefore=await deviceRows(allValid);
    await assert.rejects(enqueue(newInput(allValid)),error=>error.status===429);
    assert.deepEqual(await deviceRows(allValid),validBefore);
    scenarios.push('100 по-прежнему разрешённых queued сохраняются и дают честный 429, без отмен ради освобождения места');

    const lowerRole=await makeDevice();await addJobs(lowerRole,99);
    const lowerBefore=await deviceRows(lowerRole);
    const readInput=newInput(lowerRole,{role:'Наблюдатель',kind:'inspect-installation'});
    const readSaved=await enqueue(readInput);
    assert.equal(readSaved.id,readInput.id);
    assert.deepEqual((await deviceRows(lowerRole)).filter(row=>row.id!==readInput.id),lowerBefore);
    scenarios.push('Новое чтение с ролью Наблюдатель сохраняет 99 действующих queued с их сохранённой ролью Разработчик');

    const unavailable=await makeDevice();await addJobs(unavailable,2,{projectId:'prj-old'});
    const unavailableBefore=await deviceRows(unavailable);
    await assert.rejects(enqueue(newInput(unavailable),async()=>{throw new ServiceUnavailableException('Сервис назначений временно недоступен.');}),error=>error.status===503);
    assert.deepEqual(await deviceRows(unavailable),unavailableBefore);
    scenarios.push('503 fresh-проверки назначений откатывает enqueue и не отменяет прежнюю очередь');

    const auditDevice=await makeDevice();const auditOld=await addJobs(auditDevice,2,{projectId:'prj-old'});
    const auditBefore=await deviceRows(auditDevice);const auditInput=newInput(auditDevice);
    await pool.query(`ALTER TABLE operations ADD CONSTRAINT reject_new_enqueue_audit CHECK(operation_id<>'bridge-${auditInput.id}') NOT VALID`);
    await assert.rejects(enqueue(auditInput),error=>error.code==='23514');
    assert.deepEqual(await deviceRows(auditDevice),auditBefore);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations WHERE operation_id=ANY($1::text[])',[[...auditOld,auditInput.id].map(id=>'bridge-'+id)])).rows[0].n,0);
    await pool.query('ALTER TABLE operations DROP CONSTRAINT reject_new_enqueue_audit');
    scenarios.push('Отказ аудита НОВОГО enqueue откатывает все уже выполненные отмены, их операции и новый job одной транзакцией');

    const mixed=await makeDevice();await addJobs(mixed,98,{projectId:'prj-old'});
    const running=await addJobs(mixed,1,{projectId:'prj-old',state:'running'});
    const reconciling=await addJobs(mixed,1,{projectId:'prj-old',state:'reconciling'});
    const started=new Set([...running,...reconciling]);
    const startedBefore=(await deviceRows(mixed)).filter(row=>started.has(row.id));
    await enqueue(newInput(mixed));
    const mixedAfter=await deviceRows(mixed);
    assert.deepEqual(mixedAfter.filter(row=>started.has(row.id)),startedBefore);
    assert.equal(mixedAfter.filter(row=>row.state==='cancelled').length,98);
    scenarios.push('Смешанная очередь освобождает только 98 queued; отозванные running/reconciling сохраняются побайтно по SQL-значениям');

    const startedOnly=await makeDevice();await addJobs(startedOnly,50,{projectId:'prj-old',state:'running'});await addJobs(startedOnly,50,{projectId:'prj-old',state:'reconciling'});
    const startedOnlyBefore=await deviceRows(startedOnly);
    await assert.rejects(enqueue(newInput(startedOnly)),error=>error.status===429);
    assert.deepEqual(await deviceRows(startedOnly),startedOnlyBefore);
    scenarios.push('100 начатых или ожидающих сверки действий продолжают занимать лимит и дают 429 без автоматической отмены');

    await addJobs(lowerRole,1,{projectId:'prj-old'});
    const repeatBefore=await deviceRows(lowerRole);
    const repeated=await enqueue(readInput,async()=>{throw new Error('Повтор не должен запускать fresh cleanup');});
    assert.equal(repeated.id,readSaved.id);assert.deepEqual(await deviceRows(lowerRole),repeatBefore);
    scenarios.push('Повтор того же requestKey возвращает прежний job до reclamation и не меняет стороннюю очередь');
    console.log(JSON.stringify({ok:true,scenarios:scenarios.length}));
}catch(error){fatal=error.stack||String(error);console.error(fatal);process.exitCode=1;}
finally {
    cleaning=true;
    const cleaned=await Promise.allSettled([store?.onModuleDestroy(),access?.onModuleDestroy(),catalog?.onModuleDestroy(),pool?.end()]);
    const cleanupErrors=cleaned.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
    if(created){await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);ownDatabaseDropped=true;}
    const afterDatabases=(await admin.query('SELECT oid,datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const originalNames=new Set(beforeDatabases.map(row=>row.datname));
    const preservedKnown=afterDatabases.filter(row=>originalNames.has(row.datname));
    const knownOriginalDatabasesUnchanged=JSON.stringify(beforeDatabases)===JSON.stringify(preservedKnown);
    const ownDatabaseAbsent=!afterDatabases.some(row=>row.datname===database);await admin.end();
    const evidenceValid=!fatal&&!cleanupErrors.length&&!backgroundErrors.length&&ownDatabaseDropped&&ownDatabaseAbsent&&knownOriginalDatabasesUnchanged;
    await mkdir(path.dirname(reportPath),{recursive:true});
    await writeFile(reportPath,JSON.stringify({ok:evidenceValid,implemented:true,historicalGapReport:'new-gap.json',scenarios,observation,fatal:fatal||null,cleanupErrors,backgroundErrors,ownDatabaseDropped,ownDatabaseAbsent,knownOriginalDatabasesUnchanged,
        baselineKnownDatabaseCount:beforeDatabases.length,beforeKnownDatabaseSha256:digest(beforeDatabases),afterKnownDatabaseSha256:digest(preservedKnown),
        ignoredConcurrentDatabasePrefix:'nc_skill_audit_test_',realCatalogRowsCreated:false,
        protocol:'Initial scenario uses actual AccessController/DeviceController/DeviceJobs; remaining cases exercise actual enqueue repository and controlled permission boundary with PostgreSQL in own database. Offline worker was not started; not browser or Nest startup.'},null,2)+'\n');
    if(!evidenceValid)process.exitCode=1;
}
