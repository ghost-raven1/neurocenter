import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.PROJECT_RETENTION_TEST_PG_URL||process.env.PUBLICATION_TEST_PG_URL).href;

// Все проекты, триггеры и HTTP-записи создаются только в собственной временной БД.
const workspace=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const {Module}=require('@nestjs/common');
const {NestFactory}=require('@nestjs/core');
const dist=path.resolve(process.env.PROJECT_RETENTION_TEST_DIST||path.join(workspace,'services/catalog-service/.retention-audit-dist'));
const reportPath=process.env.PROJECT_RETENTION_TEST_REPORT||path.join(workspace,'output/retention-audit-20261019/integration/postgres.json');
const adminUrl=adminConnection;
const database='nc_project_retention_test_'+randomBytes(8).toString('hex');
const admin=new Pool({connectionString:adminUrl,max:2});
const originalEnv=new Map(['NODE_ENV','CATALOG_PG_URL','SSO_DISABLE','PROJECTS_ROOT','RAG_SERVICE_URL','API_GATEWAY_URL','NEUROCENTER_INTERNAL_TOKEN'].map(key=>[key,process.env[key]]));
const internalToken=randomBytes(24).toString('hex'),actor='Retention-QA@Example.Test',normalizedActor=actor.toLowerCase();
const own={id:'prj-retention-own',name:'Свой проект хранения'},foreign={id:'prj-retention-foreign',name:'Другой проект'};
const checks=[];
let created=false,ownDatabaseDropped=false,app,pool,endpoint,fatal,beforeDatabases=[],auditApiExample;
const databases=async()=>(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map(item=>item.datname);
const check=async(name,run)=>{try{await reset();await run();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});}};
const rows=async()=>(await pool.query('SELECT id,name,state,retention,quota,fs_root_path,updated_at FROM projects ORDER BY id')).rows;
const audit=async()=>(await pool.query("SELECT * FROM security_events WHERE action='project.settings.update' ORDER BY created_at,event_id")).rows;
const reset=async()=>{
    await pool.query("UPDATE projects SET retention=30,state='ACTIVE',quota=NULL,fs_root_path=NULL,updated_at='2026-01-01T00:00:00Z'");
    await pool.query("DELETE FROM security_events WHERE action='project.settings.update'");
};
const send=async(route,body,options={})=>{
    const response=await fetch(endpoint+route,{
        method:'PATCH',headers:{'content-type':'application/json','x-neurocenter-internal':internalToken,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actor,activeRole:'Главный админ'}))},
        ...(options.omitBody?{}:{body:options.rawBody??JSON.stringify(body)}),signal:AbortSignal.timeout(8000),
    });
    const text=await response.text();let result;try{result=JSON.parse(text);}catch{result=text;}
    return {status:response.status,body:result};
};
const request=(id,body,options)=>send('/api/projects/'+encodeURIComponent(id)+'/retention',body,options);
const assertUnchanged=async(before,beforeAudit)=>{assert.deepEqual(await rows(),before);assert.deepEqual(await audit(),beforeAudit);};
const readRetention=async id=>{
    const response=await fetch(endpoint+'/api/projects/'+encodeURIComponent(id),{headers:{'x-neurocenter-internal':internalToken,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actor,activeRole:'Главный админ'}))},signal:AbortSignal.timeout(8000)});
    assert.equal(response.status,200);return (await response.json()).retention;
};
const assertSaved=async(value,before)=>{
    const after=await rows();assert.equal(after.find(row=>row.id===own.id).retention,value);
    assert.deepEqual(after.find(row=>row.id===foreign.id),before.find(row=>row.id===foreign.id));
    assert.equal(await readRetention(own.id),value);assert.equal(await readRetention(own.name),value);
};
const settings=(retention=30,extra={})=>({projectId:own.id,retention,state:'ACTIVE',quotas:null,fsRootPath:null,...extra});
const assertAudit=async(value,afterExtra={})=>{
    const events=await audit();assert.equal(events.length,1);
    const event=events[0];assert.equal(event.action,'project.settings.update');assert.equal(event.resource_id,own.id);assert.equal(event.actor,normalizedActor);
    assert.deepEqual(event.before_state,settings());assert.deepEqual(event.after_state,settings(value,afterExtra));
    const response=await fetch(endpoint+'/api/audit?page=1&size=100',{headers:{'x-neurocenter-internal':internalToken},signal:AbortSignal.timeout(8000)});
    assert.equal(response.status,200);
    const row=(await response.json()).items.find(item=>item.id==='security:'+event.event_id);
    assert.ok(row);assert.equal(row.action,event.action);assert.equal(row.actor,normalizedActor);
    assert.equal(row.resourceType,'project');assert.equal(row.resourceId,own.id);assert.equal(row.outcome,'SUCCEEDED');
    assert.equal(row.source,'security');assert.equal(row.details,null);assert.equal(row.correlationId,'');auditApiExample=row;
};

