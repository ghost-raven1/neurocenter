import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdir,readFile,writeFile,rm,cp,readdir,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {configureProduction} from '../production/configuration.mjs';
import {composeClient,composeConfiguration,containers,docker,repositoryRoot,maintenanceLock} from '../production/compose-client.mjs';
import {backupProduction,restoreProduction} from '../production/recovery.mjs';
import {verifyBackup} from '../production/recovery-manifest.mjs';
import {seedProductionRuntimeArtifact,verifyProductionRuntimeArtifact} from './production-runtime-artifact.fixture.mjs';
import {recordProductionHealth} from './production-health.fixture.mjs';

const stage=path.resolve(repositoryRoot,process.env.NEUROCENTER_TEST_EVIDENCE||'.run/production-stage-2');await mkdir(stage,{recursive:true,mode:0o700});
const run=randomUUID().slice(0,8);const directory=path.join(stage,'fixture',run);await mkdir(directory,{recursive:true,mode:0o700});
const certFile=path.join(directory,'tls.crt');const keyFile=path.join(directory,'tls.key');
if(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=panel.test','-addext','subjectAltName=DNS:panel.test,DNS:blitz.test,IP:127.0.0.1'],{stdio:'ignore'}).status!==0){throw new Error('Нужен openssl');}
const ca=await readFile(certFile);const passed=[];let receipt;let restoreReceipt;let project;let skill;let plugin;let projectBackup;let fingerprint;let recoveryStartedAt;let applicationReadyMs;let runtimeArtifact;let maintenanceSettings;
async function check(name,action){await action();passed.push(name);console.log('OK '+name);}
const projectDatabase=id=>'nc_rag_'+createHash('sha256').update(id).digest('hex').slice(0,32);
const sides=[];
for(const [side,frontPort,blitzPort] of [['source',18445,18447],['target',18446,18448]]){
    const projectName='nc-dr-'+side+'-'+run;const configDirectory=path.join(directory,side);
    await configureProduction({panelUrl:'https://panel.test',ssoHost:'https://blitz.test',ssoClientId:'fixture-client',ssoClientSecret:'fixture-only',adminEmail:'admin@example.test',release:process.env.NEUROCENTER_TEST_RELEASE||'verify-20261017',tlsCertFile:certFile,tlsKeyFile:keyFile},configDirectory);
    const override=path.join(directory,side+'.yml');
    await writeFile(override,`services:
  frontend:
    ports: !override ['127.0.0.1:${frontPort}:8443']
  oauth2-bridge:
    environment:
      NODE_EXTRA_CA_CERTS: /fixture/tls.crt
    volumes: ['${certFile}:/fixture/tls.crt:ro']
  blitz-fixture:
    image: node:24.22.0-bookworm-slim
    command: [node, /fixture/provider.cjs]
    networks:
      backend:
        aliases: [blitz.test]
    ports: ['127.0.0.1:${blitzPort}:443']
    volumes:
      - '${certFile}:/fixture/tls.crt:ro'
      - '${keyFile}:/fixture/tls.key:ro'
      - '${repositoryRoot}/scripts/test/blitz-provider.fixture.cjs:/fixture/provider.cjs:ro'
`);
    const options={directory:configDirectory,projectName,files:[override]};sides.push({...options,client:composeClient(options),frontPort,blitzPort,cookie:''});
}
const [source,target]=sides;
async function request(side,route,{method='GET',body}={}){
    const url=new URL(route,'https://panel.test');const encoded=body===undefined?undefined:JSON.stringify(body);
    return new Promise((resolve,reject)=>{
        const req=https.request({hostname:'127.0.0.1',port:url.hostname==='blitz.test'?side.blitzPort:side.frontPort,servername:url.hostname,ca,path:url.pathname+url.search,method,headers:{Host:url.hostname,Cookie:side.cookie,...(encoded?{'Content-Type':'application/json','X-Neurocenter-Request':'1',Origin:'https://panel.test'}:{})}},res=>{
            let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(raw);}catch{data=raw;}resolve({status:res.statusCode,headers:res.headers,data});});
        });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('HTTP timeout')));req.end(encoded);
    });
}
async function call(side,method,route,body,expected=200){const response=await request(side,route,{method,body});assert.equal(response.status,expected,method+' '+route+': '+JSON.stringify(response.data));return response.data;}
async function login(side){
    const first=await request(side,'/auth/login');assert.equal(first.status,302);side.cookie=first.headers['set-cookie'].find(value=>value.startsWith('oauth_state=')).split(';')[0];
    const authorize=await request(side,first.headers.location);assert.equal(authorize.status,302);const callback=await request(side,authorize.headers.location);assert.equal(callback.status,302);
    side.cookie=callback.headers['set-cookie'].find(value=>value.startsWith('bridge_session=')).split(';')[0];assert.equal((await call(side,'GET','/auth/me')).user.activeRole,'Главный админ');
}
async function query(side,database,text){return docker(['exec','-i',await side.client.run(['ps','-q','postgres']),'psql','-X','-U','nc_owner','-d',database,'-v','ON_ERROR_STOP=1','-At'],{input:text});}
async function dataFingerprint(side){
    const databases=JSON.parse(await query(side,'postgres',"SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE datname IN ('catalog','rag') OR datname ~ '^nc_rag_[a-f0-9]{32}$';"));const result={};
    for(const database of databases){
        const tables=JSON.parse(await query(side,database,"SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public';"));result[database]={};
        for(const table of tables){
            assert.match(table,/^[a-z_]+$/);
            // Одноразовые коды и online очищаются при restore; остальные данные сравниваются полностью.
            const row=table==='bridge_devices'?"to_jsonb(t)-'last_seen'":'row_to_json(t)';
            const data=table==='bridge_pairs'?'[]':await query(side,database,`SELECT coalesce(json_agg(${row} ORDER BY (${row})::text),'[]'::json) FROM ${table} t;`);
            result[database][table]=createHash('sha256').update(data).digest('hex');
        }
    }return result;
}
try{
    await rm(path.join(stage,'recovery-stack.json'),{force:true});
    await source.client.run(['up','-d','--wait','postgres','blitz-fixture']);await source.client.run(['--profile','setup','run','--rm','database-init']);await source.client.run(['--profile','setup','run','--rm','bootstrap-admin']);await source.client.run(['up','-d','--wait']);await login(source);
    await recordProductionHealth(source.client,stage,'source-services-ready');
    await check('Готовый комплект импортируется операторским сервисом в отдельный production-том и PostgreSQL',async()=>{
        runtimeArtifact=await seedProductionRuntimeArtifact(source.client,run);
    });
    await check('Два проекта, отдельные знания, роли, MCP-пакет и Markdown создаются в production-стеке',async()=>{
        project=await call(source,'POST','/api/projects',{name:'Проверка полного восстановления'},201);const second=await call(source,'POST','/api/projects',{name:'Второй восстановленный проект'},201);
        for(const item of [project,second]){await call(source,'POST','/api/rag/sync',{projectKey:item.id,chunks:[{id:'knowledge-'+item.id,filePath:'Документ.md',content:'Уникальные знания '+item.name,embedding:null}]},201);}
        await call(source,'POST','/api/projects/'+project.id+'/members',{principalName:'admin@example.test',role:'Админ проекта'},201);
        skill=await call(source,'POST','/api/skills',{path:'project-'+project.id,slug:'recovery-guide',name:'Инструкция восстановления',body:'Не потерять знания команды.',meta:{description:'Проверочный Markdown'}},201);
        plugin=await call(source,'POST','/api/ai-plugins',{publicationKey:randomUUID(),name:'MCP для восстановления',kind:'mcp',description:'Проверяем JSONB и готовый платформенный комплект',config:{transport:'stdio',command:'node',entrypoint:runtimeArtifact.entrypoint,extra:{runtimeArtifacts:[runtimeArtifact]}},files:[]},201);
        projectBackup=await call(source,'POST','/api/projects/'+project.id+'/backups',{},201);assert.ok(projectBackup.sizeBytes>0);
        await source.client.run(['exec','-T','catalog-service','node','-e',"const fs=require('fs');fs.mkdirSync('/data/projects/fixture',{recursive:true});fs.writeFileSync('/data/projects/fixture/данные.txt','Серверные файлы проекта');"]);
        // Осиротевшая база не удаляется штатным DELETE проекта и тоже должна попасть в DR.
        const orphan='nc_rag_'+'f'.repeat(32);await query(source,'postgres',`CREATE DATABASE ${orphan} OWNER nc_rag TEMPLATE nc_rag_template; REVOKE ALL ON DATABASE ${orphan} FROM PUBLIC; GRANT CONNECT ON DATABASE ${orphan} TO nc_backup;`);await query(source,orphan,"CREATE TABLE retained_note (content text); INSERT INTO retained_note VALUES ('Сохранить базу удалённого проекта');");
        await query(source,'catalog',"INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,last_seen) VALUES ('dr-retained-device','admin@example.test','Главный админ','Компьютер тестового восстановления','fixture-retained','fixture-retained',now()); INSERT INTO bridge_pairs(code_hash,user_code,name,fingerprint) VALUES ('fixture-pair','FIXTURE','Тестовый запрос подключения','fixture-pair');");
        fingerprint=await dataFingerprint(source);
    });
    await check('Настройки обслуживания с часовым поясом и аудитом входят в исходный комплект',async()=>{
        const current=await call(source,'GET','/api/maintenance/policy');
        maintenanceSettings=await call(source,'PATCH','/api/maintenance/policy',{expectedRevision:current.revision,policy:{...current.policy,timeZone:'Asia/Tomsk',localCopies:7,rpoMinutes:720,rtoMinutes:180}});
        assert.equal(maintenanceSettings.revision,1);assert.equal(await query(source,'catalog',"SELECT count(*) FROM security_events WHERE action='maintenance.policy.update' AND actor='admin@example.test'"),'1');
    });
    let savedQuota;
    await check('Изменённый лимит, счётчик, миграция и аудит включаются в полный комплект',async()=>{
        const quota=await call(source,'GET','/api/rag/quota?projectKey='+project.id);
        savedQuota=await call(source,'PATCH','/api/rag/quota',{projectKey:project.id,limitBytes:2048,expectedRevision:quota.revision});
        assert.equal(savedQuota.revision,1);fingerprint=await dataFingerprint(source);
    });
    await source.client.run(['stop','blitz-fixture']);
    const backupRoot=path.join(directory,'copies');await mkdir(backupRoot,{mode:0o700});const destination=path.join(backupRoot,'complete');
    await check('Одновременные операции блокируются на Docker daemon до остановки приложений',async()=>{
        const config=await composeConfiguration(source.client);await maintenanceLock(source.client,config.services['catalog-service'].image,'fixture',async()=>{
            await assert.rejects(backupProduction({...source,destination,offline:true}),/блокировку/);assert.equal((await request(source,'/ready')).status,200);
        });
    });
    await check('Подмена имени тома в Compose отклоняется до остановки и не создаёт пустую замену',async()=>{
        const changed=path.join(directory,'wrong-volume.yml');await writeFile(changed,`volumes:\n  skills:\n    name: ${source.projectName}_wrong_skills\n`);
        await assert.rejects(backupProduction({...source,files:[...source.files,changed],destination,offline:true}),/Тома рабочего/);assert.equal((await request(source,'/ready')).status,200);
        assert.ok(!(await docker(['volume','ls','--format','{{.Name}}'])).includes(source.projectName+'_wrong_skills'));
    });
    await check('Копирование ждёт завершения заданий MCP и не обрывает локальную операцию',async()=>{
        await query(source,'catalog',"INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES ('dr-busy-device','admin@example.test','Главный админ','Тестовый MCP','fixture','fixture'); INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash) VALUES ('dr-busy-job','dr-busy-device','admin@example.test','Главный админ','install','{}','fixture','fixture');");
        try{await assert.rejects(backupProduction({...source,destination,offline:true}),/незавершённые задания/);assert.equal((await request(source,'/ready')).status,200);}
        finally{await query(source,'catalog',"DELETE FROM bridge_jobs WHERE id='dr-busy-job'; DELETE FROM bridge_devices WHERE id='dr-busy-device';");}
    });
    await check('Незавершённая API-копия блокирует DR до остановки приложений',async()=>{
        await source.client.run(['exec','-T','catalog-service','node','-e',"const fs=require('fs');fs.mkdirSync('/app/backups/.neurocenter-backup.lock');fs.writeFileSync('/app/backups/.neurocenter-backup.lock/owner','fixture');"]);
        try{await assert.rejects(backupProduction({...source,destination,offline:true}),/незавершённая резервная копия/);assert.equal((await request(source,'/ready')).status,200);}
        finally{await source.client.run(['exec','-T','catalog-service','node','-e',"require('fs').rmSync('/app/backups/.neurocenter-backup.lock',{recursive:true});"]);}
    });
    await check('Оставшийся partial не публикуется в DR, приложения возвращаются в работу',async()=>{
        await source.client.run(['exec','-T','catalog-service','node','-e',"require('fs').writeFileSync('/app/backups/fixture.dump.partial','PGDMPнезавершённая копия');"]);
        const failed=path.join(backupRoot,'incomplete');
        try{await assert.rejects(backupProduction({...source,destination:failed,offline:true}));assert.equal((await request(source,'/ready')).status,200);assert.ok(!(await readdir(backupRoot)).some(name=>name.startsWith('incomplete')));}
        finally{await source.client.run(['exec','-T','catalog-service','node','-e',"require('fs').unlinkSync('/app/backups/fixture.dump.partial');"]);}
    });
    await check('Копия включает все пять БД, Markdown, серверные файлы и проектный pg_dump',async()=>{
        receipt=await backupProduction({...source,destination,offline:true,progress:console.log});
        assert.equal(receipt.databases,5);const manifest=await verifyBackup(destination,receipt.sha256);assert.ok(manifest.entries.some(entry=>entry.path==='files/skills/'+skill.path+'.md'));assert.ok(manifest.entries.some(entry=>entry.path.includes(projectBackup.fileName)));assert.ok(manifest.entries.some(entry=>entry.path.endsWith('данные.txt')));
        assert.equal((await request(source,'/ready')).status,200);assert.deepEqual(await dataFingerprint(source),fingerprint);
        const raw=await readFile(path.join(destination,'manifest.json'),'utf8');for(const name of ['catalog_url','postgres_password','internal_token']){assert.ok(!raw.includes((await readFile(path.join(source.directory,'secrets',name),'utf8')).trim()));}
    });
    await check('Опись DR v2 включает четвёртый том и точный SHA готового комплекта',async()=>{
        const manifest=await verifyBackup(destination,receipt.sha256);assert.equal(manifest.format,'neurocenter-recovery-v3');
        for(const volume of ['skills','projects','backups','runtime-artifacts'])assert.ok(manifest.entries.some(entry=>entry.path==='files/'+volume&&entry.type==='directory'));
        const archive=manifest.entries.find(entry=>entry.path==='files/runtime-artifacts/'+runtimeArtifact.sha256+'.tar.gz');
        assert.equal(archive?.type,'file');assert.equal(archive.sha256,runtimeArtifact.sha256);assert.equal(archive.size,runtimeArtifact.compressedBytes);
    });
    await check('Другой образ приложения блокирует restore до создания target-томов',async()=>{
        const config=await composeConfiguration(source.client);
        const changed=path.join(directory,'wrong-image.yml');await writeFile(changed,`services:\n  catalog-service:\n    image: ${config.services.frontend.image}\n`);
        await assert.rejects(restoreProduction({...target,files:[...target.files,changed],source:destination,expectedHash:receipt.sha256}),/те же образы/);assert.equal((await containers(target.client)).length,0);
    });
    await check('Повторная копия не перезаписывает сохранённый комплект',async()=>{await assert.rejects(backupProduction({...source,destination,offline:true}),/уже существует/);assert.equal((await request(source,'/ready')).status,200);});
    await check('Повреждённый комплект отклоняется до создания target-томов',async()=>{
        const damaged=path.join(backupRoot,'damaged');await cp(destination,damaged,{recursive:true});await writeFile(path.join(damaged,'databases/rag.dump'),'truncated');
        await assert.rejects(restoreProduction({...target,source:damaged,expectedHash:receipt.sha256}),/описи/);assert.equal((await containers(target.client)).length,0);
        const allVolumes=(await docker(['volume','ls','--format','{{.Name}}'])).split('\n');assert.ok(!allVolumes.some(name=>name.startsWith(target.projectName+'_')));
    });
    await check('Подмена готового runtime-архива отклоняется до создания target-кластера',async()=>{
        const damaged=path.join(backupRoot,'damaged-runtime');await cp(destination,damaged,{recursive:true});
        const archive=path.join(damaged,'files/runtime-artifacts',runtimeArtifact.sha256+'.tar.gz');await chmod(archive,0o600);await writeFile(archive,'truncated-runtime');
        await assert.rejects(restoreProduction({...target,source:damaged,expectedHash:receipt.sha256}),/описи/);assert.equal((await containers(target.client)).length,0);
        assert.ok(!(await docker(['volume','ls','--format','{{.Name}}'])).split('\n').some(name=>name.startsWith(target.projectName+'_')));
    });
    await check('Полный restore в чистый кластер работает с новыми паролями ролей',async()=>{
        recoveryStartedAt=Date.now();restoreReceipt=await restoreProduction({...target,source:destination,expectedHash:receipt.sha256,progress:console.log});assert.equal(restoreReceipt.applicationsStarted,false);assert.equal(restoreReceipt.databases,5);assert.deepEqual(await dataFingerprint(target),fingerprint);
        const states=await containers(target.client);assert.ok(states.filter(item=>item.Config.Labels['com.docker.compose.service']!=='postgres').every(item=>!item.State.Running));
    });
    await check('После переноса сохранены устройства, но старые коды и ложный online сброшены',async()=>{
        assert.equal(await query(source,'catalog','SELECT count(*) FROM bridge_pairs;'),'1');assert.equal(await query(target,'catalog','SELECT count(*) FROM bridge_pairs;'),'0');
        assert.equal(await query(target,'catalog',"SELECT count(*) FROM bridge_devices WHERE id='dr-retained-device' AND last_seen IS NULL AND NOT revoked;"),'1');
    });
    await check('Восстановленный стек принимает Blitz-вход и отдаёт проекты, знания, скилл и пакет',async()=>{
        await target.client.run(['up','-d','--wait']);await login(target);applicationReadyMs=Date.now()-recoveryStartedAt;
        await recordProductionHealth(target.client,stage,'target-services-ready');
        assert.equal((await call(target,'GET','/api/projects/'+project.id)).name,project.name);assert.equal((await call(target,'GET','/api/rag/manifest?projectKey='+project.id)).count,1);
        assert.equal((await call(target,'GET','/api/skills/'+skill.path)).body,skill.body);assert.equal((await call(target,'GET','/api/ai-plugins/'+plugin.id)).name,plugin.name);
        assert.equal((await call(target,'GET','/api/projects/'+project.id+'/members'))[0].role,'Админ проекта');
        assert.ok((await call(target,'GET','/api/projects/'+project.id+'/backups')).some(item=>item.id===projectBackup.id));
        assert.equal(await target.client.run(['exec','-T','catalog-service','node','-e',"console.log(require('fs').readFileSync('/data/projects/fixture/данные.txt','utf8'))"]),'Серверные файлы проекта');
    });
    await check('После полного восстановления сохранены политика, ревизия, аудит и работает новый физический сборщик',async()=>{
        const restored=await call(target,'GET','/api/maintenance/policy');assert.equal(restored.revision,maintenanceSettings.revision);assert.deepEqual(restored.policy,maintenanceSettings.policy);
        assert.equal(await query(target,'catalog',"SELECT count(*) FROM security_events WHERE action='maintenance.policy.update' AND actor='admin@example.test'"),'1');
        const capacity=await call(target,'GET','/api/maintenance/capacity');assert.equal(capacity.available,true);assert.ok(capacity.resources.postgres.freeBytes>0);assert.ok(capacity.resources.wal.walBytes>0);
    });
    await check('Восстановленный готовый комплект читается продуктовым сервисом и совпадает с сохранённым MCP-пакетом',async()=>{
        await verifyProductionRuntimeArtifact(target.client,runtimeArtifact);
        const restored=await call(target,'GET','/api/ai-plugins/'+plugin.id);assert.deepEqual(restored.config.extra.runtimeArtifacts,[runtimeArtifact]);
    });
    await check('После восстановления сохранены квота и ревизия, а триггер отклоняет превышение',async()=>{
        assert.deepEqual(await call(target,'GET','/api/rag/quota?projectKey='+project.id),savedQuota);
        const before=await call(target,'GET','/api/rag/manifest?projectKey='+project.id);
        const rejected=await request(target,'/api/rag/sync',{method:'POST',body:{projectKey:project.id,chunks:[{id:'over-restored-quota',filePath:'x',content:'я'.repeat(10000)}]}});
        assert.equal(rejected.status,413);assert.equal(rejected.data.code,'RAG_QUOTA_EXCEEDED');
        assert.deepEqual(await call(target,'GET','/api/rag/manifest?projectKey='+project.id),before);
        assert.deepEqual(await call(target,'GET','/api/rag/quota?projectKey='+project.id),savedQuota);
    });
    await check('Восстановленный проектный дамп скачивается и права PG сохраняются',async()=>{
        const copy=await request(target,'/api/projects/'+project.id+'/backups/'+projectBackup.id+'/download');assert.equal(copy.status,200);assert.ok(copy.headers['content-disposition']);
        assert.equal(await query(target,'postgres',"SELECT count(*) FROM pg_roles WHERE rolname IN ('nc_catalog','nc_rag','nc_backup','nc_provisioner') AND (rolsuper OR rolcreaterole OR rolbypassrls);"),'0');
        const owner=await query(target,'postgres',`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='${projectDatabase(project.id)}';`);assert.equal(owner,'nc_rag');
    });
    await check('После restore доступны запись знаний и скиллов, новый pg_dump и создание проектной БД',async()=>{
        await call(target,'POST','/api/rag/sync',{projectKey:project.id,chunks:[{id:'after-restore',filePath:'После восстановления.md',content:'Новые знания записываются рабочей ролью',embedding:null}]},201);
        assert.equal((await call(target,'GET','/api/rag/manifest?projectKey='+project.id)).count,2);
        assert.equal((await call(target,'PUT','/api/skills/'+skill.path,{expectedVersion:1,body:'Продолжаем работу после восстановления.'})).body,'Продолжаем работу после восстановления.');
        assert.ok((await call(target,'POST','/api/projects/'+project.id+'/backups',{},201)).sizeBytes>0);
        const next=await call(target,'POST','/api/projects',{name:'Новый проект после восстановления'},201);
        await call(target,'POST','/api/rag/sync',{projectKey:next.id,chunks:[{id:'new-project',filePath:'README.md',content:'Шаблон pgvector работает',embedding:null}]},201);
        assert.equal((await call(target,'GET','/api/rag/manifest?projectKey='+next.id)).count,1);
    });
    await check('Повторный restore отказывается трогать рабочий стек и не отзывает сессию',async()=>{
        const before=await dataFingerprint(target);await assert.rejects(restoreProduction({...target,source:destination,expectedHash:receipt.sha256}),/новый Compose/);assert.equal((await request(target,'/auth/me')).status,200);assert.deepEqual(await dataFingerprint(target),before);
    });
    await check('Ошибка чтения тома не публикует копию и возвращает сервисы в работу',async()=>{
        await source.client.run(['exec','-T','catalog-service','node','-e',"require('fs').symlinkSync('/etc/passwd','/data/projects/forbidden-link')"]);
        const failed=path.join(backupRoot,'failed');try{await assert.rejects(backupProduction({...source,destination:failed,offline:true}));assert.ok(!(await readdir(backupRoot)).some(name=>name==='failed'||name.startsWith('failed.partial-')));assert.equal((await request(source,'/ready')).status,200);}
        finally{await source.client.run(['exec','-T','catalog-service','node','-e',"require('fs').unlinkSync('/data/projects/forbidden-link')"]);}
    });
}catch(error){if(error.diagnostic){await writeFile(path.join(directory,'failed-command.log'),error.diagnostic,{mode:0o600});}throw error;}
finally{
    for(const side of sides){
        await writeFile(path.join(directory,side.projectName+'-services.log'),await side.client.run(['logs','--no-color','--tail','50']).catch(error=>error.message));
        await side.client.run(['down','--volumes','--remove-orphans']);
    }
    await writeFile(path.join(stage,'recovery-stack.json'),JSON.stringify({passed,checks:passed.length,sourceProject:source.projectName,targetProject:target.projectName,receipt,restoreReceipt,applicationReadyMs,runtimeArtifact,realBlitz:false,idp:'local HTTPS Blitz fixture',release:process.env.NEUROCENTER_TEST_RELEASE||'verify-20261017',checkedAt:new Date().toISOString(),maintenanceSettings,fixtureDirectory:directory},null,2)+'\n');
}
console.log(JSON.stringify({passed:passed.length,backupDurationMs:receipt?.durationMs,restoreDurationMs:restoreReceipt?.durationMs}));
