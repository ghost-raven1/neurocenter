import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.RAG_RECOVERY_TEST_PG_URL).href;

// Настоящие SQL-права: отказ, исправление и повтор на том же объекте без перезапуска сервиса.
for(const file of ['.env.local','.env'])try{process.loadEnvFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
const require=createRequire(path.resolve('services/rag-sync-service/package.json'));
const {Pool}=require('pg'),{Module}=require('@nestjs/common'),{NestFactory}=require('@nestjs/core');
const dist=path.resolve(process.env.RAG_RECOVERY_TEST_DIST||'services/rag-sync-service/dist');
const {RagDb}=require(path.join(dist,'rag/rag-db.js')),{RagController}=require(path.join(dist,'rag/rag.controller.js')),
    {RagService}=require(path.join(dist,'rag/rag.service.js'));
const suffix=randomUUID().replaceAll('-','').slice(0,16),database='nc_rag_recovery_'+suffix;
const writer='nc_rw_'+suffix,reader='nc_ro_'+suffix,password=randomBytes(24).toString('hex');
const adminUrl=new URL(adminConnection);
adminUrl.pathname='/postgres';
const admin=new Pool({connectionString:adminUrl.href,max:1,application_name:'nc-edge-rag-recovery'});
const before=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const roles=[],checks=[];let created=false,owner,db,readDb,app,fatal;
const report=path.resolve(process.env.RAG_RECOVERY_TEST_REPORT||'output/edge-audit-20261019/rag/postgres.json');
const check=async(name,action)=>{await action();checks.push(name);console.log('OK '+name);};
try{
    for(const role of [writer,reader]){await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);roles.push(role);}
    await admin.query(`CREATE DATABASE ${database}`);created=true;
    const ownUrl=new URL(adminUrl);ownUrl.pathname='/'+database;
    owner=new Pool({connectionString:ownUrl.href,max:1,application_name:'nc-edge-rag-owner'});
    await owner.query(`CREATE EXTENSION vector; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${writer},${reader}`);
    const userUrl=new URL(ownUrl);userUrl.username=writer;userUrl.password=password;
    db=new RagDb({url:userUrl.href,dim:2});
    await check('SQL отказ создания схемы не скрывается',async()=>{await assert.rejects(db.setup(),error=>error.code==='42501');});
    await check('После восстановления прав тот же RagDb успешно повторяет setup без restart',async()=>{
        await owner.query(`GRANT CREATE ON SCHEMA public TO ${writer}`);await db.setup();
        const content='Изолированный фрагмент';
        await db.applyDelta('own',[{id:'one',filePath:'README.md',content,description:null,startLine:null,endLine:null,language:null,
            kind:'',role:null,quirkType:null,tags:null,contentHash:createHash('sha256').update(content).digest('hex'),embedding:[0.5,1]}],[]);
        assert.equal(await db.count('own'),1);
    });
    userUrl.username=reader;readDb=new RagDb({url:userUrl.href,dim:2});
    const service={retainedSizeBytes:key=>readDb.retainedEstimateBytes(key)};
    class OwnModule{}
    Module({controllers:[RagController],providers:[{provide:RagService,useValue:service}]})(OwnModule);
    app=await NestFactory.create(OwnModule,{logger:false});await app.listen(0,'127.0.0.1');
    const base=await app.getUrl();
    await check('Настоящий HTTP GET size возвращает 503 при SQL отказе чтения вместо bytes0',async()=>{
        const response=await fetch(base+'/api/rag/size?projectKey=own');assert.equal(response.status,503);
        const body=await response.json();assert.match(body.message,/Не удалось измерить/);assert.equal(body.bytes,undefined);
        assert.ok(!JSON.stringify(body).includes(password));
    });
    await check('После GRANT повтор GET size возвращает известный положительный объём',async()=>{
        await owner.query(`GRANT SELECT ON rag_chunks TO ${reader}`);
        const response=await fetch(base+'/api/rag/size?projectKey=own');assert.equal(response.status,200);
        const body=await response.json();assert.equal(body.projectKey,'own');assert.ok(body.bytes>0);
        assert.equal(await db.count('own'),1);
    });
}catch(error){fatal={code:error.code||null,message:error.message};process.exitCode=1;console.error(error.message);}
finally{
    if(app)await app.close();for(const connection of [db,readDb])if(connection)await connection.close();if(owner)await owner.end();
    if(created)await admin.query(`DROP DATABASE ${database}`);for(const role of roles)await admin.query(`DROP ROLE ${role}`);
    const after=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;await admin.end();
    assert.deepEqual(after,before);await fs.mkdir(path.dirname(report),{recursive:true});
    await fs.writeFile(report,JSON.stringify({ok:!fatal,checks,fatal,ownDatabaseDropped:created,ownRolesDropped:roles.length,
        originalDatabasesPreserved:true,workingRowsChanged:false,actualHttp:true},null,2)+'\n');
}