try{
    beforeDatabases=await databases();await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const ownUrl=new URL(adminUrl);ownUrl.pathname='/'+database;pool=new Pool({connectionString:ownUrl.href,max:2});
    Object.assign(process.env,{NODE_ENV:'production',CATALOG_PG_URL:ownUrl.href,SSO_DISABLE:'false',PROJECTS_ROOT:'',RAG_SERVICE_URL:'',API_GATEWAY_URL:'http://127.0.0.1:9',NEUROCENTER_INTERNAL_TOKEN:internalToken});
    const {CatalogService}=require(path.join(dist,'catalog/catalog.service.js'));
    const {CatalogController}=require(path.join(dist,'catalog/catalog.controller.js'));
    const {AccessDb}=require(path.join(dist,'access/access-db.js'));
    class ProjectRetentionFixtureModule{}
    Module({controllers:[CatalogController],providers:[CatalogService,AccessDb]})(ProjectRetentionFixtureModule);
    app=await NestFactory.create(ProjectRetentionFixtureModule,{logger:false});
    app.use((req,res,next)=>{if(req.headers['x-neurocenter-internal']!==internalToken){res.status(403).json({message:'Только изолированный fixture'});return;}next();});
    await app.listen(0,'127.0.0.1');endpoint=await app.getUrl();
    await app.get(AccessDb).save({email:actor,isMainAdmin:true});
    await pool.query('INSERT INTO projects(id,name,retention) VALUES($1,$2,30),($3,$4,30)',[own.id,own.name,foreign.id,foreign.name]);

    for(const [id,value] of [[own.id,42],[own.name,73],[own.id,1],[own.id,100]])await check('PATCH сохраняет срок '+value+' только своего проекта по '+(id===own.id?'ID':'имени'),async()=>{
        const before=await rows(),result=await request(id,{retention:value});assert.equal(result.status,200);assert.deepEqual(result.body,{retention:value});
        await assertSaved(value,before);await assertAudit(value);
    });
    await check('Несуществующий проект возвращает 404 без изменения других проектов и аудита',async()=>{
        const before=await rows(),beforeAudit=await audit(),result=await request('prj-missing',{retention:42});
        assert.equal(result.status,404);await assertUnchanged(before,beforeAudit);
    });
    const invalid=[
        ['пропущено поле',{}],['null значение',{retention:null}],['ноль',{retention:0}],['отрицательное',{retention:-1}],
        ['больше максимума',{retention:101}],['дробное',{retention:1.5}],['строка',{retention:'42'}],['массив значения',{retention:[]}],
        ['объект значения',{retention:{}}],['boolean значения',{retention:true}],['массив тела',[]],['null тело',null],
        ['строковое тело','bad'],['числовое тело',42],['лишние поля',{retention:42,state:'ARCHIVED'}],
    ];
    for(const [name,body] of invalid)await check('Некорректный retention: '+name+' → 400 без записи',async()=>{
        const before=await rows(),beforeAudit=await audit(),result=await request(own.id,body);
        assert.equal(result.status,400);await assertUnchanged(before,beforeAudit);
    });
    await check('Пустое тело возвращает 400 без записи',async()=>{
        const before=await rows(),beforeAudit=await audit(),result=await request(own.id,undefined,{omitBody:true});
        assert.equal(result.status,400);await assertUnchanged(before,beforeAudit);
    });
    await check('Повтор сохранённого значения не меняет updated_at и не дублирует аудит',async()=>{
        const first=await request(own.id,{retention:42});assert.equal(first.status,200);
        const before=await rows(),beforeAudit=await audit();assert.equal(beforeAudit.length,1);
        const second=await request(own.name,{retention:42});assert.equal(second.status,200);assert.deepEqual(second.body,{retention:42});
        await assertUnchanged(before,beforeAudit);
    });
    await check('Параллельный одинаковый повтор по ID/имени создаёт одно изменение и одно событие',async()=>{
        const before=await rows();const results=await Promise.all([request(own.id,{retention:42}),request(own.name,{retention:42})]);
        for(const result of results){assert.equal(result.status,200);assert.deepEqual(result.body,{retention:42});}
        await assertSaved(42,before);await assertAudit(42);
    });
    await check('Отказ INSERT аудита откатывает сохранение срока и допускает здоровый повтор',async()=>{
        const before=await rows(),beforeAudit=await audit();
        await pool.query(`CREATE FUNCTION fail_retention_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OWN_AUDIT_FAILURE'; END $$;
            CREATE TRIGGER fail_retention_audit BEFORE INSERT ON security_events FOR EACH ROW WHEN (NEW.action='project.settings.update') EXECUTE FUNCTION fail_retention_audit();`);
        try {const result=await request(own.id,{retention:42});assert.ok(result.status>=500);await assertUnchanged(before,beforeAudit);}
        finally {await pool.query('DROP TRIGGER fail_retention_audit ON security_events; DROP FUNCTION fail_retention_audit()');}
        assert.equal((await request(own.id,{retention:42})).status,200);await assertSaved(42,before);await assertAudit(42);
    });
    await check('Отказ UPDATE проекта не создаёт аудит и допускает здоровый повтор',async()=>{
        const before=await rows(),beforeAudit=await audit();
        await pool.query(`CREATE FUNCTION fail_retention_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OWN_UPDATE_FAILURE'; END $$;
            CREATE TRIGGER fail_retention_update BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION fail_retention_update();`);
        try {const result=await request(own.id,{retention:42});assert.ok(result.status>=500);await assertUnchanged(before,beforeAudit);}
        finally {await pool.query('DROP TRIGGER fail_retention_update ON projects; DROP FUNCTION fail_retention_update()');}
        assert.equal((await request(own.id,{retention:42})).status,200);await assertSaved(42,before);await assertAudit(42);
    });
    for(const [label,suffix,payload,value,extra] of [
        ['Общий PATCH','',{state:'ARCHIVED',retention:60,quotas:{currentBytesLimit:1000}},60,{state:'ARCHIVED',quotas:{currentBytesLimit:1000}}],
        ['PATCH квот','/quotas',{currentBytesLimit:1000},30,{quotas:{currentBytesLimit:1000}}],
    ]){
        const route='/api/projects/'+encodeURIComponent(own.name)+suffix;
        await check(label+' по имени сохраняет настройки и один атомарный аудит; точный повтор безопасен',async()=>{
            const before=await rows(),result=await send(route,payload);assert.equal(result.status,200);
            await assertSaved(value,before);await assertAudit(value,extra);
            const saved=(await rows()).find(row=>row.id===own.id);
            assert.equal(saved.state,extra.state??'ACTIVE');assert.deepEqual(saved.quota,extra.quotas);
            const beforeRetry=await rows(),beforeAudit=await audit();assert.equal((await send(route,payload)).status,200);
            await assertUnchanged(beforeRetry,beforeAudit);
        });
        await check(label+' не сохраняет настройки без аудита при SQL-отказе и восстанавливается повтором',async()=>{
            const before=await rows(),beforeAudit=await audit();
            await pool.query(`CREATE FUNCTION fail_settings_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OWN_SETTINGS_AUDIT_FAILURE'; END $$;
                CREATE TRIGGER fail_settings_audit BEFORE INSERT ON security_events FOR EACH ROW WHEN (NEW.action='project.settings.update') EXECUTE FUNCTION fail_settings_audit();`);
            try {assert.ok((await send(route,payload)).status>=500);await assertUnchanged(before,beforeAudit);}
            finally {await pool.query('DROP TRIGGER fail_settings_audit ON security_events; DROP FUNCTION fail_settings_audit()');}
            assert.equal((await send(route,payload)).status,200);await assertSaved(value,before);await assertAudit(value,extra);
        });
    }
}catch(error){fatal=error;}
finally{
    try{if(app)await app.close();}catch(error){fatal??=error;}
    try{if(pool)await pool.end();}catch(error){fatal??=error;}
    try{if(created){await admin.query(`DROP DATABASE "${database}"`);ownDatabaseDropped=true;}}catch(error){fatal??=error;}
    let afterDatabases=[];try{afterDatabases=await databases();}catch(error){fatal??=error;}
    try{await admin.end();}catch(error){fatal??=error;}
    for(const [key,value] of originalEnv){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    const originalDatabasesPreserved=beforeDatabases.every(name=>afterDatabases.includes(name));
    const unexpectedDatabases=afterDatabases.filter(name=>!beforeDatabases.includes(name));
    const hashes={};for(const file of ['catalog/catalog.service.js','catalog/catalog.controller.js','catalog/catalog-db.js','catalog/project-settings-repository.js','catalog/project-validation.js','access/security-events.js']){
        try{hashes[file]=createHash('sha256').update(await readFile(path.join(dist,file))).digest('hex');}catch(error){fatal??=error;}
    }
    const report={candidate:dist,level:'Own PostgreSQL + real Nest CatalogController/CatalogService/AccessDb HTTP; gateway ACL covered separately',workingStateMutations:0,liveServicesUsed:false,database,ownDatabaseDropped,originalDatabasesPreserved,unexpectedDatabases,hashes,auditApiExample,checks,passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,...(fatal?{fatal:fatal.message}:{})};
    await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
    if(fatal||report.failed||!ownDatabaseDropped||!originalDatabasesPreserved||unexpectedDatabases.length)process.exitCode=1;
}
