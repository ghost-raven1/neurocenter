import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const {ForbiddenException}=require('@nestjs/common');
const dist=process.env.OPERATION_TEST_DIST || fileURLToPath(new URL('../../services/catalog-service/dist/',import.meta.url));
const {CatalogService}=require(path.join(dist,'catalog/catalog.service.js'));
const {CatalogController}=require(path.join(dist,'catalog/catalog.controller.js'));
const {AccessDb}=require(path.join(dist,'access/access-db.js'));
const {AccessController}=require(path.join(dist,'access/access.controller.js'));
const {OperationRepository}=require(path.join(dist,'operations/operation-repository.js'));
const {DeviceStore}=require(path.join(dist,'devices/device-store.js'));
const {DeviceJobs}=require(path.join(dist,'devices/device-jobs.js'));
const {completeDeviceJob}=require(path.join(dist,'devices/device-completion.js'));
const adminUrl=process.env.OPERATION_TEST_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin=new Pool({connectionString:adminUrl,max:2});
const database='nc_operation_scope_test_'+randomBytes(8).toString('hex');
const reportPath=process.env.OPERATION_TEST_REPORT || fileURLToPath(new URL('../../output/gap-audit-20261018/operation-scope-db.json',import.meta.url));
const beforeDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scenarios=[];
const observer='observer@example.test',other='other@example.test',main='main@example.test';
const request=(email=observer,activeRole='Наблюдатель')=>({headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole}))}});
let pool,catalog,access,store,created=false,ownDatabaseDropped=false,fatal;

