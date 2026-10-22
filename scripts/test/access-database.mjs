// Проверки последнего админа и CAS работают только в отдельной временной базе.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';
const root=path.resolve(new URL('../../',import.meta.url).pathname);
const reportPath=process.env.ACCESS_DATABASE_TEST_REPORT||path.join(root,'.run/qa/access-database.json');
const require=createRequire(path.join(root,'services/catalog-service/package.json'));
const {Pool}=require('pg');
const catalogUrl=ownedTestPostgresAdmin(process.env.PUBLICATION_TEST_PG_URL||process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL).href;
const administration=new Pool({connectionString:catalogUrl});
const name='nc_verify_access_'+randomUUID().replaceAll('-','');
const privateUrl=new URL(catalogUrl);privateUrl.pathname='/'+name;
const results=[];let access;let catalog;let pool;let created=false;
const check=async(name,action)=>{try{await action();results.push({case:name,ok:true});}catch(error){results.push({case:name,ok:false,error:error.message});}};
try{
    await administration.query(`CREATE DATABASE "${name}"`);created=true;
    process.env.CATALOG_PG_URL=privateUrl.href;process.env.SSO_DISABLE='false';
    const {CatalogDb}=require(path.join(root,'services/catalog-service/dist/catalog/catalog-db.js'));
    const {AccessDb}=require(path.join(root,'services/catalog-service/dist/access/access-db.js'));
    const {bootstrapAdministrator}=require(path.join(root,'services/catalog-service/dist/access/bootstrap-admin.js'));
    catalog=new CatalogDb(privateUrl.href);await catalog.setup();access=new AccessDb();await access.onModuleInit();
    pool=new Pool({connectionString:privateUrl.href,max:1});
    const first={email:'first@example.test',activeRole:'Главный админ'};await bootstrapAdministrator(pool,{email:first.email});
    await check('Почта нормализуется, повторное добавление возвращает конфликт',async()=>{
        const user=await access.save({email:'  QA@EXAMPLE.TEST ',displayName:' Тест ',createOnly:true},first);assert.equal(user.email,'qa@example.test');assert.equal(user.displayName,'Тест');
        await assert.rejects(access.save({email:'qa@example.test',createOnly:true},first),error=>error.status===409);
    });
    await check('Изменённая параллельно учётная запись защищена CAS',async()=>{
        const expected={displayName:'Тест',isMainAdmin:false,enabled:true};await access.save({email:'qa@example.test',displayName:'Новое имя',expected},first);
        await assert.rejects(access.save({email:'qa@example.test',displayName:'Старое окно',expected},first),error=>error.status===409);
        assert.equal((await access.list()).find(item=>item.email==='qa@example.test').displayName,'Новое имя');
    });
    for(const input of [null,[],{email:'wrong'},{email:'qa@example.test',enabled:'false'},{email:'qa@example.test',isMainAdmin:1},{email:'qa@example.test',displayName:22},{email:'qa@example.test',expected:{}}]){
        await check('Некорректные данные учётной записи отклоняются: '+JSON.stringify(input),()=>assert.rejects(access.save(input,first),error=>error.status===400));
    }
    await check('Два одновременных отключения сохраняют последнего администратора',async()=>{
        await access.save({email:'second@example.test',isMainAdmin:true},first);
        const outcomes=await Promise.allSettled(['first','second'].map(id=>access.save({email:id+'@example.test',enabled:false},{email:id+'@example.test',activeRole:'Главный админ'})));
        assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);assert.equal(outcomes.find(item=>item.status==='rejected').reason.status,409);
        assert.equal((await access.list()).filter(item=>item.enabled&&item.isMainAdmin).length,1);
    });
    await check('Отключённая учётная запись сразу теряет доступ',async()=>{
        const current=(await access.list()).find(item=>item.enabled&&item.isMainAdmin);
        await access.save({email:'qa@example.test',enabled:false},{email:current.email,activeRole:'Главный админ'});await assert.rejects(access.claims('qa@example.test'),error=>error.status===403);
    });
}finally{
    if(access){await access.onModuleDestroy();}if(catalog){await catalog.close();}if(pool){await pool.end();}
    if(created){await administration.query(`DROP DATABASE "${name}"`);}await administration.end();
    await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify({results,passed:results.filter(item=>item.ok).length,failed:results.filter(item=>!item.ok).length},null,2));
}
console.log(JSON.stringify({passed:results.filter(item=>item.ok).length,failed:results.filter(item=>!item.ok)}));if(results.some(item=>!item.ok)){process.exitCode=1;}
