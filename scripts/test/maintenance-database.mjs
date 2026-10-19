import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMaintenanceStore} from '../production/maintenance.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
require('ts-node').register({project:path.join(root,'services/catalog-service/tsconfig.json'),transpileOnly:true});
const {Pool}=require('pg');
const {MaintenanceService}=require(path.join(root,'services/catalog-service/src/maintenance/maintenance.service.ts'));
const {listAuditHistory}=require(path.join(root,'services/catalog-service/src/catalog/audit-history.ts'));
const administration=new Pool({connectionString:process.env.TEST_ADMIN_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres'});
const database='nc_verify_maintenance_'+randomUUID().replaceAll('-','');
const url=new URL(process.env.TEST_ADMIN_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres');url.pathname='/'+database;
let created=false,pool,service;const cases=[];const check=async(name,action)=>{await action();cases.push({name,passed:true});};
const old=process.env.CATALOG_PG_URL;
try{
    await administration.query('CREATE DATABASE '+database);created=true;
    process.env.CATALOG_PG_URL=url.href;pool=new Pool({connectionString:url.href,max:6});service=new MaintenanceService();await service.onModuleInit();
    const text=async sql=>{const result=await pool.query(sql);return (Array.isArray(result)?result:[result]).flatMap(item=>item.rows).map(row=>Object.values(row).map(value=>value!==null&&typeof value==='object'?JSON.stringify(value):String(value??'')).join('|')).join('\n');};
    const store=createMaintenanceStore(text);const original=await service.get();
    await check('Новая политика выключена и не выдаёт локальную копию за внешнюю',async()=>{assert.equal(original.revision,0);assert.equal(original.policy.enabled,false);assert.equal(original.external,null);assert.equal(original.rpoExceeded,true);});
    await check('Два конкурентных сохранения дают один успех и один конфликт',async()=>{const input={expectedRevision:0,policy:{...original.policy,rpoMinutes:720}};const results=await Promise.allSettled([service.save(input,'one@example.test'),service.save(input,'two@example.test')]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,409);assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE action='maintenance.policy.update'")).rows[0].n,1);});
    await check('Отказ аудита откатывает ревизию и содержимое политики',async()=>{
        await pool.query("CREATE FUNCTION reject_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='maintenance.policy.update' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END$$; CREATE TRIGGER reject_policy BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION reject_policy_audit();");
        await assert.rejects(()=>service.save({expectedRevision:1,policy:{...original.policy,rpoMinutes:15}},'admin@example.test'));
        assert.equal((await service.get()).revision,1);assert.equal((await service.get()).policy.rpoMinutes,720);await pool.query('DROP TRIGGER reject_policy ON security_events; DROP FUNCTION reject_policy_audit();');
    });
    const slot='2026-10-18T02:00@UTC',ids=[randomUUID(),randomUUID()];let winner;
    await check('Настоящий SQL claim атомарно выбирает одного runner',async()=>{const results=await Promise.all(ids.map(runId=>store.claim({runId,slot,revision:1})));assert.equal(results.filter(Boolean).length,1);winner=ids[results.indexOf(true)];assert.equal(await store.claim({runId:randomUUID(),slot:'another',revision:0}),false);});
    const receipt={backupId:'fixture-full',storageId:'independent-fixture',manifestSha256:'a'.repeat(64),createdAt:new Date(Date.now()-60000).toISOString(),verifiedAt:new Date().toISOString(),verification:'sha256-readback',independence:'operator-declared'};
    await check('Внешний успех и audit фиксируются один раз; повтор и чужой ID не создают события',async()=>{await store.finish(winner,receipt);const count=Number((await pool.query('SELECT count(*) AS n FROM security_events')).rows[0].n);await assert.rejects(()=>store.finish(winner,receipt));assert.equal(await store.fail(randomUUID(),'BACKUP_FAILED'),false);assert.equal(Number((await pool.query('SELECT count(*) AS n FROM security_events')).rows[0].n),count);assert.equal(await store.claim({runId:randomUUID(),slot,revision:1}),false);const status=await service.get();assert.equal(status.external.storageId,receipt.storageId);assert.equal(status.rpoExceeded,false);assert.ok(status.externalAgeSeconds>=60);});
    await check('Отказ runner блокирует быстрый повтор и попадает в историю',async()=>{const runId=randomUUID(),next='2026-10-19T02:00@UTC';assert.equal(await store.claim({runId,slot:next,revision:1}),true);assert.equal(await store.fail(runId,'EXTERNAL_FAILED'),true);assert.equal(await store.claim({runId:randomUUID(),slot:next,revision:1}),false);assert.equal(await store.fail(runId,'EXTERNAL_FAILED'),false);});
    await check('Видимая история содержит изменения политики и результаты копий без фиктивной операции',async()=>{
        await pool.query('CREATE TABLE operations(operation_id text,started_at timestamptz,created_at timestamptz,actor text,resource_type text,type text,resource_id text,state text)');
        const history=await listAuditHistory(pool,1,20);assert.equal(history.total,3);const change=history.items.find(item=>item.action==='maintenance.policy.update');assert.equal(change.source,'security');assert.equal(change.correlationId,'');assert.equal(change.details.after.revision,1);assert.equal(history.items.find(item=>item.action==='maintenance.run.failed').outcome,'FAILED');
    });
    const folder=path.join(root,'.run/p0-maintenance');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'maintenance-database.json'),JSON.stringify({checkedAt:new Date().toISOString(),isolatedDatabase:database,passed:cases.length,cases},null,2));console.log(JSON.stringify({passed:cases.length,failed:0,isolatedDatabaseRemoved:true}));
}finally{await service?.onModuleDestroy();await pool?.end();if(created){await administration.query('DROP DATABASE '+database);}await administration.end();if(old===undefined){delete process.env.CATALOG_PG_URL;}else{process.env.CATALOG_PG_URL=old;}}