try {
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;
    process.env.CATALOG_PG_URL=url.href;
    process.env.NODE_ENV='production';process.env.SSO_DISABLE='false';
    process.env.NEUROCENTER_INTERNAL_TOKEN=randomBytes(32).toString('hex');
    // Оповещение не отправляется в рабочий gateway; SQL остаётся настоящим PostgreSQL.
    process.env.API_GATEWAY_URL='http://127.0.0.1:9';
    pool=new Pool({connectionString:url.href,max:4});
    catalog=new CatalogService();await catalog.ensureSchema();
    access=new AccessDb();await access.onModuleInit();
    store=new DeviceStore(access);await store.onModuleInit();
    const controller=new CatalogController(catalog,access),authorization=new AccessController(access);
    const operations=new OperationRepository(pool);
    const jobs=new DeviceJobs(store,{}, {}, {});
    await pool.query(`INSERT INTO projects(id,name) VALUES
        ('prj-own','Свой проект'),('prj-foreign','Чужой проект'),('prj-keep','Сохранённое назначение')`);
    await pool.query(`INSERT INTO platform_users(email,is_main_admin) VALUES ($1,false),($2,false),($3,true)`,[observer,other,main]);
    await pool.query(`INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES
        ('prj-own','own-reader',$1,'Читатель','Наблюдатель'),('prj-keep','keep-reader',$1,'Читатель','Наблюдатель')`,[observer]);
    const createOperation=(projectId,actor,resourceType='bridge')=>operations.create({type:'SYNC',projectId,actor,resourceType,resourceId:randomUUID(),state:'RUNNING',percent:37,message:'Приватный журнал отдельного сценария'});
    const own=await createOperation('prj-own',other);
    const formerlyOwn=await createOperation('prj-own',observer);
    const foreign=await createOperation('prj-foreign',other);
    const personalBridge=await createOperation(null,observer);
    const otherBridge=await createOperation(null,other);
    const platform=await createOperation(null,observer,'tool-build');
    const legacy=await createOperation('Свой проект',other);
    const ids=page=>page.items.map(item=>item.operationId).sort();
    const authorize=async(method,route,req)=>{
        const actor=JSON.parse(decodeURIComponent(req.headers['x-bridge-actor']));
        const decision=await authorization.authorize(process.env.NEUROCENTER_INTERNAL_TOKEN,{...actor,method,path:route});
        if(!decision.allowed) {throw new ForbiddenException('Активная роль не разрешает это действие.');}
    };
    const detail=async(id,req=request())=>{
        await authorize('GET','/api/operations/'+id,req);
        return controller.getOperation(id,req);
    };
    const list=async(query={},req=request())=>{
        await authorize('GET','/api/operations',req);
        return controller.listOperations(query,req);
    };
    const denied=async(promise,status)=>assert.rejects(promise,error=>error.status===status);
    assert.equal((await detail(own.operationId)).operationId,own.operationId);
    assert.equal((await detail(legacy.operationId)).operationId,legacy.operationId);
    scenarios.push('authorize → controller → SQL читает проект по актуальному назначению и историческому имени');
    await denied(detail(foreign.operationId),404);await denied(detail('op-missing'),404);
    scenarios.push('Чужой и неизвестный ID через полную цепочку дают одинаковый 404 без журнала');
    assert.equal((await detail(personalBridge.operationId)).operationId,personalBridge.operationId);
    await denied(detail(otherBridge.operationId),404);await denied(detail(platform.operationId),404);
    scenarios.push('Личный мост без проекта доступен владельцу; чужой мост и собственная платформенная операция закрыты');
    assert.deepEqual(ids(await list()),[own,formerlyOwn,personalBridge,legacy].map(item=>item.operationId).sort());
    assert.equal((await list({projectId:'prj-foreign'})).total,0);
    assert.equal((await list({projectId:'prj-own',state:'RUNNING'})).total,3);
    scenarios.push('Список и projectId/state-фильтры сохраняют ту же область доступа, включая историческое имя');
    await pool.query("DELETE FROM project_members WHERE project_id='prj-own' AND principal_name=$1",[observer]);
    await denied(detail(formerlyOwn.operationId),404);await denied(detail(legacy.operationId),404);
    assert.deepEqual(ids(await list()),[personalBridge.operationId]);
    assert.equal((await list({projectId:'prj-own'})).total,0);
    scenarios.push('Отзыв проекта закрывает собственную и историческую операцию без повторного входа; actor не обходит ACL');
    await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[observer]);
    const mainRequest=request(observer,'Главный админ');
    assert.equal((await detail(platform.operationId,mainRequest)).operationId,platform.operationId);
    assert.equal((await list({},mainRequest)).total,7);
    await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[observer]);
    await denied(detail(platform.operationId,mainRequest),403);
    await denied(detail(platform.operationId),404);
    scenarios.push('Актуальный главный администратор читает платформу; отзыв роли закрывает старую сессию и прежний actor');
    await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[observer]);
    await denied(detail(personalBridge.operationId),403);await denied(list(),403);
    await pool.query('UPDATE platform_users SET enabled=true WHERE email=$1',[observer]);
    scenarios.push('Отключение учётной записи запрещает список и detail до возврата данных');

    const deviceId=randomUUID(),lease=randomUUID(),jobId=randomUUID(),bindingId='b'.repeat(64),manifest='a'.repeat(64);
    const payload={bindingId,assetKind:'mcp',assetId:'test-asset',version:1,
        package:{schemaVersion:4,plugin:{id:'test-asset',kind:'mcp',version:1},manifest:{sha256:manifest}}};
    await pool.query(`INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report)
        VALUES($1,$2,'Наблюдатель','Изолированный компьютер',$3,$4,'{}')`,[deviceId,observer,'a'.repeat(64),randomBytes(32).toString('hex')]);
    await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,percent,lease,lease_until)
        VALUES($1,$2,$3,'Наблюдатель','prj-keep','install',$4,$5,$6,'running',37,$7,now()+interval '3 minutes')`,
    [jobId,deviceId,observer,payload,randomUUID(),'a'.repeat(64),lease]);
    await pool.query(`CREATE TABLE observed_writes(table_name text NOT NULL,row_id text NOT NULL);
        CREATE FUNCTION observe_job_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            INSERT INTO observed_writes VALUES(TG_TABLE_NAME,NEW.id);RETURN NEW;END $$;
        CREATE TRIGGER observe_job_write AFTER UPDATE ON bridge_jobs FOR EACH ROW EXECUTE FUNCTION observe_job_write();`);
    const savedJob=async()=> (await pool.query('SELECT * FROM bridge_jobs WHERE id=$1',[jobId])).rows[0];
    const beforeTerminal=await savedJob();
    for(const kind of ['install','uninstall','sync-rag','inspect-installation']) {
        await pool.query('UPDATE bridge_jobs SET kind=$2 WHERE id=$1',[jobId,kind]);
        const before=await savedJob();
        const writes=(await pool.query('SELECT count(*)::int AS n FROM observed_writes')).rows[0].n;
        for(const state of ['succeeded','failed']) for(const result of [{},{projectId:'prj-keep',assetId:'test-asset',version:1,manifest,bindingId,unchanged:true}]) {
            await denied(jobs.update({id:deviceId},jobId,{lease,state,message:'Произвольный конечный статус',percent:100,result}),400);
        }
        assert.deepEqual(await savedJob(),before);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM observed_writes')).rows[0].n,writes);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations WHERE operation_id=$1',['bridge-'+jobId])).rows[0].n,0);
    }
    scenarios.push('Оба terminal state через progress дают 400 для четырёх видов заданий до UPDATE и операции, даже с квитанцией');
    await pool.query("UPDATE bridge_jobs SET kind='install' WHERE id=$1",[jobId]);
    await jobs.update({id:deviceId},jobId,{lease,state:'running',percent:60,message:'Скачивание'});
    await jobs.update({id:deviceId},jobId,{lease,message:'Проверка SHA'});
    assert.equal((await savedJob()).state,'running');assert.equal((await savedJob()).percent,60);
    assert.equal((await pool.query('SELECT percent FROM operations WHERE operation_id=$1',['bridge-'+jobId])).rows[0].percent,60);
    scenarios.push('Обычный running и heartbeat без state/percent продолжают прогресс и проекцию операции');
    const result={projectId:'prj-keep',assetId:'test-asset',version:1,manifest,bindingId};
    const beforeInvalidCompletion=await savedJob();
    await denied(completeDeviceJob(pool,deviceId,jobId,{lease,state:'failed',message:'Неизвестный исход',result:{}}),409);
    assert.deepEqual(await savedJob(),beforeInvalidCompletion);
    scenarios.push('Completion без исходной квитанции и подтверждённого исхода также не меняет задание');
    for(const outcome of ['unchanged','rolledBack']) {
        await pool.query("UPDATE bridge_jobs SET state='running',result=NULL WHERE id=$1",[jobId]);
        const completion={lease,state:'failed',message:'Подтверждённый отказ',result:{...result,[outcome]:true}};
        assert.deepEqual(await completeDeviceJob(pool,deviceId,jobId,completion),{ok:true,repeated:false});
        const afterFirst=await savedJob();
        assert.deepEqual(await completeDeviceJob(pool,deviceId,jobId,completion),{ok:true,repeated:true});
        assert.deepEqual(await savedJob(),afterFirst);
    }
    scenarios.push('Подтверждённый отказ unchanged и rolledBack проходит completion и идемпотентный повтор');
    await pool.query("UPDATE bridge_jobs SET state='reconciling',lease_until=now()-interval '1 minute',result=NULL WHERE id=$1",[jobId]);
    assert.deepEqual(await completeDeviceJob(pool,deviceId,jobId,{lease,state:'succeeded',message:'Файлы подтверждены',result}),{ok:true,repeated:false});
    assert.equal((await savedJob()).percent,100);
    scenarios.push('Успех через durable completion после истечения lease сохраняет 100 процентов без повторной записи файлов');

    const refusedId=randomUUID();
    await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash)
        VALUES($1,$2,$3,'Наблюдатель','prj-keep','install',$4,$5,$6)`,[refusedId,deviceId,observer,payload,randomUUID(),'a'.repeat(64)]);
    const oldDevice={id:deviceId,email:observer,role:'Наблюдатель',report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','package-v4']}};
    await pool.query(`ALTER TABLE operations ADD CONSTRAINT reject_own_server_failure CHECK(NOT(operation_id='bridge-${refusedId}' AND state='FAILED')) NOT VALID`);
    await assert.rejects(jobs.claim(oldDevice),error=>error.code==='23514');
    assert.equal((await pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[refusedId])).rows[0].state,'running');
    assert.equal((await pool.query('SELECT state FROM operations WHERE operation_id=$1',['bridge-'+refusedId])).rows[0].state,'RUNNING');
    scenarios.push('Отказ аудита серверного pre-delivery rejection откатывает FAILED и сохраняет согласованные RUNNING job/operation');
    await pool.query('ALTER TABLE operations DROP CONSTRAINT reject_own_server_failure');
    await pool.query("UPDATE bridge_jobs SET state='queued',lease=NULL,lease_until=NULL WHERE id=$1",[refusedId]);
    assert.equal(await jobs.claim(oldDevice),null);
    const refused=(await pool.query('SELECT state,result,message FROM bridge_jobs WHERE id=$1',[refusedId])).rows[0];
    assert.equal(refused.state,'failed');assert.equal(refused.result,null);
    assert.equal((await pool.query('SELECT state FROM operations WHERE operation_id=$1',['bridge-'+refusedId])).rows[0].state,'FAILED');
    assert.match(refused.message,/Действие недоступно/);
    scenarios.push('Серверный отказ до выдачи старому мосту завершается атомарно без локальной выдуманной rollback-квитанции');
    assert.equal(beforeTerminal.percent,37);
    console.log(JSON.stringify({ok:true,scenarios:scenarios.length}));
} catch(error) {
    fatal=error.stack||String(error);console.error(fatal);process.exitCode=1;
} finally {
    const cleanups=await Promise.allSettled([store?.onModuleDestroy(),access?.onModuleDestroy(),catalog?.onModuleDestroy(),pool?.end()]);
    const cleanupErrors=cleanups.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
    if(created) {await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);ownDatabaseDropped=true;}
    const afterDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const originalDatabasesPreserved=JSON.stringify(beforeDatabases)===JSON.stringify(afterDatabases);
    await admin.end();await mkdir(path.dirname(reportPath),{recursive:true});
    const ok=!fatal&&!cleanupErrors.length&&ownDatabaseDropped&&originalDatabasesPreserved;
    await writeFile(reportPath,JSON.stringify({ok,scenarios,fatal:fatal||null,cleanupErrors,ownDatabaseDropped,originalDatabasesPreserved,
        beforeDatabaseListSha256:digest(beforeDatabases),afterDatabaseListSha256:digest(afterDatabases),realCatalogRowsCreated:false,
        protocol:'Actual AccessController authorization, CatalogController/Service/repositories, DeviceJobs/completion and PostgreSQL in a private database; not Nest startup or browser authentication'},null,2)+'\n');
    if(!ok)process.exitCode=1;
}
