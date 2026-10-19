// Отказ аудита и гонки очереди запускаются в отдельной базе, не в рабочем каталоге.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const root=path.resolve(new URL('../../',import.meta.url).pathname);const require=createRequire(path.join(root,'services/catalog-service/package.json'));const {Pool}=require('pg');
const originalUrl=process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog';const admin=new Pool({connectionString:originalUrl});
const name='nc_verify_queue_'+randomUUID().replaceAll('-','');const isolated=new URL(originalUrl);isolated.pathname='/'+name;
const actor={email:'qa@example.test',activeRole:'Главный админ'};let catalog;let store;let created=false;let jobService;let project;const results=[];
async function check(name,action){try{await action();results.push({case:name,ok:true});}catch(error){results.push({case:name,ok:false,error:error.message});}}
async function device(){const id=randomUUID();await store.pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,'Тестовый компьютер',$1,$1,$4)",[id,actor.email,actor.activeRole,{protocolVersion:2,capabilities:['durable-completions','managed-installations']}]);return id;}
const create=(deviceId)=>jobService.create(actor,{deviceId,projectId:project.id,kind:'bind-project',folderName:'Тестовая папка',requestKey:randomUUID()});
try{
    await admin.query(`CREATE DATABASE "${name}"`);created=true;process.env.CATALOG_PG_URL=isolated.href;process.env.API_GATEWAY_URL='http://127.0.0.1:9';
    const {CatalogDb}=require(path.join(root,'services/catalog-service/dist/catalog/catalog-db.js'));const {DeviceStore}=require(path.join(root,'services/catalog-service/dist/devices/device-store.js'));const {DeviceJobs}=require(path.join(root,'services/catalog-service/dist/devices/device-jobs.js'));const {recordDeviceOperation}=require(path.join(root,'services/catalog-service/dist/devices/device-operations.js'));
    catalog=new CatalogDb(isolated.href);await catalog.setup();project=await catalog.createProject({name:'Изолированная проверка очереди'});
    store=new DeviceStore({claims:async()=>({email:actor.email,userRoles:[actor.activeRole],projects:[],pluginIds:[],skillPaths:[]})});await store.onModuleInit();jobService=new DeviceJobs(store,{},{});
    const pair=await store.start({name:'Изолированное подключение',fingerprint:randomUUID().replaceAll('-','')});await store.approve(actor,pair.userCode);
    await check('Подтверждённую ссылку читает только её владелец',async()=>{
        assert.equal((await store.pairInfo(pair.userCode,actor)).approved,true);
        await assert.rejects(store.pairInfo(pair.userCode,{email:'other@example.test',activeRole:'Главный админ'}),error=>error.status===409);
    });
    await check('После выдачи ключа ссылка восстанавливает шаг владельца без раскрытия секрета',async()=>{
        await store.poll(pair.deviceCode);const info=await store.pairInfo(pair.userCode,actor);
        assert.equal(info.approved,true);assert.equal('token' in info||'deviceCode' in info,false);
    });
    await check('Старое имя, совпадающее с ID, не меняет адресата чтения, обновления и удаления',async()=>{
        const foreign=await catalog.createProject({name:'Проверка постоянного ID'});const own=await catalog.createProject({name:'Проверка старой коллизии'});
        await store.pool.query('UPDATE projects SET name=$2 WHERE id=$1',[own.id,foreign.id]);
        assert.equal((await catalog.getProject(foreign.id)).id,foreign.id);
        await catalog.updateProject(foreign.id,{retention:8});assert.equal((await catalog.getProject(own.id)).retention,30);
        await catalog.deleteProject(foreign.id);assert.equal((await catalog.getProject(own.id)).id,own.id);
    });
    const id=await device();const pending=await create(id);
    await check('Отказ записи операции откатывает отключение устройства и отмену очереди',async()=>{
        await store.pool.query("CREATE FUNCTION qa_deny_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state IN ('FAILED','CANCELLED') THEN RAISE EXCEPTION 'qa-operation-write-failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_block_terminal BEFORE INSERT OR UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION qa_deny_terminal()");
        try{await assert.rejects(store.revoke(actor,id),/qa-operation-write-failure/);assert.equal((await store.pool.query('SELECT revoked FROM bridge_devices WHERE id=$1',[id])).rows[0].revoked,false);assert.equal((await store.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[pending.id])).rows[0].state,'queued');assert.equal((await store.pool.query("SELECT state FROM operations WHERE operation_id='bridge-'||$1",[pending.id])).rows[0].state,'QUEUED');}
        finally{await store.pool.query('DROP TRIGGER qa_block_terminal ON operations; DROP FUNCTION qa_deny_terminal()');}
    });
    await check('Повтор после отказа фиксирует отзыв и журнал одной транзакцией',async()=>{
        await store.revoke(actor,id);assert.equal((await store.pool.query('SELECT revoked FROM bridge_devices WHERE id=$1',[id])).rows[0].revoked,true);assert.equal((await store.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[pending.id])).rows[0].state,'cancelled');assert.equal((await store.pool.query("SELECT state FROM operations WHERE operation_id='bridge-'||$1",[pending.id])).rows[0].state,'CANCELLED');
    });
    await check('Запоздалая проекция не уменьшает процент и не возобновляет завершённую операцию',async()=>{
        const id=await device();const job=await create(id);const record={id:job.id,project_id:project.id,kind:'bind-project',email:actor.email};
        await recordDeviceOperation(store.pool,record,'RUNNING',73,'Основной прогресс');await recordDeviceOperation(store.pool,record,'RUNNING',20,'Поздний heartbeat');assert.equal((await store.pool.query("SELECT percent FROM operations WHERE operation_id='bridge-'||$1",[job.id])).rows[0].percent,73);
        await recordDeviceOperation(store.pool,record,'SUCCEEDED',100,'Завершено');await recordDeviceOperation(store.pool,record,'RUNNING',90,'Устаревший отчёт');const current=(await store.pool.query("SELECT state,percent FROM operations WHERE operation_id='bridge-'||$1",[job.id])).rows[0];assert.deepEqual(current,{state:'SUCCEEDED',percent:100});
    });
    await check('Пять гонок вставки и отзыва устройства не оставляют активных заданий',async()=>{
        for(let round=0;round<5;round++){
            const id=await device();const outputs=await Promise.allSettled([...Array.from({length:12},()=>create(id)),store.revoke(actor,id)]);
            assert.equal(outputs.at(-1).status,'fulfilled');for(const result of outputs.slice(0,-1)){if(result.status==='rejected'){assert.equal(result.reason.status,403);}}
            assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM bridge_jobs WHERE device_id=$1 AND state IN ('queued','running')",[id])).rows[0].n,0);
        }
    });
}finally{
    if(store){await store.onModuleDestroy();}if(catalog){await catalog.close();}if(created){await admin.query(`DROP DATABASE "${name}"`);}await admin.end();
    const report=process.env.QUEUE_TEST_REPORT||path.join(root,'.run/qa-continue/queue-database.json');await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,JSON.stringify({results,passed:results.filter(row=>row.ok).length,failed:results.filter(row=>!row.ok).length},null,2));
}
console.log(JSON.stringify({passed:results.filter(row=>row.ok).length,failed:results.filter(row=>!row.ok)}));if(results.some(row=>!row.ok)){process.exitCode=1;}
