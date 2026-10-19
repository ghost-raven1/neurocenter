import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startFlagsFixture} from './feature-flags.fixture.mjs';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const dist=process.env.DEVICE_QUEUE_TEST_DIST || fileURLToPath(new URL('../../services/catalog-service/dist/',import.meta.url));
const {CatalogService}=require(path.join(dist,'catalog/catalog.service.js'));
const {AccessDb}=require(path.join(dist,'access/access-db.js'));
const {AccessController}=require(path.join(dist,'access/access.controller.js'));
const {DeviceStore}=require(path.join(dist,'devices/device-store.js'));
const {DeviceJobs}=require(path.join(dist,'devices/device-jobs.js'));
const {DeviceController}=require(path.join(dist,'devices/device.controller.js'));
const adminUrl=process.env.DEVICE_QUEUE_TEST_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin=new Pool({connectionString:adminUrl,max:2});
const database='nc_device_queue_test_'+randomBytes(8).toString('hex');
const reportPath=process.env.DEVICE_QUEUE_TEST_REPORT || fileURLToPath(new URL('../../output/continuation-20261018/catalog/device-queue-db.json',import.meta.url));
const beforeDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scenarios=[];
const owner='owner@example.test',other='other@example.test';
let pool,catalog,access,store,flags,created=false,ownDatabaseDropped=false,fatal,cleaning=false;
const backgroundErrors=[];

