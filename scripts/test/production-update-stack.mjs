#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {configureProduction} from '../production/configuration.mjs';
import {applicationServices,composeClient,composeConfiguration,serviceImageIds,containers,docker,repositoryRoot,saveDiagnostic} from '../production/compose-client.mjs';
import {backupProduction,restoreProduction,volumeTransfer} from '../production/recovery.mjs';
import {verifyBackup} from '../production/recovery-manifest.mjs';
import {updateProduction} from '../production/update.mjs';
import {defaultPolicy} from '../../services/shared/maintenance-policy.cjs';
import {seedProductionRuntimeArtifact,verifyProductionRuntimeArtifact} from './production-runtime-artifact.fixture.mjs';
import {recordProductionHealth} from './production-health.fixture.mjs';
import {inspectSchemaManifests,runSchemaCommands} from '../production/schema-migrations.mjs';
import {captureMigrationState,assertMigrationStatePreserved} from './production-migration-state.fixture.mjs';

process.umask(0o077);
const sourceRelease=process.env.NEUROCENTER_UPDATE_SOURCE_RELEASE||'verify-20261018-v09-final';
const targetRelease=process.env.NEUROCENTER_UPDATE_TARGET_RELEASE;
if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(sourceRelease)||!targetRelease||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetRelease)||sourceRelease===targetRelease||sourceRelease==='latest'||targetRelease==='latest'){throw new Error('Укажите разные постоянные NEUROCENTER_UPDATE_SOURCE_RELEASE и NEUROCENTER_UPDATE_TARGET_RELEASE');}
const stage=path.resolve(repositoryRoot,process.env.NEUROCENTER_TEST_EVIDENCE||'.run/production-update-20261018');
await mkdir(stage,{recursive:true,mode:0o700});
const run=randomUUID().slice(0,8),fixture=path.join(stage,'fixture',run),copies=path.join(fixture,'copies');
await mkdir(copies,{recursive:true,mode:0o700});
const hash=value=>createHash('sha256').update(value).digest('hex');
const sqlQuote=value=>"'"+String(value).replace(/'/g,"''")+"'";
const cases=[],timings={};const sides=[];
let sourceImages,targetImages,targetSchemaManifests,postgresImage,originalBackup,updateReceipt,rehearsalReport,fatal,artifact;
const startedAt=new Date().toISOString();
const check=async(name,action)=>{const before=Date.now();await action();cases.push({name,passed:true,durationMs:Date.now()-before});console.log('OK '+name);};
const writeJson=(filename,value)=>writeFile(filename,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const certificate=path.join(fixture,'tls.crt'),privateKey=path.join(fixture,'tls.key');
if(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',privateKey,'-out',certificate,'-days','1','-subj','/CN=panel.test','-addext','subjectAltName=DNS:panel.test'],{stdio:'ignore'}).status!==0){throw new Error('Для изолированной репетиции нужен openssl');}
const marker='update-fixture-'+run;
const projectId='prj-'+run;
const projectDatabase='nc_rag_'+hash(projectId).slice(0,32);
const fixturePolicy={...structuredClone(defaultPolicy),enabled:false,timeZone:'Asia/Tomsk',localCopies:7,externalRetentionDays:45,rpoMinutes:720,rtoMinutes:90};
const fileScript="const fs=require('fs'),crypto=require('crypto');const files=['/data/projects/update-fixture/настройки.json'];console.log(JSON.stringify(Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))));";

async function createSide(name){
    const projectName='nc-update-'+name+'-'+run;
    assert.match(projectName,/^nc-update-(?:source|manual|rollback)-[a-f0-9]{8}$/);
    const directory=path.join(fixture,name);
    await configureProduction({panelUrl:'https://panel.test',ssoHost:'https://identity.example.test',ssoClientId:'isolated-rehearsal',ssoClientSecret:'synthetic-fixture-only',
        adminEmail:'rehearsal@example.test',release:sourceRelease,tlsCertFile:certificate,tlsKeyFile:privateKey,ragDefaultQuotaBytes:2*1024**2,ragMaxQuotaBytes:8*1024**2},directory);
    const override=path.join(fixture,name+'.yml');
    // Старые приложения получают текущую неизменную топологию; read-only collector использует новый каталог.
    await writeFile(override,'services:\n  frontend:\n    ports: !reset []\n  capacity-collector:\n    image: '+targetImages['catalog-service']+'\n',{mode:0o600});
    const options={directory,projectName,files:[override]};const side={...options,client:composeClient(options),name};sides.push(side);return side;
}
async function query(side,database,input){
    const id=await side.client.run(['ps','-q','postgres']);
    assert.match(id,/^[a-f0-9]{12,64}$/);
    return docker(['exec','-i',id,'psql','-X','-qAt','-U','nc_owner','-d',database,'-v','ON_ERROR_STOP=1'],{input});
}
async function up(side,client=side.client){
    await client.run(['up','-d','--no-build','--pull','never','--wait',...applicationServices,'capacity-collector']);
}
async function pause(side,client=side.client){await client.run(['stop','--timeout','45',...applicationServices]);}
async function fingerprint(side){
    const result={};
    const databases=JSON.parse(await query(side,'postgres',"SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE datname IN ('catalog','rag') OR datname ~ '^nc_rag_[a-f0-9]{32}$';"));
    for(const database of databases)result[database]=await captureMigrationState(sql=>query(side,database,sql));
    return result;
}
async function assertPreserved(side,before,{migrated=false}={}){
    if(!migrated){assert.deepEqual(await fingerprint(side),before);return;}
    const databases=JSON.parse(await query(side,'postgres',"SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE datname IN ('catalog','rag') OR datname ~ '^nc_rag_[a-f0-9]{32}$';"));
    assert.deepEqual(databases,Object.keys(before));
    for(const database of databases)await assertMigrationStatePreserved(sql=>query(side,database,sql),before[database],{requireReceiptMigration:true});
}
async function assertTargetSchemas(side,client){
    const schemas=await runSchemaCommands(client,'check');
    for(const result of Object.values(schemas)){assert.equal(result.ready,true);assert.deepEqual(result.pending,[]);}
    for(const [service,table] of [['catalog-service','catalog_schema_migrations'],['feature-flags-service','feature_flags_schema_migrations']]){
        const rows=JSON.parse(await query(side,'catalog',`SELECT coalesce(json_agg(json_build_object('version',version,'name',name,'checksum',checksum) ORDER BY version),'[]'::json) FROM ${table}`));
        assert.deepEqual(rows,targetSchemaManifests[service]);
    }
}
async function filesFingerprint(side){
    const projects=JSON.parse(await side.client.run(['exec','-T','catalog-service','node','-e',fileScript]));
    const skills=await side.client.run(['exec','-T','skills-service','node','-e',"const fs=require('fs'),crypto=require('crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync('/app/data/skills/update-fixture.md')).digest('hex'));"]);
    return {projects,skills};
}
async function verifyFilesOffline(side){
    const config=await composeConfiguration(side.client);
    const names=Object.fromEntries(['skills','projects','backups','runtime-artifacts'].map(key=>[key,config.volumes[key].name]));
    await volumeTransfer('verify',originalBackup.destination,names,sourceImages['catalog-service']);
}
async function restore(side){
    const before=Date.now();const receipt=await restoreProduction({...side,source:originalBackup.destination,expectedHash:originalBackup.sha256});
    timings[side.name+'RestoreMs']=Date.now()-before;assert.equal(receipt.applicationsStarted,false);return receipt;
}
async function cleanupSide(side){
    assert.match(side.projectName,/^nc-update-(?:source|manual|rollback)-[a-f0-9]{8}$/);
    await side.client.run(['down','--volumes','--remove-orphans']);
    assert.equal((await containers(side.client)).length,0);side.cleaned=true;
}
try{
    await check('Исходный 0.9 и новый P0 закреплены семью настоящими image ID',async()=>{
        const inspect=async release=>Object.fromEntries(await Promise.all(applicationServices.map(async service=>{
            const [image]=JSON.parse(await docker(['image','inspect','neurocenter/'+service+':'+release]));assert.match(image.Id,/^sha256:[a-f0-9]{64}$/);return [service,image.Id];
        })));
        [sourceImages,targetImages]=await Promise.all([inspect(sourceRelease),inspect(targetRelease)]);
        assert.ok(applicationServices.some(service=>sourceImages[service]!==targetImages[service]));
        targetSchemaManifests=await inspectSchemaManifests(targetImages,docker);
        postgresImage=JSON.parse(await docker(['image','inspect','pgvector/pgvector:pg16@sha256:ad2e18408bf447f62092a8a5259e7df10505c5a0360bd1a1853ac8b8b0763da2']))[0].Id;
    });
    const source=await createSide('source');
    await check('Собственный source-кластер 0.9 запускается без dev-auth и без чужих томов',async()=>{
        await source.client.run(['up','-d','--no-build','--pull','never','--wait','postgres']);
        await source.client.run(['--profile','setup','run','--rm','database-init']);
        await source.client.run(['--profile','setup','run','--rm','bootstrap-admin']);
        await up(source);await recordProductionHealth(source.client,stage,'update-source-ready');
    });
    await check('Синтетические настройки, JSONB-активы, проектная БД и четыре тома создаются только в source',async()=>{
        await query(source,'catalog',`SET ROLE nc_catalog;
            INSERT INTO projects(id,name,retention,quota,rag_project_key) VALUES(${sqlQuote(projectId)},${sqlQuote(marker)},47,'{"fixture":true,"limit":2048}',${sqlQuote(projectId)});
            INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES(${sqlQuote(projectId)},'fixture-user','rehearsal@example.test','Синтетический администратор','Админ проекта');
            INSERT INTO ai_plugins(id,name,kind,description,config) VALUES('fixture-mcp',${sqlQuote(marker+' MCP')},'mcp','Не запускается в репетиции','{"transport":"remote","url":"https://example.test/mcp","fixture":true}');
            INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by) VALUES(${sqlQuote(projectId)},'fixture-mcp','mcp','rehearsal@example.test');
            CREATE TABLE maintenance_settings(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),policy jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE maintenance_runs(id uuid PRIMARY KEY,slot text NOT NULL,policy_revision integer NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,state text NOT NULL CHECK(state IN ('running','failed','succeeded')),error_code text,receipt jsonb);
            INSERT INTO maintenance_settings(singleton,revision,policy) VALUES(true,7,${sqlQuote(JSON.stringify(fixturePolicy))}::jsonb);
            INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state) VALUES(${sqlQuote(randomUUID())}::uuid,'fixture:operator','maintenance.policy.update','maintenance',null,'{"revision":7}');
        `);
        await query(source,'postgres',`CREATE DATABASE ${projectDatabase} OWNER nc_rag TEMPLATE nc_rag_template; REVOKE ALL ON DATABASE ${projectDatabase} FROM PUBLIC; GRANT CONNECT ON DATABASE ${projectDatabase} TO nc_backup;`);
        await query(source,projectDatabase,`SET ROLE nc_rag; CREATE TABLE update_fixture_note(id text PRIMARY KEY,payload jsonb); INSERT INTO update_fixture_note VALUES('fixture','{"knowledge":"Сохранить после обновления","revision":5}');`);
        await query(source,'rag',`SET ROLE nc_rag; INSERT INTO neurocenter_project_databases(project_id,database_name,migrated) VALUES(${sqlQuote(projectId)},${sqlQuote(projectDatabase)},true);`);
        await source.client.run(['exec','-T','rag-sync-service','node','-e',`(async()=>{const fs=require('fs');const {RagDb}=require('/app/dist/rag/rag-db.js');const url=new URL(fs.readFileSync(process.env.RAG_PG_URL_FILE,'utf8').trim());url.pathname=${JSON.stringify(projectDatabase)};const db=new RagDb({url:url.toString(),dim:2560});try{await db.setup();await db.applyDelta(${JSON.stringify(projectId)},[{id:'fixture-knowledge',filePath:'Знания.md',content:'Синтетические знания полного обновления',description:null,startLine:null,endLine:null,language:null,kind:'text',role:null,quirkType:null,tags:null,contentHash:${JSON.stringify(hash('Синтетические знания полного обновления'))},embedding:null}],[]);}finally{await db.close();}})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});`]);
        await source.client.run(['exec','-T','catalog-service','node','-e',`const fs=require('fs');fs.mkdirSync('/data/projects/update-fixture',{recursive:true});fs.writeFileSync('/data/projects/update-fixture/настройки.json',JSON.stringify({fixture:${JSON.stringify(marker)},revision:11}));fs.writeFileSync('/app/backups/update-fixture.txt','Синтетическая сохранённая копия');`]);
        await source.client.run(['exec','-T','skills-service','node','-e',"require('fs').writeFileSync('/app/data/skills/update-fixture.md','# Синтетический скилл\\nНе потерять при обновлении.');"]);
        artifact=await seedProductionRuntimeArtifact(source.client,run);
    });
    const before=await fingerprint(source),beforeFiles=await filesFingerprint(source),sourceEnv=await readFile(path.join(source.directory,'.env'),'utf8');
    await check('Полный согласованный комплект 0.9 проверяется перед созданием репетиции',async()=>{
        originalBackup=await backupProduction({...source,destination:path.join(copies,'source-complete'),offline:true,maxPauseMs:900000});
        const manifest=await verifyBackup(originalBackup.destination,originalBackup.sha256);assert.equal(manifest.databases.length,3);assert.equal(manifest.format,'neurocenter-recovery-v4');
        assert.deepEqual(await fingerprint(source),before);await pause(source);
    });
    const manual=await createSide('manual'),manualEnv=await readFile(path.join(fixture,'manual/.env'),'utf8');await check('Репетиция начинается восстановлением копии в новый отдельный проект',async()=>{
        await restore(manual);await up(manual);assert.deepEqual(await fingerprint(manual),before);assert.deepEqual(await filesFingerprint(manual),beforeFiles);await verifyProductionRuntimeArtifact(manual.client,artifact);
    });
    const pinned=path.join(fixture,'manual-target.compose.json');
    await writeJson(pinned,{services:Object.fromEntries([...applicationServices,'capacity-collector'].map(service=>[service,{image:targetImages[service==='capacity-collector'?'catalog-service':service]}]))});
    const manualTarget=composeClient({...manual,files:[...manual.files,pinned],release:targetRelease});
    await check('Настоящий переход 0.9 → P0 на копии сохраняет все строки, настройки и файлы',async()=>{
        await pause(manual);const beforeTime=Date.now();await runSchemaCommands(manualTarget,'migrate');await up(manual,manualTarget);timings.manualUpgradeMs=Date.now()-beforeTime;
        await recordProductionHealth(manualTarget,stage,'update-manual-target-ready');await assertPreserved(manual,before,{migrated:true});await assertTargetSchemas(manual,manualTarget);assert.deepEqual(await filesFingerprint(manual),beforeFiles);await verifyProductionRuntimeArtifact(manualTarget,artifact);
        assert.equal(await readFile(path.join(manual.directory,'.env'),'utf8'),manualEnv);
    });
    await check('Повторный запуск и рестарт настоящих catalog/RAG не повторяют миграции и не сбрасывают настройки',async()=>{
        await manualTarget.run(['restart','catalog-service','rag-sync-service']);await up(manual,manualTarget);
        await assertPreserved(manual,before,{migrated:true});await assertTargetSchemas(manual,manualTarget);assert.deepEqual(await filesFingerprint(manual),beforeFiles);await pause(manual,manualTarget);await verifyFilesOffline(manual);await cleanupSide(manual);
    });
    const rollback=await createSide('rollback');
    await check('Возврат выполняется restore исходного комплекта в новый проект с прежними образами',async()=>{
        await restore(rollback);await up(rollback);await recordProductionHealth(rollback.client,stage,'update-rollback-ready');assert.deepEqual(await fingerprint(rollback),before);assert.deepEqual(await filesFingerprint(rollback),beforeFiles);
        await verifyProductionRuntimeArtifact(rollback.client,artifact);await pause(rollback);await verifyFilesOffline(rollback);await cleanupSide(rollback);
    });
    const rehearsalFile=path.join(fixture,'rehearsal.json');
    await check('Успешная квитанция репетиции появляется только после реального обновления и обратного restore',async()=>{
        rehearsalReport={format:'neurocenter-update-rehearsal-v1',passed:true,copyOfData:true,settingsPreserved:true,repeatSafe:true,restoreVerified:true,
            sourceImages,targetImages,postgresImage,sourceRelease,targetRelease,realBlitz:false,syntheticDataOnly:true,checkedAt:new Date().toISOString(),sourceBackupSha256:originalBackup.sha256,sourceBackupBytes:originalBackup.bytes,timings,proofCases:cases.map(item=>item.name)};
        await writeJson(rehearsalFile,rehearsalReport);
    });
    const migrations=targetSchemaManifests['catalog-service'];
    const plan={format:'neurocenter-update-v1',id:'rehearsal-'+run,sourceRelease,targetRelease,sourceImages,targetImages,postgresImage,catalogMigrations:migrations,
        migrationCompatibility:'restore-required',rollback:'restore-new-project',rehearsalSha256:hash(await readFile(rehearsalFile)),maxPauseMs:900000};
    await writeJson(path.join(fixture,'plan.json'),plan);
    const options={...source,plan,rehearsalFile,backupDestination:path.join(copies,'before-orchestrated-update')};
    await up(source);
    await check('Неизменённый production preflight отвергает ложную SHA-квитанцию и принимает настоящую',async()=>{
        await assert.rejects(updateProduction({...options,plan:{...plan,rehearsalSha256:'0'.repeat(64)},execute:false}),/SHA256/);
        assert.equal((await updateProduction({...options,execute:false})).dryRun,true);
    });
    await check('Настоящий updateProduction создаёт новую копию, меняет семь образов и сохраняет настройки',async()=>{
        const beforeTime=Date.now();updateReceipt=await updateProduction({...options,execute:true});timings.orchestratedUpdateMs=Date.now()-beforeTime;
        assert.equal(updateReceipt.state,'completed');assert.equal(updateReceipt.repeated,false);await verifyBackup(updateReceipt.backup.destination,updateReceipt.backup.sha256);
        const targetClient=composeClient({...source,files:[...source.files,path.join(source.directory,'updates',plan.id+'.compose.json')],release:targetRelease});
        await recordProductionHealth(source.client,stage,'update-orchestrated-target-ready');await assertPreserved(source,before,{migrated:true});await assertTargetSchemas(source,targetClient);assert.deepEqual(await filesFingerprint(source),beforeFiles);await verifyProductionRuntimeArtifact(source.client,artifact);
        const afterEnv=await readFile(path.join(source.directory,'.env'),'utf8');assert.equal(afterEnv.replace("NEUROCENTER_RELEASE='"+targetRelease+"'","NEUROCENTER_RELEASE='"+sourceRelease+"'"),sourceEnv);
    });
    await check('Повтор production update не делает новую копию и не повторяет операции',async()=>{
        const copiesBefore=(await readdir(copies)).sort(),beforeRepeat=await fingerprint(source),completedAt=updateReceipt.completedAt;
        const result=await updateProduction({...options,execute:true});assert.equal(result.repeated,true);assert.equal(result.completedAt,completedAt);
        assert.deepEqual((await readdir(copies)).sort(),copiesBefore);assert.deepEqual(await fingerprint(source),beforeRepeat);
    });
}catch(error){
    fatal=error.message;const diagnostic=await saveDiagnostic(error,fixture).catch(()=>undefined);if(diagnostic){fatal+='; private diagnostic saved';}
    console.error('FAIL isolated update rehearsal: '+fatal);process.exitCode=1;
}finally{
    for(const side of [...sides].reverse()){
        if(side.cleaned){continue;}
        try{await side.client.run(['logs','--no-color']).then(value=>writeFile(path.join(fixture,side.name+'.log'),value,{mode:0o600}));}catch{}
        try{await cleanupSide(side);}catch(error){fatal=(fatal?fatal+'; ':'')+'cleanup failed for '+side.projectName;process.exitCode=1;}
    }
    const result={checkedAt:new Date().toISOString(),startedAt,passed:cases.length,cases,fatal:fatal||null,sourceRelease,targetRelease,sourceImages,targetImages,postgresImage,timings,
        realBlitz:false,authenticatedSmoke:false,syntheticDataOnly:true,productionDataTouched:false,sourceBackup:originalBackup||null,updateReceipt:updateReceipt||null,
        rehearsalReport:rehearsalReport?{passed:rehearsalReport.passed,copyOfData:true,settingsPreserved:true,repeatSafe:true,restoreVerified:true}:null,
        cleanup:{allOwnStacksRemoved:sides.every(side=>side.cleaned),projects:sides.map(side=>side.projectName),globalPrune:false}};
    await writeJson(path.join(stage,'update-stack.json'),result);if(fatal){await writeJson(path.join(stage,'update-stack.failed-'+run+'.json'),result);}
    console.log(JSON.stringify({passed:cases.length,fatal:fatal||null,realBlitz:false,sourceRelease,targetRelease,allOwnStacksRemoved:result.cleanup.allOwnStacksRemoved}));
}
