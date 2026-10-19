import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assetEnvironment} from '../assets/environment.mjs';

// Профили, квоты, хостинг и удаление проверяются в новой временной базе; рабочий каталог не используется.
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const environment=await assetEnvironment(root);
const adminUrl=new URL(process.env.PUBLICATION_TEST_PG_URL||environment.CATALOG_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/catalog');
adminUrl.pathname='/postgres';
const admin=new Pool({connectionString:adminUrl.href,max:2});
const database='nc_profile_delete_'+randomBytes(8).toString('hex');
const candidate=path.resolve(process.env.PROJECT_AUDIT_FIXES_DIST||path.join(root,'services/catalog-service/.audit-fixes-dist'));
const reportPath=path.resolve(process.env.PROJECT_AUDIT_FIXES_REPORT||path.join(root,'output/project-audit-fixes-20261019/postgres.json'));
const previous=new Map(['NODE_ENV','SSO_DISABLE','CATALOG_PG_URL'].map(key=>[key,process.env[key]]));
const databases=async()=>(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map(row=>row.datname);
const beforeDatabases=await databases();
const checks=[];
let created=false,dropped=false,pool,service,access,controller,hosting,fatal;
const check=async(name,action)=>{
    try{await action();checks.push({name,ok:true});}
    catch(error){checks.push({name,ok:false,error:error.message});}
};
const actor='project-admin@example.test';
const request={headers:{'x-bridge-principal':actor,
    'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actor,activeRole:'Админ проекта'}))}};
const account=async email=>(await pool.query('SELECT email,display_name,is_main_admin,enabled FROM platform_users WHERE email=$1',[email])).rows[0];
const count=async(sql,params)=>(await pool.query(sql,params)).rows[0].n;
const project=async name=>{
    const value=await service.createProject({name});
    await service.addProjectMember(value.id,{userId:'u-'+actor,principalName:actor,displayName:'Администратор проекта',role:'Админ проекта',addedAt:new Date().toISOString()},actor);
    return value;
};

try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const ownUrl=new URL(adminUrl);ownUrl.pathname='/'+database;
    pool=new Pool({connectionString:ownUrl.href,max:4,options:'-c statement_timeout=10000 -c lock_timeout=7000'});
    Object.assign(process.env,{NODE_ENV:'production',SSO_DISABLE:'false',CATALOG_PG_URL:ownUrl.href});
    const {CatalogService}=require(path.join(candidate,'catalog/catalog.service.js'));
    const {CatalogController}=require(path.join(candidate,'catalog/catalog.controller.js'));
    const {AccessDb}=require(path.join(candidate,'access/access-db.js'));
    service=new CatalogService();access=new AccessDb();await service.ensureSchema();await access.onModuleInit();
    controller=new CatalogController(service,access);
    await access.save({email:actor,displayName:'Администратор проекта'});
    const email='existing@example.test';
    await access.save({email,displayName:'Иван Иванов',isMainAdmin:true,enabled:false});
    const expected=await account(email);

    for(const displayName of [undefined,email,'Имя в отдельном проекте'])await check('Назначение сохраняет глобальный профиль при имени '+String(displayName),async()=>{
        const p=await project('Профиль '+String(displayName));
        await controller.addProjectMember(p.id,{principalName:email,displayName,role:'Разработчик'},request);
        assert.deepEqual(await account(email),expected);
        assert.equal(await count("SELECT count(*)::int AS n FROM security_events WHERE action='user.update' AND resource_id=$1",[email]),0);
    });
    await check('Новый сотрудник получает обычный аккаунт и единственный аудит создания',async()=>{
        const p=await project('Новый сотрудник'),email='new@example.test';
        await controller.addProjectMember(p.id,{principalName:email,displayName:'Новый сотрудник',role:'Разработчик'},request);
        assert.deepEqual(await account(email),{email,display_name:'Новый сотрудник',is_main_admin:false,enabled:true});
        const rows=(await pool.query("SELECT actor FROM security_events WHERE action='user.create' AND resource_id=$1",[email])).rows;
        assert.deepEqual(rows,[{actor}]);
    });
    await check('Отказ аудита создания откатывает аккаунт и не создаёт назначение',async()=>{
        const p=await project('Отказ создания аккаунта'),email='audit-fail@example.test';
        await pool.query(`CREATE FUNCTION fixture_user_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.action='user.create' AND NEW.resource_id='audit-fail@example.test' THEN RAISE EXCEPTION 'fixture user audit failure'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER fixture_user_audit_failure BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION fixture_user_audit_failure()`);
        await assert.rejects(controller.addProjectMember(p.id,{principalName:email,role:'Разработчик'},request),/fixture user audit failure/);
        assert.equal(await account(email),undefined);
        assert.equal(await count('SELECT count(*)::int AS n FROM project_members WHERE project_id=$1 AND principal_name=$2',[p.id,email]),0);
    });
    await check('Параллельное создание сохраняет один профиль и одно событие',async()=>{
        const email='concurrent@example.test';
        const values=await Promise.all(['Первое имя','Другое имя'].map(displayName=>access.ensureProjectUser({email,displayName},actor)));
        assert.equal(values[0].displayName,values[1].displayName);
        assert.equal((await account(email)).display_name,values[0].displayName);
        assert.equal(await count("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='user.create'",[email]),1);
        assert.equal(await count("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='user.update'",[email]),0);
    });

    const quotaDefaults={currentBytesLimit:0,currentBytesUsed:0,retentionBytesLimit:0,retentionBytesUsed:0,stagingBytesLimit:0,stagingBytesUsed:0};
    await check('Первый частичный PATCH квот сохраняет все поля и аудит',async()=>{
        const p=await project('Первое изменение квоты');
        const saved=await controller.updateProject(p.id,{quotas:{currentBytesLimit:1024}},request);
        const expected={...quotaDefaults,currentBytesLimit:1024};
        assert.deepEqual(saved.quota,expected);
        assert.deepEqual((await pool.query('SELECT quota FROM projects WHERE id=$1',[p.id])).rows[0].quota,expected);
        assert.equal(await count("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='project.settings.update'",[p.id]),1);
    });
    await check('Частичный PATCH старого JSONB сохраняет лимиты и неизвестный замер',async()=>{
        const p=await project('Старая частичная квота');
        await pool.query('UPDATE projects SET quota=$2::jsonb WHERE id=$1',[p.id,JSON.stringify({currentBytesLimit:1024,currentBytesUsed:null,retentionBytesLimit:2048})]);
        const saved=await controller.updateProject(p.id,{quotas:{stagingBytesLimit:4096}},request);
        assert.deepEqual(saved.quota,{...quotaDefaults,currentBytesLimit:1024,currentBytesUsed:null,retentionBytesLimit:2048,stagingBytesLimit:4096});
    });
    await check('Создание с частичной квотой сохраняет полный JSONB',async()=>{
        const p=await service.createProject({name:'Создание с квотой',quotas:{currentBytesLimit:2048}});
        assert.deepEqual(p.quota,{...quotaDefaults,currentBytesLimit:2048});
        assert.deepEqual((await pool.query('SELECT quota FROM projects WHERE id=$1',[p.id])).rows[0].quota,p.quota);
    });

    const {ModelHostingService}=require(path.join(candidate,'models/hosting.service.js'));
    const {ModelHostingRepository}=require(path.join(candidate,'models/hosting.repository.js'));
    let runtimeReads=0;
    hosting=new ModelHostingService({pool,ready:async()=>{}},access,{status:async()=>{
        runtimeReads++;return {state:'ready',message:'Синтетический runtime готов',checkedAt:null};
    }});
    await hosting.onModuleInit();
    const hostingRepository=new ModelHostingRepository(pool);
    const hostingLock="hashtextextended('neurocenter:model-hosting',0)";
    const withHostingOwner=async action=>{
        const owner=await pool.connect();
        try{await owner.query(`SELECT pg_advisory_lock(${hostingLock})`);return await action(owner);}
        finally{try{await owner.query(`SELECT pg_advisory_unlock(${hostingLock})`);}finally{owner.release();}}
    };
    const hostingState=async id=>(await pool.query('SELECT state,stage FROM model_hosting_jobs WHERE id=$1',[id])).rows[0];
    const model={id:'fixture-hosting',name:'Синтетическая модель',runtime:'ollama',model:'fixture:test'};
    let staleJob;
    await check('Живая блокировка исполнителя оставляет задание running без опроса runtime',async()=>{
        await withHostingOwner(async owner=>{
            staleJob=await hostingRepository.create(owner,model.id,'start',actor);
            const reads=runtimeReads;
            assert.equal((await hosting.status(model)).state,'busy');
            assert.deepEqual(await hostingState(staleJob.id),{state:'running',stage:'starting'});
            assert.equal(runtimeReads,reads);
        });
    });
    await check('Свободная блокировка завершает потерянное задание и историю ровно один раз',async()=>{
        assert.ok(staleJob);
        assert.equal((await hosting.status(model)).state,'ready');
        assert.deepEqual(await hostingState(staleJob.id),{state:'failed',stage:'interrupted'});
        assert.equal((await pool.query('SELECT state FROM operations WHERE operation_id=$1',[staleJob.operation_id])).rows[0].state,'FAILED');
        await hosting.status(model);
        assert.equal(await count("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='model.hosting.failed'",[model.id]),1);
    });
    await check('Одновременные проверки статуса восстанавливают потерянную операцию без дубля аудита',async()=>{
        const parallelModel={...model,id:'fixture-hosting-parallel'};
        const row=await withHostingOwner(owner=>hostingRepository.create(owner,parallelModel.id,'check',actor));
        await Promise.all([hosting.status(parallelModel),hosting.status(parallelModel)]);
        assert.equal((await hosting.status(parallelModel)).state,'ready');
        assert.deepEqual(await hostingState(row.id),{state:'failed',stage:'interrupted'});
        assert.equal(await count("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='model.hosting.failed'",[parallelModel.id]),1);
    });
    await check('Отказ аудита recovery откатывает обе строки, освобождает lock и допускает повтор',async()=>{
        const failedModel={...model,id:'fixture-hosting-retry'};
        const row=await withHostingOwner(owner=>hostingRepository.create(owner,failedModel.id,'start',actor));
        await pool.query(`CREATE FUNCTION fixture_hosting_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.action='model.hosting.failed' AND NEW.resource_id='fixture-hosting-retry' THEN RAISE EXCEPTION 'fixture hosting audit failure'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER fixture_hosting_audit_failure BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION fixture_hosting_audit_failure()`);
        const probe=await pool.connect();let locked=false;
        try{
            await assert.rejects(hosting.status(failedModel),/fixture hosting audit failure/);
            locked=(await probe.query(`SELECT pg_try_advisory_lock(${hostingLock}) AS locked`)).rows[0].locked;
            assert.equal(locked,true);
        }finally{try{if(locked)await probe.query(`SELECT pg_advisory_unlock(${hostingLock})`);}finally{probe.release();}}
        assert.deepEqual(await hostingState(row.id),{state:'running',stage:'starting'});
        assert.equal((await pool.query('SELECT state FROM operations WHERE operation_id=$1',[row.operation_id])).rows[0].state,'RUNNING');
        await pool.query('DROP TRIGGER fixture_hosting_audit_failure ON security_events');
        assert.equal((await hosting.status(failedModel)).state,'ready');
        assert.deepEqual(await hostingState(row.id),{state:'failed',stage:'interrupted'});
    });

    const deletion=await project('Удаление с откатом');
    await pool.query("INSERT INTO project_assets(project_id,asset_id,asset_kind) VALUES($1,'fixture-tool','mcp')",[deletion.id]);
    await pool.query(`CREATE FUNCTION fixture_delete_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.type='DELETE' AND NEW.actor='audit-delete-fail@example.test' THEN RAISE EXCEPTION 'fixture delete audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fixture_delete_audit_failure BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION fixture_delete_audit_failure()`);
    await check('Отказ записи удаления восстанавливает проект, назначения и активы через ROLLBACK',async()=>{
        await assert.rejects(service.deleteProject(deletion.id,'audit-delete-fail@example.test'),/fixture delete audit failure/);
        for(const table of ['projects','project_members','project_assets']){
            const column=table==='projects'?'id':'project_id';
            assert.equal(await count(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,[deletion.id]),1);
        }
        assert.equal(await count("SELECT count(*)::int AS n FROM operations WHERE resource_id=$1 AND type='DELETE'",[deletion.id]),0);
    });
    await check('Повтор удаления выполняет FK-cascade и фиксирует одну полную запись истории',async()=>{
        assert.deepEqual(await service.deleteProject(deletion.name,actor),{ok:true,id:deletion.id});
        for(const table of ['projects','project_members','project_assets']){
            const column=table==='projects'?'id':'project_id';
            assert.equal(await count(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,[deletion.id]),0);
        }
        const rows=(await pool.query("SELECT project_id,resource_id,actor,state,percent,finished_at,log FROM operations WHERE resource_id=$1 AND type='DELETE'",[deletion.id])).rows;
        assert.equal(rows.length,1);assert.equal(rows[0].actor,actor);assert.equal(rows[0].project_id,deletion.id);
        assert.equal(rows[0].state,'SUCCEEDED');assert.equal(rows[0].percent,100);assert.ok(rows[0].finished_at);
        assert.ok(rows[0].log[0].message.includes(deletion.name));
        await assert.rejects(service.deleteProject(deletion.id,actor),error=>error.getStatus()===404);
        assert.equal(await count("SELECT count(*)::int AS n FROM operations WHERE resource_id=$1 AND type='DELETE'",[deletion.id]),1);
    });
    await check('Два одновременных удаления возвращают один успех и одну запись истории',async()=>{
        const p=await project('Конкурентное удаление');
        const results=await Promise.allSettled([service.deleteProject(p.id,actor),service.deleteProject(p.id,actor)]);
        assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
        const failure=results.find(result=>result.status==='rejected');assert.equal(failure.reason.getStatus(),404);
        assert.equal(await count("SELECT count(*)::int AS n FROM operations WHERE resource_id=$1 AND type='DELETE'",[p.id]),1);
    });
}catch(error){fatal=error;}
finally{
    try{await hosting?.beforeApplicationShutdown();}catch(error){fatal??=error;}
    await Promise.allSettled([service?.onModuleDestroy(),access?.onModuleDestroy(),pool?.end()]);
    if(created)try{await admin.query(`DROP DATABASE "${database}"`);dropped=true;}catch(error){fatal??=error;}
    const afterDatabases=await databases();
    const preserved=beforeDatabases.every(name=>afterDatabases.includes(name));
    if(!preserved)fatal??=new Error('Изменился исходный список баз');
    await admin.end();
    for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    const report={candidate,level:'Compiled CatalogController/AccessDb/CatalogService/ModelHostingService + own PostgreSQL; trusted request headers and synthetic model runtime, no Nest HTTP startup',
        workingDataMutated:false,database,ownDatabaseDropped:dropped,originalDatabasesPreserved:preserved,checks,
        passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,...(fatal?{fatal:fatal.message}:{})};
    await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:report.passed,failed:report.failed,ownDatabaseDropped:dropped,originalDatabasesPreserved:preserved,report:reportPath,...(fatal?{error:fatal.message}:{})}));
    if(fatal||report.failed||!dropped)process.exitCode=1;
}
