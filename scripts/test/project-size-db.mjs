import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

// Все записи, файлы и HTTP-серверы принадлежат только этому воспроизведению.
const workspace=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const dist=path.resolve(process.env.PROJECT_SIZE_TEST_DIST||path.join(workspace,'services/catalog-service/.size-audit-dist'));
const reportPath=process.env.PROJECT_SIZE_TEST_REPORT||path.join(workspace,'output/size-audit-20261019/backend/postgres.json');
const {Pool}=require('pg');
const {Module}=require('@nestjs/common');
const {NestFactory}=require('@nestjs/core');
const adminUrl=ownedTestPostgresAdmin(process.env.PUBLICATION_TEST_PG_URL||process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL).href;
const database='nc_project_size_test_'+randomBytes(8).toString('hex');
const admin=new Pool({connectionString:adminUrl,max:2});
const databases=async()=>(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map(item=>item.datname);
const beforeDatabases=await databases();
const ownedRoot=await mkdtemp(path.join(tmpdir(),'nc-project-size-'));
const internalToken=randomBytes(24).toString('hex');
const originalEnv=new Map(['NODE_ENV','CATALOG_PG_URL','SSO_DISABLE','PROJECTS_ROOT','RAG_SERVICE_URL','NEUROCENTER_INTERNAL_TOKEN'].map(key=>[key,process.env[key]]));
const checks=[];const ragRequests=[];
let created=false,ownDatabaseDropped=false,ownFilesystemRemoved=false,app,pool,rag,fatal,project,mode='unavailable';
const check=async(name,run)=>{try{await run();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});}};
const safeError=error=>{
    assert.equal(typeof error,'string');assert.ok(error.length>0);
    for(const secret of [internalToken,ownedRoot,'private-password','PRIVATE-ERROR'])assert.equal(error.includes(secret),false);
};
const selectProjectPath=async value=>pool.query('UPDATE projects SET fs_root_path=$2 WHERE id=$1',[project.id,value]);
let endpoint;
const get=async route=>{
    const response=await fetch(endpoint+route,{headers:{'x-neurocenter-internal':internalToken,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:'qa-size@example.test',activeRole:'Главный админ'}))},signal:AbortSignal.timeout(8000)});
    assert.equal(response.status,200,route);return response.json();
};
const detail=()=>get('/api/projects/'+project.id);
const summary=async()=>{const page=await get('/api/projects?page=1&size=20');assert.equal(page.total,1);return page.items[0];};