try {
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;
    process.env.CATALOG_PG_URL=url.href;process.env.NODE_ENV='production';process.env.SSO_DISABLE='false';
    process.env.NEUROCENTER_INTERNAL_TOKEN=randomBytes(32).toString('hex');process.env.API_GATEWAY_URL='http://127.0.0.1:9';
    flags=await startFlagsFixture(process.env.NEUROCENTER_INTERNAL_TOKEN);process.env.FEATURE_FLAGS_SERVICE_URL=flags.url;
    pool=new Pool({connectionString:url.href,max:4});
    pool.on('error',error=>{if(!cleaning)backgroundErrors.push(error.code||'unknown');});
    catalog=new CatalogService();await catalog.ensureSchema();
    access=new AccessDb();await access.onModuleInit();
    store=new DeviceStore(access);await store.onModuleInit();
    const jobs=new DeviceJobs(store,{}, {}, {}),controller=new DeviceController(store,jobs,{},{}),authorization=new AccessController(access);
    await pool.query("INSERT INTO projects(id,name) VALUES('prj-keep','Оставшийся проект'),('prj-revoked','Прежний проект')");
    await pool.query('INSERT INTO platform_users(email) VALUES($1),($2)',[owner,other]);
    await pool.query(`INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES
        ('prj-keep','keep',$1,'Владелец','Наблюдатель'),('prj-revoked','old',$1,'Владелец','Наблюдатель')`,[owner]);
    const deviceId=randomUUID(),otherDeviceId=randomUUID();
    for(const [id,email] of [[deviceId,owner],[otherDeviceId,other]])await pool.query(`INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash)
        VALUES($1,$2,'Наблюдатель','Изолированный компьютер',$3,$4)`,[id,email,'a'.repeat(64),randomBytes(32).toString('hex')]);
    const createJob=async({projectId='prj-keep',kind='sync-rag',state='queued',email=owner,age=0}={})=>{
        const id=randomUUID();await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,percent,lease,lease_until,result,created_at)
            VALUES($1,$2,$3,'Наблюдатель',$4,$5,'{}',$6,$7,$8,30,$9,now()+interval '3 minutes',$10,now()-$11*interval '1 second')`,
        [id,email===owner?deviceId:otherDeviceId,email,projectId,kind,randomUUID(),'a'.repeat(64),state,randomUUID(),{fixture:projectId==='prj-revoked'?'private-revoked-result':'safe-fixture'},age]);return id;
    };
    const activeOld=await createJob({projectId:'prj-revoked',state:'running'});
    const queuedOld=await createJob({projectId:'prj-revoked'});
    const ownRoot=await createJob({projectId:null,kind:'choose-root'});
    const invalidNull=await createJob({projectId:null,kind:'install',state:'failed'});
    const foreign=await createJob({email:other});
    const cancelId=await createJob();
    const history=await createJob({state:'failed',age:600});
    for(let i=0;i<105;i++)await createJob({projectId:'prj-revoked',state:'failed',age:60+i});
    const actor={email:owner,activeRole:'Наблюдатель'};
    const request=activeRole=>({headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN,
        'x-bridge-actor':encodeURIComponent(JSON.stringify({...actor,activeRole:activeRole??actor.activeRole}))}});
    const list=async(activeRole)=>{
        const req=request(activeRole),identity=JSON.parse(decodeURIComponent(req.headers['x-bridge-actor']));
        const decision=await authorization.authorize(process.env.NEUROCENTER_INTERNAL_TOKEN,{...identity,method:'GET',path:'/api/device-jobs'});
        assert.equal(decision.allowed,true);return controller.listJobs(req);
    };
    assert.ok((await list()).some(item=>item.id===activeOld));
    await pool.query("DELETE FROM project_members WHERE project_id='prj-revoked' AND principal_name=$1",[owner]);
    const scoped=await list();
    assert.ok(scoped.every(item=>item.projectId!=='prj-revoked'),'Отозванный проект не должен оставаться в личной очереди');
    assert.ok(scoped.some(item=>item.id===history),'Недоступные события не должны вытеснять доступную историю из LIMIT 100');
    assert.ok(scoped.some(item=>item.id===ownRoot));
    assert.ok(!scoped.some(item=>[foreign,invalidNull].includes(item.id)));
    scenarios.push('Полная authorize → DeviceController → SQL цепочка скрывает отозванный проект и применяет scope до LIMIT 100');
    scenarios.push('Личный NULL choose-root остаётся доступным; чужой email и некорректное проектное NULL-задание скрыты');
    await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[owner]);
    const mainJobs=await list('Главный админ');
    assert.ok(mainJobs.some(item=>item.id===activeOld));assert.ok(!mainJobs.some(item=>item.id===foreign));
    await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[owner]);
    await assert.rejects(jobs.list({...actor,activeRole:'Главный админ'}),error=>error.status===403);
    scenarios.push('Действующий Main видит все свои задания, не чужие; отзыв активной роли даёт 403');
    await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[owner]);
    await assert.rejects(jobs.list(actor),error=>error.status===403);
    await pool.query('UPDATE platform_users SET enabled=true WHERE email=$1',[owner]);
    scenarios.push('Отключённая учётная запись не получает историю даже при прямом вызове сервиса');

    await pool.query(`CREATE TABLE observed_cancellations(id text NOT NULL);
        CREATE FUNCTION observe_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            INSERT INTO observed_cancellations VALUES(NEW.id);RETURN NEW;END $$;
        CREATE TRIGGER observe_cancellation AFTER UPDATE ON bridge_jobs FOR EACH ROW EXECUTE FUNCTION observe_cancellation();`);
    const row=async id=>(await pool.query('SELECT * FROM bridge_jobs WHERE id=$1',[id])).rows[0];
    assert.deepEqual(await controller.cancel(request(),cancelId),{ok:true});
    const firstCancel=await row(cancelId);
    assert.equal(firstCancel.state,'cancelled');
    const operation=(await pool.query('SELECT * FROM operations WHERE operation_id=$1',['bridge-'+cancelId])).rows[0];
    const mutations=(await pool.query('SELECT count(*)::int AS n FROM observed_cancellations')).rows[0].n;
    assert.deepEqual(await controller.cancel(request(),cancelId),{ok:true});
    assert.deepEqual(await row(cancelId),firstCancel);
    assert.deepEqual((await pool.query('SELECT * FROM operations WHERE operation_id=$1',['bridge-'+cancelId])).rows[0],operation);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM observed_cancellations')).rows[0].n,mutations);
    scenarios.push('Повтор DELETE после потерянного ACK возвращает успех без повторного UPDATE, журнала и изменения времени');
    for(const id of [queuedOld,foreign,'missing'])await assert.rejects(controller.cancel(request(),id),error=>error.status===404);
    assert.equal((await row(queuedOld)).state,'queued');assert.equal((await row(foreign)).state,'queued');
    scenarios.push('Отмена недоступного проекта, чужого email и неизвестного ID даёт 404 без изменения задания');
    const runningId=await createJob({state:'running'});
    await assert.rejects(controller.cancel(request(),runningId),error=>error.status===409);
    assert.equal((await row(runningId)).state,'running');
    const failedId=await createJob({state:'failed'});
    await assert.rejects(controller.cancel(request(),failedId),error=>error.status===409);
    scenarios.push('Отмена не прерывает running и не подменяет failed новым terminal state');
    await pool.query("DELETE FROM project_members WHERE project_id='prj-keep' AND principal_name=$1",[owner]);
    await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-revoked','remaining',$1,'Владелец','Наблюдатель')",[owner]);
    await assert.rejects(controller.cancel(request(),cancelId),error=>error.status===404);
    await assert.rejects(jobs.cancel({...actor,activeRole:'Главный админ'},ownRoot),error=>error.status===403);
    assert.deepEqual(await jobs.cancel(actor,ownRoot),{ok:true});
    scenarios.push('Идемпотентный повтор не обходит последующий отзыв проекта; NULL choose-root остаётся своим');
    const auditFailure=await createJob({projectId:'prj-revoked'});
    await pool.query(`ALTER TABLE operations ADD CONSTRAINT reject_queue_cancel CHECK(NOT(operation_id='bridge-${auditFailure}' AND state='CANCELLED')) NOT VALID`);
    await assert.rejects(jobs.cancel(actor,auditFailure),error=>error.code==='23514');
    assert.equal((await row(auditFailure)).state,'queued');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations WHERE operation_id=$1',['bridge-'+auditFailure])).rows[0].n,0);
    scenarios.push('Отказ журнала PostgreSQL откатывает первую отмену; неизвестный исход не объявляется идемпотентным успехом');
    console.log(JSON.stringify({ok:true,scenarios:scenarios.length}));
} catch(error) {fatal=error.stack||String(error);console.error(fatal);process.exitCode=1;}
finally {
    cleaning=true;
    const cleaned=await Promise.allSettled([store?.onModuleDestroy(),access?.onModuleDestroy(),catalog?.onModuleDestroy(),pool?.end(),flags?.close()]);
    const cleanupErrors=cleaned.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
    if(created){await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);ownDatabaseDropped=true;}
    const afterDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const originalDatabasesPreserved=JSON.stringify(beforeDatabases)===JSON.stringify(afterDatabases);await admin.end();
    const ok=!fatal&&!cleanupErrors.length&&!backgroundErrors.length&&ownDatabaseDropped&&originalDatabasesPreserved;
    await mkdir(path.dirname(reportPath),{recursive:true});
    await writeFile(reportPath,JSON.stringify({ok,scenarios,fatal:fatal||null,cleanupErrors,backgroundErrors,ownDatabaseDropped,originalDatabasesPreserved,
        beforeDatabaseListSha256:digest(beforeDatabases),afterDatabaseListSha256:digest(afterDatabases),realCatalogRowsCreated:false,
        protocol:'Actual AccessController/DeviceController, DeviceJobs and PostgreSQL in private database; not browser login or a Nest startup'},null,2)+'\n');
    if(!ok)process.exitCode=1;
}
