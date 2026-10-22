import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../services/shared/feature-flags.cjs';

// Настоящие ProxyService → AccessController/AccessDb → CatalogController работают только с собственной БД.
const workspace=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const dist=path.resolve(process.env.RETENTION_TEST_DIST||path.join(workspace,'services/catalog-service/.size-audit-dist'));
const reportPath=process.env.RETENTION_ACCESS_TEST_REPORT||path.join(workspace,'output/retention-audit-20261019/access/postgres.json');
const ts=require('typescript');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(require('node:fs').readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,filename);
const {ProxyService}=require(path.join(workspace,'services/api-gateway/src/proxy/proxy.service.ts'));
const {Pool}=require('pg');const {Module}=require('@nestjs/common');const {NestFactory}=require('@nestjs/core');
const adminUrl=ownedTestPostgresAdmin(process.env.PUBLICATION_TEST_PG_URL||process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL).href;
const admin=new Pool({connectionString:adminUrl,max:2});
const databases=async()=>(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map(item=>item.datname);
const beforeDatabases=await databases();
const database='nc_retention_access_test_'+randomBytes(8).toString('hex');const token=randomBytes(24).toString('hex');
const originalEnv=new Map(['NODE_ENV','CATALOG_PG_URL','SSO_DISABLE','RAG_SERVICE_URL','NEUROCENTER_INTERNAL_TOKEN'].map(key=>[key,process.env[key]]));
const checks=[];const downstream=[];
let created=false,ownDatabaseDropped=false,app,gateway,pool,fatal,project,foreign,selectedRole='Админ проекта',selectedEmail='owner@example.test';
const check=async(name,run)=>{try{await run();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});}};
const variants=[{name:'retention',suffix:'/retention'},{name:'общий PATCH',suffix:''},{name:'quotas',suffix:'/quotas'}];
let base;
const patch=async(key,variant)=>{
    const payload=variant.name==='quotas'?{currentBytesLimit:1234}:{retention:9};
    const response=await fetch(base+'/api/projects/'+encodeURIComponent(key)+variant.suffix,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
    return {status:response.status,body:await response.json()};
};
const assertBlocked=async(key,variant)=>{const before=downstream.length;assert.equal((await patch(key,variant)).status,403);assert.equal(downstream.length,before,'Запрещённый запрос не должен достигать CatalogController');};

try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const ownUrl=new URL(adminUrl);ownUrl.pathname='/'+database;
    pool=new Pool({connectionString:ownUrl.href,max:2});
    Object.assign(process.env,{NODE_ENV:'production',CATALOG_PG_URL:ownUrl.href,SSO_DISABLE:'false',RAG_SERVICE_URL:'',NEUROCENTER_INTERNAL_TOKEN:token});
    const {CatalogService}=require(path.join(dist,'catalog/catalog.service.js'));const {CatalogController}=require(path.join(dist,'catalog/catalog.controller.js'));
    const {AccessDb}=require(path.join(dist,'access/access-db.js'));const {AccessController}=require(path.join(dist,'access/access.controller.js'));
    const {bootstrapAdministrator}=require(path.join(dist,'access/bootstrap-admin.js'));
    class RetentionAccessFixtureModule{}
    Module({controllers:[CatalogController,AccessController],providers:[CatalogService,AccessDb]})(RetentionAccessFixtureModule);
    app=await NestFactory.create(RetentionAccessFixtureModule,{logger:false});
    app.use((request,response,next)=>{
        if(request.headers['x-neurocenter-internal']!==token){response.status(403).json({message:'Только fixture'});return;}
        if(request.method==='GET'&&request.path==='/internal/feature-flags/evaluated'){response.json(evaluateFeatureFlags(defaultFeatureFlags()));return;}
        if(request.path.startsWith('/api/projects/'))downstream.push({path:request.path,actor:request.headers['x-bridge-principal']});next();
    });
    await app.listen(0,'127.0.0.1');const catalogEndpoint=await app.getUrl();
    const catalog=app.get(CatalogService),access=app.get(AccessDb);
    const mainActor={email:'main@example.test',activeRole:'Главный админ'},backupActor={email:'backup-main@example.test',activeRole:'Главный админ'};
    await bootstrapAdministrator(pool,{email:mainActor.email});
    for(const email of ['owner@example.test','backup-main@example.test'])await access.save({email,isMainAdmin:email!=='owner@example.test'},mainActor);
    project=await catalog.createProject({name:'Своя область retention'});foreign=await catalog.createProject({name:'Чужая область retention'});
    const developer=await catalog.createProject({name:'Назначение разработчика'});const observer=await catalog.createProject({name:'Назначение наблюдателя'});
    for(const [target,role] of [[project,'Админ проекта'],[developer,'Разработчик'],[observer,'Наблюдатель']])await catalog.addProjectMember(target.id,{userId:'u-owner',principalName:'owner@example.test',displayName:'Владелец fixture',role,addedAt:new Date().toISOString()},mainActor);
    const proxy=new ProxyService({get:()=>catalogEndpoint},{authenticate:async()=>({email:selectedEmail,userId:selectedEmail,principalName:selectedEmail,activeRole:selectedRole,userRoles:[selectedRole],policies:{}})},{mutation:()=>{}});
    gateway=createServer(async(request,response)=>{
        const url=new URL(request.url,'http://fixture.test');request.path=url.pathname;request.query=Object.fromEntries(url.searchParams);
        const chunks=[];for await(const chunk of request)chunks.push(chunk);request.body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
        response.status=value=>{response.statusCode=value;return response;};response.send=value=>response.end(JSON.stringify(value));response.json=response.send;
        await proxy.forward(request,response);
    });
    await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+gateway.address().port;

    for(const variant of variants)await check('Админ проекта: '+variant.name+' разрешён по собственному ID и alias',async()=>{
        for(const key of [project.id,project.name]){const result=await patch(key,variant);assert.equal(result.status,200,variant.name+' / '+key+': '+JSON.stringify(result.body));}
    });
    for(const role of ['Разработчик','Наблюдатель'])await check(role+': все три изменения отклоняются до downstream',async()=>{
        selectedRole=role;for(const variant of variants)for(const key of [project.id,project.name])await assertBlocked(key,variant);
    });
    selectedRole='Админ проекта';
    await check('Чужие ID/alias и несуществующий alias отклоняются до downstream',async()=>{
        for(const variant of variants)for(const key of [foreign.id,foreign.name,'несуществующий alias'])await assertBlocked(key,variant);
    });
    await check('Настоящий отзыв назначения в SQL блокирует ту же активную роль без нового входа',async()=>{
        await catalog.removeProjectMember(project.id,'u-owner','Админ проекта',backupActor);
        for(const variant of variants)await assertBlocked(project.id,variant);
        await catalog.addProjectMember(project.id,{userId:'u-owner',principalName:'owner@example.test',displayName:'Владелец fixture',role:'Админ проекта',addedAt:new Date().toISOString()},backupActor);
        assert.equal((await patch(project.id,variants[0])).status,200);
    });
    await check('Главный администратор изменяет все три настройки в проекте без назначения',async()=>{
        selectedEmail='main@example.test';selectedRole='Главный админ';
        for(const variant of variants)assert.equal((await patch(project.id,variant)).status,200);
    });
    await check('Главный администратор получает 404 для несуществующего alias, без ложного успеха',async()=>{
        for(const variant of variants)assert.equal((await patch('несуществующий alias',variant)).status,404,variant.name);
    });
    await check('Настоящий отзыв платформенного права блокирует следующий запрос без нового входа',async()=>{
        await access.save({email:'main@example.test',isMainAdmin:false},backupActor);
        for(const variant of variants)await assertBlocked(project.id,variant);
    });
}catch(error){fatal=error;}
finally{
    try{if(gateway)await new Promise((resolve,reject)=>{gateway.close(error=>error?reject(error):resolve());gateway.closeAllConnections();});}catch(error){fatal??=error;}
    try{if(app)await app.close();}catch(error){fatal??=error;}
    try{if(pool)await pool.end();}catch(error){fatal??=error;}
    try{if(created){await admin.query(`DROP DATABASE "${database}"`);ownDatabaseDropped=true;}}catch(error){fatal??=error;}
    const afterDatabases=await databases();await admin.end();
    for(const [key,value] of originalEnv){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    const originalDatabasesPreserved=beforeDatabases.every(name=>afterDatabases.includes(name));const unexpectedDatabases=afterDatabases.filter(name=>!beforeDatabases.includes(name));
    const hashes={};for(const file of ['catalog/catalog.controller.js','catalog/catalog.service.js','access/access-policy.js','access/access-db.js']){
        try{hashes[file]=createHash('sha256').update(await readFile(path.join(dist,file))).digest('hex');}catch(error){fatal??=error;}
    }
    hashes['source/proxy.service.ts']=createHash('sha256').update(await readFile(path.join(workspace,'services/api-gateway/src/proxy/proxy.service.ts'))).digest('hex');
    const report={candidate:dist,level:'Own PostgreSQL + source ProxyService HTTP/Axios + real Nest AccessController/AccessDb/CatalogController',sessionFixture:true,workingStateMutations:0,liveServicesUsed:false,database,ownDatabaseDropped,originalDatabasesPreserved,unexpectedDatabases,hashes,checks,passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,...(fatal?{fatal:fatal.message}:{})};
    await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
    if(fatal||report.failed||!ownDatabaseDropped||!originalDatabasesPreserved||unexpectedDatabases.length)process.exitCode=1;
}
