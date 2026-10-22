// Bootstrap и отказ аудита проверяются исключительно в собственной временной БД.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const reportPath=process.env.BOOTSTRAP_TEST_REPORT||'.run/production-stage-1/bootstrap.json';
const {Pool}=require('pg');
const {AccessDb}=require('../../services/catalog-service/dist/access/access-db.js');
const {CatalogDb}=require('../../services/catalog-service/dist/catalog/catalog-db.js');
const {bootstrapAdministrator}=require('../../services/catalog-service/dist/access/bootstrap-admin.js');
const source=ownedTestPostgresAdmin(process.env.PUBLICATION_TEST_PG_URL||process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL).href;
const administrator=new Pool({connectionString:source});const database='nc_verify_bootstrap_'+randomUUID().replaceAll('-','');
const url=new URL(source);url.pathname='/'+database;let created=false;let access;let catalog;let pool;const results=[];
async function check(name,action){try{await action();results.push({case:name,ok:true});}catch(error){results.push({case:name,ok:false,error:error.message});}}
try{
    await administrator.query(`CREATE DATABASE "${database}"`);created=true;
    process.env.NODE_ENV='production';process.env.SSO_DISABLE='false';process.env.CATALOG_PG_URL=url.href;
    pool=new Pool({connectionString:url.href});catalog=new CatalogDb(url.href);await catalog.setup();access=new AccessDb();await access.onModuleInit();
    await check('Production не создаёт демонстрационные проекты, участников и локального админа',async()=>{
        for(const table of ['projects','project_members','platform_users']){assert.equal(Number((await pool.query('SELECT count(*) AS n FROM '+table)).rows[0].n),0);}
    });
    await check('Пустая почта не меняет каталог',async()=>{await assert.rejects(bootstrapAdministrator(pool,{email:''}),error=>error.status===400);});
    await check('Отказ аудита откатывает и пользователя, и отметку выполнения',async()=>{
        await pool.query("CREATE FUNCTION qa_deny_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa-audit-failure'; END $$; CREATE TRIGGER qa_audit_failure BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION qa_deny_audit()");
        try{await assert.rejects(bootstrapAdministrator(pool,{email:'first@example.test'}),/qa-audit-failure/);assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_users')).rows[0].n,0);}
        finally{await pool.query('DROP TRIGGER qa_audit_failure ON security_events; DROP FUNCTION qa_deny_audit()');}
    });
    await check('Два одновременных seed создают одного администратора и одно событие',async()=>{
        const results=await Promise.all([bootstrapAdministrator(pool,{email:'FIRST@example.test'}),bootstrapAdministrator(pool,{email:'first@example.test'})]);
        assert.deepEqual(results.map(row=>row.created).sort(),[false,true]);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE action='admin.bootstrap'")).rows[0].n,1);
        assert.deepEqual((await access.claims('first@example.test')).userRoles,['Главный админ']);
    });
    await check('Повтор с другим адресом не расширяет доступ',async()=>{await assert.rejects(bootstrapAdministrator(pool,{email:'other@example.test'}),error=>error.status===409);});
    await check('После отзыва роли seed не восстанавливает администратора',async()=>{
        await access.save({email:'second@example.test',isMainAdmin:true},{email:'first@example.test',activeRole:'Главный админ'});
        await access.save({email:'first@example.test',isMainAdmin:false},{email:'second@example.test',activeRole:'Главный админ'});
        await assert.rejects(bootstrapAdministrator(pool,{email:'first@example.test'}),error=>error.status===409);
        assert.equal((await access.list()).find(user=>user.email==='first@example.test').isMainAdmin,false);
    });
    await check('Аудит сохраняет действующего участника и исходные права',async()=>{
        const event=(await pool.query("SELECT actor,before_state,after_state FROM security_events WHERE resource_id='first@example.test' AND action='user.update'")).rows[0];
        assert.equal(event.actor,'second@example.test');assert.equal(event.before_state.isMainAdmin,true);assert.equal(event.after_state.isMainAdmin,false);
    });
    await check('Отказ аудита при изменении пользователя откатывает изменение',async()=>{
        await pool.query("CREATE FUNCTION qa_deny_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa-audit-failure'; END $$; CREATE TRIGGER qa_audit_failure BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION qa_deny_audit()");
        try{await assert.rejects(access.save({email:'first@example.test',enabled:false},{email:'second@example.test',activeRole:'Главный админ'}),/qa-audit-failure/);assert.equal((await access.list()).find(user=>user.email==='first@example.test').enabled,true);}
        finally{await pool.query('DROP TRIGGER qa_audit_failure ON security_events; DROP FUNCTION qa_deny_audit()');}
    });
}finally{
    if(access){await access.onModuleDestroy();}if(catalog){await catalog.close();}if(pool){await pool.end();}
    if(created){await administrator.query(`DROP DATABASE "${database}"`);}await administrator.end();
    await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify({results,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length},null,2));
}
console.log(JSON.stringify({passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok)}));if(results.some(r=>!r.ok)){process.exitCode=1;}
