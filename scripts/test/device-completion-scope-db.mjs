import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const dist=path.resolve(process.env.DEVICE_QUEUE_TEST_DIST||'services/catalog-service/dist');
const {CatalogService}=require(path.join(dist,'catalog/catalog.service.js'));
const {AccessDb}=require(path.join(dist,'access/access-db.js'));
const {DeviceStore}=require(path.join(dist,'devices/device-store.js'));
const {DeviceController}=require(path.join(dist,'devices/device.controller.js'));
const admin=new Pool({connectionString:process.env.DEVICE_QUEUE_TEST_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres',max:1});
const database='nc_completion_scope_'+randomBytes(8).toString('hex');
const report=path.resolve(process.env.DEVICE_QUEUE_TEST_REPORT||'output/edge-audit-20261019/access-queue/completion-postgres.json');
const scenarios=[],owner='owner@example.test',project='prj-own',token=randomBytes(32).toString('hex'),deviceId=randomUUID();
const sha=value=>createHash('sha256').update(value).digest('hex');
let pool,catalog,access,store,created=false,dropped=false,fatal,cleanupErrors=[];
try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(process.env.DEVICE_QUEUE_TEST_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres');url.pathname='/'+database;
    process.env.CATALOG_PG_URL=url.href;process.env.NODE_ENV='production';process.env.SSO_DISABLE='false';
    process.env.NEUROCENTER_INTERNAL_TOKEN=randomBytes(32).toString('hex');process.env.API_GATEWAY_URL='http://127.0.0.1:9';
    pool=new Pool({connectionString:url.href,max:2});catalog=new CatalogService();await catalog.ensureSchema();
    access=new AccessDb();await access.onModuleInit();store=new DeviceStore(access);await store.onModuleInit();
    await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[project,'Собственный тестовый проект']);
    await pool.query('INSERT INTO platform_users(email) VALUES($1)',[owner]);
    await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'owner',$2,'Владелец','Разработчик')",[project,owner]);
    await pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES($1,$2,'Разработчик','Изолированный MCP',$3,$4)",[deviceId,owner,'a'.repeat(64),sha(token)]);
    const controller=new DeviceController(store,{}, {}, {});
    const request={headers:{authorization:'Bearer '+token,'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN}};
    const make=async(kind,state='running',expired=false)=>{
        const id=randomUUID(),lease=randomUUID();await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,lease,lease_until,percent)
            VALUES($1,$2,$3,'Разработчик',$4,$5,'{}',$6,$7,$8,$9,now()+$10*interval '1 minute',35)`,
        [id,deviceId,owner,kind==='choose-root'?null:project,kind,randomUUID(),'a'.repeat(64),state,lease,expired?-5:3]);return {id,lease};
    };
    const row=async id=>(await pool.query('SELECT * FROM bridge_jobs WHERE id=$1',[id])).rows[0];
    const operation=async id=>(await pool.query('SELECT * FROM operations WHERE operation_id=$1',['bridge-'+id])).rows[0];
    const ack=(job,result,state='succeeded')=>controller.complete(request,job.id,{lease:job.lease,state,message:'Готово',result});
    for(const kind of ['sync-rag','restore-rag']){
        const job=await make(kind),before=await row(job.id);
        for(const result of [{},{projectId:'prj-foreign',ok:true},{projectId:project,ok:false}])await assert.rejects(ack(job,result),error=>error.status===409);
        assert.deepEqual(await row(job.id),before);assert.equal(await operation(job.id),undefined);
        scenarios.push(`${kind}: свежая аренда не принимает пустой/чужой/ok=false результат; строка и журнал сохранены`);
        assert.deepEqual(await ack(job,{projectId:project,ok:true}),{ok:true,repeated:false});
        const saved=await row(job.id),event=await operation(job.id);assert.equal(saved.state,'succeeded');assert.equal(event.state,'SUCCEEDED');
        assert.deepEqual(await ack(job,{projectId:project,ok:true}),{ok:true,repeated:true});assert.deepEqual(await row(job.id),saved);assert.deepEqual(await operation(job.id),event);
        scenarios.push(`${kind}: правильный ACK и повтор после потери ответа не меняют время или журнал`);
    }
    const root=await make('choose-root');for(const result of [{},{root:''},{root:123}])await assert.rejects(ack(root,result),error=>error.status===409);
    assert.equal((await row(root.id)).state,'running');assert.deepEqual(await ack(root,{root:'/own-fixture'}),{ok:true,repeated:false});
    scenarios.push('choose-root: пустая папка не даёт ложного успеха; правильный результат принимается');
    const expired=await make('restore-rag','reconciling',true);await assert.rejects(ack(expired,{projectId:'prj-foreign',ok:true}),error=>error.status===409);
    assert.deepEqual(await ack(expired,{projectId:project,ok:true}),{ok:true,repeated:false});
    scenarios.push('Истёкшая аренда сверяет исходный проект и сохраняет подтверждённый результат без повтора');
    const legacy=await make('bind-project');await assert.rejects(ack(legacy,{projectId:'prj-foreign'}),error=>error.status===409);
    assert.deepEqual(await ack(legacy,{projectId:project}),{ok:true,repeated:false});
    scenarios.push('Старое bind-project без mode также проверяет исходный проект при свежей аренде');
    const failed=await make('sync-rag');assert.deepEqual(await ack(failed,{},'failed'),{ok:true,repeated:false});assert.equal((await row(failed.id)).state,'failed');
    scenarios.push('Ошибка до выполнения по-прежнему принимает пустую безопасную квитанцию');
    const rollback=await make('sync-rag');
    await pool.query(`ALTER TABLE operations ADD CONSTRAINT reject_completion_scope CHECK(operation_id<>'bridge-${rollback.id}') NOT VALID`);
    await assert.rejects(ack(rollback,{projectId:project,ok:true}),error=>error.code==='23514');assert.equal((await row(rollback.id)).state,'running');assert.equal(await operation(rollback.id),undefined);
    await pool.query('ALTER TABLE operations DROP CONSTRAINT reject_completion_scope');assert.deepEqual(await ack(rollback,{projectId:project,ok:true}),{ok:true,repeated:false});
    scenarios.push('Отказ журнала откатывает финальный статус; повтор после устранения отказа безопасен');
}catch(error){fatal=error.stack||String(error);process.exitCode=1;}
finally{
    const closed=await Promise.allSettled([store?.onModuleDestroy(),access?.onModuleDestroy(),catalog?.onModuleDestroy(),pool?.end()]);
    cleanupErrors=closed.flatMap(value=>value.status==='rejected'?[String(value.reason)]:[]);
    if(created){try{await admin.query(`DROP DATABASE "${database}"`);dropped=true;}catch(error){cleanupErrors.push(String(error));}}
    await admin.end();await mkdir(path.dirname(report),{recursive:true});
    const ok=!fatal&&!cleanupErrors.length&&dropped;await writeFile(report,JSON.stringify({ok,scenarios,fatal:fatal||null,cleanupErrors,ownDatabaseDropped:dropped,
        workingDataMutated:false,protocol:'Actual DeviceController → DeviceStore.identity/AccessDb → completeDeviceJob → PostgreSQL, own database; not a Nest HTTP startup or local file mutation.'},null,2)+'\n');
    console.log(JSON.stringify({ok,scenarios:scenarios.length,ownDatabaseDropped:dropped}));if(!ok)process.exitCode=1;
}