try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const ownUrl=new URL(adminUrl);ownUrl.pathname='/'+database;
    pool=new Pool({connectionString:ownUrl.href,max:2});
    Object.assign(process.env,{NODE_ENV:'production',CATALOG_PG_URL:ownUrl.href,SSO_DISABLE:'false',PROJECTS_ROOT:ownedRoot,NEUROCENTER_INTERNAL_TOKEN:internalToken});
    rag=createServer((request,response)=>{
        const url=new URL(request.url,'http://fixture.test');ragRequests.push({path:url.pathname,projectKey:url.searchParams.get('projectKey'),authorized:request.headers['x-neurocenter-internal']===internalToken});
        response.setHeader('content-type','application/json');
        if(request.headers['x-neurocenter-internal']!==internalToken){response.writeHead(403);response.end('{}');return;}
        if(mode==='unavailable'){response.writeHead(503);response.end('PRIVATE-ERROR private-password '+internalToken);return;}
        if(mode==='malformed'){response.end('{invalid');return;}
        response.end(JSON.stringify({projectKey:mode==='wrong-project'?'prj-foreign':url.searchParams.get('projectKey'),bytes:mode==='zero'?0:143}));
    });
    await new Promise(resolve=>rag.listen(0,'127.0.0.1',resolve));
    process.env.RAG_SERVICE_URL='http://127.0.0.1:'+rag.address().port;
    const {CatalogService}=require(path.join(dist,'catalog/catalog.service.js'));
    const {CatalogController}=require(path.join(dist,'catalog/catalog.controller.js'));
    const {AccessDb}=require(path.join(dist,'access/access-db.js'));
    const {bootstrapAdministrator}=require(path.join(dist,'access/bootstrap-admin.js'));
    class ProjectSizeFixtureModule{}
    Module({controllers:[CatalogController],providers:[CatalogService,AccessDb]})(ProjectSizeFixtureModule);
    app=await NestFactory.create(ProjectSizeFixtureModule,{logger:false});
    app.use((request,response,next)=>{
        if(request.headers['x-neurocenter-internal']!==internalToken){response.status(403).json({message:'Только изолированный fixture'});return;}next();
    });
    await app.listen(0,'127.0.0.1');endpoint=await app.getUrl();
    const service=app.get(CatalogService);
    await bootstrapAdministrator(pool,{email:'qa-size@example.test'});
    project=await service.createProject({name:'Изолированный замер проекта',fsRootPath:path.join(ownedRoot,'missing'),quotas:{currentBytesUsed:777,retentionBytesUsed:888}});

    await check('503 RAG: list/detail сохраняют null и безопасную причину; nested quota не использует сохранённый расход',async()=>{
        for(const item of [await summary(),await detail()]){
            assert.equal(item.logicalBytes,null);assert.equal(item.retainedBytes,null);safeError(item.logicalSizeError);safeError(item.retainedSizeError);
            if(item.quota){assert.equal(item.quota.currentBytesUsed,null);assert.equal(item.quota.retentionBytesUsed,null);}
        }
    });
    for(const badMode of ['malformed','wrong-project'])await check('Отказ '+badMode+' не считается пустым индексом ни в list, ни в detail',async()=>{
        mode=badMode;for(const item of [await summary(),await detail()]){assert.equal(item.retainedBytes,null);safeError(item.retainedSizeError);if(item.quota)assert.equal(item.quota.retentionBytesUsed,null);}
    });

    const projectRoot=path.join(ownedRoot,'project');await mkdir(path.join(projectRoot,'.opencode'),{recursive:true});
    await writeFile(path.join(projectRoot,'.opencode','own.txt'),'x'.repeat(37));
    const outside=path.join(ownedRoot,'outside');await mkdir(outside);await writeFile(path.join(outside,'private.txt'),'y'.repeat(101));
    await symlink(outside,path.join(projectRoot,'.opencode','foreign'),'dir');
    await selectProjectPath(projectRoot);
    await check('Подтверждённый ноль RAG после сбоя восстанавливается без ошибки, symlink не добавляет чужие байты',async()=>{
        mode='zero';for(const item of [await summary(),await detail()]){
            assert.equal(item.retainedBytes,0);assert.equal(item.retainedSizeError,undefined);assert.equal(item.logicalBytes,37);assert.equal(item.logicalSizeError,undefined);
            if(item.quota){assert.equal(item.quota.currentBytesUsed,37);assert.equal(item.quota.retentionBytesUsed,0);}
        }
    });
    await check('Повторное измерение и alias возвращают положительные байты и актуальную nested quota',async()=>{
        mode='positive';for(const item of [await summary(),await detail(),await get('/api/projects/'+encodeURIComponent(project.name))]){
            assert.equal(item.retainedBytes,143);assert.equal(item.retainedSizeError,undefined);if(item.quota)assert.equal(item.quota.retentionBytesUsed,143);
        }
    });
    for(const [name,value] of [['Не настроенная серверная папка',null],['Отсутствующая серверная папка',path.join(ownedRoot,'missing')]])await check(name+' означает неизвестный размер',async()=>{
        await selectProjectPath(value);const item=await detail();assert.equal(item.logicalBytes,null);assert.equal(item.quota.currentBytesUsed,null);safeError(item.logicalSizeError);
    });
    const emptyRoot=path.join(ownedRoot,'empty');await mkdir(emptyRoot);
    await check('Существующая пустая папка проекта без .opencode подтверждает логический ноль',async()=>{
        await selectProjectPath(emptyRoot);const item=await detail();assert.equal(item.logicalBytes,0);assert.equal(item.quota.currentBytesUsed,0);assert.equal(item.logicalSizeError,undefined);
    });
    await check('Существующий пустой .opencode также подтверждает ноль',async()=>{
        await mkdir(path.join(emptyRoot,'.opencode'));const item=await detail();assert.equal(item.logicalBytes,0);assert.equal(item.quota.currentBytesUsed,0);
    });
    await check('Ссылка вместо корневого .opencode отклоняется без обхода чужого каталога',async()=>{
        await rm(path.join(emptyRoot,'.opencode'),{recursive:true});await symlink(outside,path.join(emptyRoot,'.opencode'),'dir');
        const item=await detail();assert.equal(item.logicalBytes,null);assert.equal(item.quota.currentBytesUsed,null);safeError(item.logicalSizeError);
    });
    await check('Замеры не записывают live-числа в SQL и все обращения RAG остаются в области настоящего ID',async()=>{
        const row=(await pool.query('SELECT logical_bytes,retained_bytes,quota FROM projects WHERE id=$1',[project.id])).rows[0];
        assert.equal(Number(row.logical_bytes),0);assert.equal(Number(row.retained_bytes),0);assert.equal(row.quota.currentBytesUsed,777);assert.equal(row.quota.retentionBytesUsed,888);
        assert.ok(ragRequests.length>0);for(const request of ragRequests){assert.equal(request.path,'/api/rag/size');assert.equal(request.projectKey,project.id);assert.equal(request.authorized,true);}
    });
}catch(error){fatal=error;}
finally{
    try{if(app)await app.close();}catch(error){fatal??=error;}
    try{if(pool)await pool.end();}catch(error){fatal??=error;}
    try{if(rag)await new Promise((resolve,reject)=>{rag.close(error=>error?reject(error):resolve());rag.closeAllConnections();});}catch(error){fatal??=error;}
    try{if(created){await admin.query(`DROP DATABASE "${database}"`);ownDatabaseDropped=true;}}catch(error){fatal??=error;}
    try{await rm(ownedRoot,{recursive:true,force:true});ownFilesystemRemoved=true;}catch(error){fatal??=error;}
    const afterDatabases=await databases();await admin.end();
    for(const [key,value] of originalEnv){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    const originalDatabasesPreserved=beforeDatabases.every(name=>afterDatabases.includes(name));
    const unexpectedDatabases=afterDatabases.filter(name=>!beforeDatabases.includes(name));
    const hashes={};for(const file of ['catalog/catalog.service.js','catalog/catalog.controller.js','catalog/project-retained-size.js','catalog/fs-metrics.js']){
        try{hashes[file]=createHash('sha256').update(await readFile(path.join(dist,file))).digest('hex');}catch(error){fatal??=error;}
    }
    const report={candidate:dist,level:'Own PostgreSQL + real Nest CatalogController/CatalogService/AccessDb HTTP + own FS + loopback RAG',workingStateMutations:0,liveServicesUsed:false,database,ownDatabaseDropped,ownFilesystemRemoved,originalDatabasesPreserved,unexpectedDatabases,hashes,checks,passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,...(fatal?{fatal:fatal.message}:{})};
    await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
    if(fatal||report.failed||!ownDatabaseDropped||!ownFilesystemRemoved||!originalDatabasesPreserved||unexpectedDatabases.length)process.exitCode=1;
}
