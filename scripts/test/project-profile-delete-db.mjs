import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assetEnvironment} from '../assets/environment.mjs';

// Все изменения и аварийные триггеры принадлежат новой временной базе; рабочий каталог не используется.
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
let created=false,dropped=false,pool,service,access,controller,fatal;
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
    await Promise.allSettled([service?.onModuleDestroy(),access?.onModuleDestroy(),pool?.end()]);
    if(created)try{await admin.query(`DROP DATABASE "${database}"`);dropped=true;}catch(error){fatal??=error;}
    const afterDatabases=await databases();
    const preserved=beforeDatabases.every(name=>afterDatabases.includes(name));
    if(!preserved)fatal??=new Error('Изменился исходный список баз');
    await admin.end();
    for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    const report={candidate,level:'Compiled CatalogController/AccessDb/CatalogService + own PostgreSQL; request headers are a trusted-context fixture, no Nest HTTP startup',
        workingDataMutated:false,database,ownDatabaseDropped:dropped,originalDatabasesPreserved:preserved,checks,
        passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,...(fatal?{fatal:fatal.message}:{})};
    await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:report.passed,failed:report.failed,ownDatabaseDropped:dropped,originalDatabasesPreserved:preserved,report:reportPath,...(fatal?{error:fatal.message}:{})}));
    if(fatal||report.failed||!dropped)process.exitCode=1;
}
