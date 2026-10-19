import assert from 'node:assert/strict';
import https from 'node:https';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {configureProduction,composeEnvironment} from '../production/configuration.mjs';
import {assertBuildDiskSpace} from '../production/build-space.mjs';
import {verifyProductionBackups} from './production-backups.fixture.mjs';
import {verifyProductionSkills,verifyProductionSkillJobs} from './production-skills.fixture.mjs';
import {verifyProductionBridge} from './production-bridge.fixture.mjs';
import {verifyProductionDependencies} from './production-dependencies.fixture.mjs';
import {verifyProductionInspection} from './production-inspection.fixture.mjs';
import {recordProductionHealth} from './production-health.fixture.mjs';
import {verifyProductionMaintenance,verifyProductionMaintenancePermissions,verifyProductionCapacityAdmission} from './production-maintenance.fixture.mjs';
const require=createRequire(new URL('../../frontend/package.json',import.meta.url));
const {io}=require('socket.io-client');
const root=fileURLToPath(new URL('../../',import.meta.url));const project='nc-production-verify-'+randomUUID().slice(0,8);
if(process.argv.includes('--build')){await assertBuildDiskSpace(root);}
const stage=path.resolve(root,process.env.NEUROCENTER_TEST_EVIDENCE||'.run/production-stage-1');
const directory=path.join(stage,'fixture',project);await mkdir(directory,{recursive:true,mode:0o700});
const certificate=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(directory,'tls.key'),'-out',path.join(directory,'tls.crt'),'-days','1','-subj','/CN=panel.test','-addext','subjectAltName=DNS:panel.test,DNS:blitz.test,IP:127.0.0.1'],{stdio:'ignore'});
if(certificate.status!==0){throw new Error('Для тестового TLS нужен openssl');}
await configureProduction({panelUrl:'https://panel.test',ssoHost:'https://blitz.test',ssoClientId:'fixture-client',ssoClientSecret:'fixture-only',adminEmail:'admin@example.test',release:process.env.NEUROCENTER_TEST_RELEASE||'verify-20261017',tlsCertFile:path.join(directory,'tls.crt'),tlsKeyFile:path.join(directory,'tls.key')},path.join(directory,'config'));
await rm(path.join(stage,'production-stack.json'),{force:true});
const override=path.join(directory,'compose.fixture.yml');
await writeFile(override,`services:
  frontend:
    ports: !override ['127.0.0.1:18080:8080', '127.0.0.1:18443:8443']
  oauth2-bridge:
    environment:
      NODE_EXTRA_CA_CERTS: /fixture/tls.crt
    volumes: ['${directory}/tls.crt:/fixture/tls.crt:ro']
  blitz-fixture:
    image: node:24.22.0-bookworm-slim
    command: [node, /fixture/provider.cjs]
    networks:
      backend:
        aliases: [blitz.test]
    ports: ['127.0.0.1:18444:443']
    volumes:
      - '${directory}/tls.crt:/fixture/tls.crt:ro'
      - '${directory}/tls.key:/fixture/tls.key:ro'
      - '${root}/scripts/test/blitz-provider.fixture.cjs:/fixture/provider.cjs:ro'
`);
const composeArgs=['compose','--project-name',project,'--project-directory',root,'--env-file',path.join(directory,'config/.env'),'-f','compose.production.yml','-f',override];
const dockerEnvironment=composeEnvironment();
await writeFile(path.join(directory,'project-name'),project+'\n');
function docker(args){const result=spawnSync('docker',[...composeArgs,...args],{cwd:root,env:dockerEnvironment,encoding:'utf8',maxBuffer:4*1024*1024,timeout:args[0]==='build'?20*60*1000:180000});
    if(args[0]==='build'){writeFileSync(path.join(stage,'build.log'),(result.stdout||'')+'\n'+(result.stderr||''),{mode:0o600});}
    if(result.status!==0){throw new Error('Docker: '+args.slice(0,3).join(' ')+(result.error?.code==='ETIMEDOUT'?' — время ожидания истекло':'')+'\n'+result.stderr);}return result.stdout.trim();}
/** Живой WS-клиент должен отвечать на close frames во время остановки сервера. */
async function dockerAsync(args){return new Promise((resolve,reject)=>{
    const child=spawn('docker',[...composeArgs,...args],{cwd:root,env:dockerEnvironment,stdio:['ignore','pipe','pipe']});let output='';let error='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Docker: время ожидания истекло'));},180000);
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.on('error',failure=>{clearTimeout(timer);reject(failure);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(output.trim()):reject(new Error('Docker: '+args.slice(0,3).join(' ')+'\n'+error));});
});}
const ca=await readFile(path.join(directory,'tls.crt'));
let cookie='';const passed=[];
async function check(name,action){await action();passed.push(name);console.log('OK '+name);}
function request(url,options={}){
    const target=new URL(url,'https://panel.test');assert.ok(['panel.test','blitz.test'].includes(target.hostname));
    const body=options.body===undefined?undefined:JSON.stringify(options.body);
    return new Promise((resolve,reject)=>{
        const req=https.request({hostname:'127.0.0.1',port:target.hostname==='blitz.test'?18444:18443,servername:target.hostname,ca,path:target.pathname+target.search,method:options.method||'GET',headers:{Host:target.hostname,...(target.hostname==='panel.test'?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'X-Neurocenter-Request':'1',Origin:'https://panel.test'}:{}),...options.headers}},res=>{
            let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,headers:res.headers,data});});
        });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error('timeout')));if(body){req.write(body);}req.end();
    });
}
const query=(database,sql)=>docker(['exec','-T','postgres','psql','-U','nc_owner','-d',database,'-v','ON_ERROR_STOP=1','-Atc',sql]);
const internalReady=service=>docker(['exec','-T',service,'node','-e',"fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))"]);
let socket;let stopDurationMs;
async function connectSocket(){
    const client=io('https://127.0.0.1:18443',{transports:['websocket'],ca,rejectUnauthorized:true,extraHeaders:{Cookie:cookie,Origin:'https://panel.test'},reconnection:false});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WebSocket timeout')),8000);client.once('connect',()=>{clearTimeout(timer);resolve();});client.once('connect_error',error=>{clearTimeout(timer);reject(error);});});return client;
}
try{
    if(process.argv.includes('--build')){docker(['build']);}
    docker(['up','-d','--wait','postgres','blitz-fixture']);
    await check('Чистый кластер инициализируется отдельной операторской командой',async()=>{docker(['--profile','setup','run','--rm','database-init']);});
    await check('Первый администратор создаётся один раз без dev-входа',async()=>{
        const first=docker(['--profile','setup','run','--rm','bootstrap-admin']);assert.ok(first.includes('"created":true'));
        const second=docker(['--profile','setup','run','--rm','bootstrap-admin']);assert.ok(second.includes('"created":false'));
    });
    docker(['up','-d','--wait']);
    await recordProductionHealth({run:async args=>docker(args)},stage);
    await check('Финальный Linux-образ загружает LanceDB после удаления dev-зависимостей',async()=>{
        const result=docker(['exec','-T','rag-sync-service','node','-e',"require('/app/mcp/neurocenter-asset-sync/node_modules/@lancedb/lancedb').connect('/tmp/verification-lancedb').then(async db=>console.log(JSON.stringify({ok:true,tables:await db.tableNames()})))"]);assert.deepEqual(JSON.parse(result),{ok:true,tables:[]});
    });
    await check('Production не содержит демопроектов, назначений и скиллов',async()=>{
        assert.equal(query('catalog','SELECT count(*) FROM projects'),'0');assert.equal(query('catalog','SELECT count(*) FROM project_members'),'0');
        assert.equal(docker(['exec','-T','skills-service','node','-e',"console.log(require('fs').readdirSync('/app/data/skills').filter(x=>!x.startsWith('.ready-')).length)"]),'0');
    });
    await check('HTTPS, CSP и HSTS присутствуют, а API без сессии закрыт',async()=>{
        const front=await request('/');assert.equal(front.status,200);assert.ok(front.headers['content-security-policy'].includes("script-src 'self'"));assert.equal(front.headers['strict-transport-security'],'max-age=31536000');assert.equal((await request('/api/projects')).status,401);assert.equal((await request('/api/maintenance/policy')).status,401);assert.equal((await request('/api/maintenance/capacity')).status,401);assert.equal((await request('/ready')).status,200);
    });
    await check('Полный HTTPS-поток Blitz с PKCE возвращает к исходному разделу',async()=>{
        const login=await request('/auth/login?returnTo=%2Fprojects');assert.equal(login.status,302);
        const state=login.headers['set-cookie'].find(item=>item.startsWith('oauth_state='));assert.ok(state.includes('Secure'));cookie=state.split(';')[0];
        const authorize=await request(login.headers.location);assert.equal(authorize.status,302);
        const callback=await request(authorize.headers.location);assert.equal(callback.status,302);assert.equal(callback.headers.location,'https://panel.test/projects');
        cookie=callback.headers['set-cookie'].find(item=>item.startsWith('bridge_session=')).split(';')[0];
        const me=await request('/auth/me');assert.equal(me.status,200);assert.equal(me.data.user.activeRole,'Главный админ');
        assert.ok((await request(authorize.headers.location)).headers.location.endsWith('login_error=state'));
    });
    await verifyProductionMaintenance({check,request,query});
    socket=await connectSocket();
    await verifyProductionBridge({check,request,query});
    await verifyProductionSkills({check,request});
    await check('Метрики всех пяти сервисов доступны только отдельному внутреннему сборщику',async()=>{
        assert.equal((await request('/metrics')).status,404);
        for(const service of ['oauth2-bridge','api-gateway','catalog-service','skills-service','rag-sync-service']){
            const result=JSON.parse(docker(['exec','-T',service,'node','-e',"const fs=require('fs');const url='http://127.0.0.1:'+process.env.PORT+'/metrics';const token=fs.readFileSync(process.env.NEUROCENTER_METRICS_TOKEN_FILE,'utf8').trim();const internal=fs.readFileSync(process.env.NEUROCENTER_INTERNAL_TOKEN_FILE,'utf8').trim();Promise.all([fetch(url),fetch(url,{headers:{authorization:'Bearer '+internal}}),fetch(url,{headers:{authorization:'Bearer '+token}})]).then(async values=>console.log(JSON.stringify({statuses:values.map(r=>r.status),text:await values[2].text()})))"]));
            assert.deepEqual(result.statuses,[403,403,200]);assert.ok(result.text.includes('neurocenter_process_uptime_seconds'));assert.equal(result.text.includes('example.test'),false);
        }
    });
    let projectId;
    await check('Создание проекта отражается через авторизованный WebSocket',async()=>{
        const event=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Нет события раздела')),8000);socket.once('section:changed',data=>{clearTimeout(timer);resolve(data);});});
        const created=await request('/api/projects',{method:'POST',body:{name:'Проверка production'}});assert.equal(created.status,201);projectId=created.data.id;assert.ok(projectId);
        assert.ok((await event).sections.includes('projects'));
    });
    await verifyProductionSkillJobs({check,request,projectId});
    await verifyProductionDependencies({check,request,projectId});
    await verifyProductionInspection({check,request,query,projectId});
    await check('Проектная база создаётся без superuser и хранит синхронизированные данные',async()=>{
        const sync=await request('/api/rag/sync',{method:'POST',body:{projectKey:projectId,chunks:[{id:'fixture-row',filePath:'README.md',content:'Тестовые знания проекта',embedding:null}]}});assert.equal(sync.status,201,JSON.stringify(sync.data));
        const manifest=await request('/api/rag/manifest?projectKey='+projectId);assert.equal(manifest.status,200);assert.equal(manifest.data.count,1);
        const roles=JSON.parse(query('postgres',"SELECT json_agg(json_build_object('name',rolname,'super',rolsuper,'createRole',rolcreaterole,'createDb',rolcreatedb)) FROM pg_roles WHERE rolname IN ('nc_catalog','nc_rag','nc_provisioner','nc_backup')"));
        assert.equal(roles.length,4);for(const role of roles){assert.equal(role.super,false);assert.equal(role.createRole,false);assert.equal(role.createDb,role.name==='nc_provisioner');}
        assert.equal(query('postgres',"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname ~ '^nc_rag_[0-9a-f]{32}$'"),'nc_rag');
    });
    await verifyProductionCapacityAdmission({check,request,docker,projectId});
    const database=query('postgres',"SELECT datname FROM pg_database WHERE datname ~ '^nc_rag_[0-9a-f]{32}$'");
    let quota;
    await check('Действующая квота отражает UTF8-знания и не подменяется размером файлов',async()=>{
        const response=await request('/api/rag/quota?projectKey='+projectId);assert.equal(response.status,200);quota=response.data;
        assert.ok(quota.usedBytes>0);assert.equal(quota.limitBytes,1024**3);assert.equal(quota.availableBytes,quota.limitBytes-quota.usedBytes);
        assert.deepEqual((await request('/api/rag/summary?projectKey='+projectId)).data.quota,quota);
    });
    await check('Изменение квоты сохраняет доверенного автора и обновляет раздел через WebSocket',async()=>{
        const event=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Нет события квоты')),8000);socket.once('section:changed',data=>{clearTimeout(timer);resolve(data);});});
        const saved=await request('/api/rag/quota',{method:'PATCH',headers:{'x-bridge-actor':encodeURIComponent('{"email":"forged@example.test"}')},body:{projectKey:projectId,limitBytes:quota.usedBytes,expectedRevision:quota.revision,actor:'forged@example.test'}});
        assert.equal(saved.status,200,JSON.stringify(saved.data));quota=saved.data;assert.equal(quota.availableBytes,0);assert.ok((await event).sections.includes('knowledge'));
        assert.equal(query(database,"SELECT actor FROM rag_quota_events WHERE before_bytes IS NOT NULL ORDER BY id DESC LIMIT 1"),'admin@example.test');
    });
    await check('HTTP 413 откатывает удаление и новый фрагмент, повтор безопасен',async()=>{
        const before=(await request('/api/rag/manifest?projectKey='+projectId)).data;
        for(let attempt=0;attempt<2;attempt++){
            const failed=await request('/api/rag/sync',{method:'POST',body:{projectKey:projectId,deletes:['fixture-row'],chunks:[{id:'over-limit',filePath:'x.md',content:'я'.repeat(10000),embedding:null}]}});
            assert.equal(failed.status,413,JSON.stringify(failed.data));assert.equal(failed.data.code,'RAG_QUOTA_EXCEEDED');
            assert.deepEqual((await request('/api/rag/manifest?projectKey='+projectId)).data,before);assert.deepEqual((await request('/api/rag/quota?projectKey='+projectId)).data,quota);
        }
    });
    await check('Два администратора с одной ревизией не перезаписывают изменения друг друга',async()=>{
        const replies=await Promise.all([4096,8192].map(limitBytes=>request('/api/rag/quota',{method:'PATCH',body:{projectKey:projectId,limitBytes,expectedRevision:quota.revision}})));
        assert.deepEqual(replies.map(row=>row.status).sort(),[200,409]);quota=replies.find(row=>row.status===200).data;
        const repeated=await request('/api/rag/quota',{method:'PATCH',body:{projectKey:projectId,limitBytes:quota.limitBytes,expectedRevision:quota.revision-1}});assert.equal(repeated.status,200);assert.deepEqual(repeated.data,quota);
    });
    await check('Пустая квота, старый черновик и снижение ниже занятого объёма не меняют данные',async()=>{
        for(const [patch,status] of [[{limitBytes:0,expectedRevision:quota.revision},400],[{limitBytes:quota.usedBytes-1,expectedRevision:quota.revision},409],[{limitBytes:quota.limitBytes+1,expectedRevision:quota.revision-1},409]]){
            assert.equal((await request('/api/rag/quota',{method:'PATCH',body:{projectKey:projectId,...patch}})).status,status);
        }
        assert.deepEqual((await request('/api/rag/quota?projectKey='+projectId)).data,quota);
    });
    await check('Квота защищена активной ролью и назначением на конкретный проект',async()=>{
        assert.equal((await request('/api/projects/'+projectId+'/members',{method:'POST',body:{principalName:'admin@example.test',role:'Админ проекта'}})).status,201);
        for(const role of ['Наблюдатель','Разработчик']){
            const other=await request('/api/projects',{method:'POST',body:{name:'Назначение роли '+role}});assert.equal(other.status,201);
            assert.equal((await request('/api/projects/'+other.data.id+'/members',{method:'POST',body:{principalName:'admin@example.test',role}})).status,201);
        }
        for(const role of ['Наблюдатель','Разработчик','Админ проекта']){
            assert.equal((await request('/auth/switch-role',{method:'POST',body:{role}})).status,200);
            assert.equal((await request('/api/rag/quota?projectKey='+projectId)).status,200);
            const saved=await request('/api/rag/quota',{method:'PATCH',body:{projectKey:projectId,limitBytes:quota.limitBytes,expectedRevision:quota.revision}});assert.equal(saved.status,role==='Админ проекта'?200:403);
            assert.equal((await request('/api/rag/quota?projectKey=foreign-project')).status,403);
        }
        assert.equal((await request('/auth/switch-role',{method:'POST',body:{role:'Главный админ'}})).status,200);
    });
    await verifyProductionMaintenancePermissions({check,request});
    await check('После освобождения квоты запись вновь работает без повторного учёта старых строк',async()=>{
        const sync=await request('/api/rag/sync',{method:'POST',body:{projectKey:projectId,chunks:[{id:'fixture-row',filePath:'README.md',content:'Тестовые знания проекта',embedding:null}]}});assert.equal(sync.status,201);
        assert.deepEqual((await request('/api/rag/quota?projectKey='+projectId)).data,quota);
    });
    await check('Резервная копия проектной БД создаётся ролью только для чтения',async()=>{
        const backup=await request('/api/projects/'+projectId+'/backups',{method:'POST',body:{}});assert.equal(backup.status,201,JSON.stringify(backup.data));assert.ok(backup.data.sizeBytes>0);
    });
    await verifyProductionBackups({check,request,docker,dockerAsync,query,override,projectId,database});
    await check('Отказ PostgreSQL даёт readiness 503 при живом HTTP-процессе',async()=>{
        docker(['stop','postgres']);try{const state=JSON.parse(internalReady('catalog-service'));assert.equal(state.status,503);assert.equal(state.body.ok,false);assert.equal((await request('/ready')).status,503);assert.equal((await request('/health')).status,200);}
        finally{docker(['start','--wait','postgres']);}
        for(let attempt=0;attempt<10;attempt++){if(JSON.parse(internalReady('catalog-service')).status===200){return;}await new Promise(resolve=>setTimeout(resolve,500));}assert.fail('БД не восстановилась');
    });
    await check('SIGTERM закрывает gateway и WebSocket без аварийного завершения',async()=>{
        if(!socket.connected){socket.close();socket=await connectSocket();}
        const disconnected=new Promise(resolve=>socket.once('disconnect',resolve));const before=Date.now();await dockerAsync(['stop','api-gateway']);stopDurationMs=Date.now()-before;
        assert.ok(stopDurationMs<45000,'Шлюз должен завершиться до принудительного SIGKILL');await disconnected;socket.close();socket=undefined;
        const container=docker(['ps','-a','-q','api-gateway']);const result=spawnSync('docker',['inspect','--format','{{json .State}}',container],{encoding:'utf8'});const state=JSON.parse(result.stdout);
        // Nest завершает shutdown hooks и повторно посылает SIGTERM: обычный exit code — 143.
        assert.ok([0,143].includes(state.ExitCode));assert.equal(state.OOMKilled,false);assert.equal(state.Error,'');docker(['start','--wait','api-gateway']);
    });
    await check('После перезапуска сохранены проект, знания и серверная авторизация',async()=>{
        assert.equal((await request('/api/projects/'+projectId)).status,200);assert.equal((await request('/api/rag/manifest?projectKey='+projectId)).data.count,1);
    });
    await check('Выход отзывает сессию и закрывает повторный доступ',async()=>{
        const logout=await request('/auth/logout',{method:'POST',body:{}});assert.equal(logout.status,200);assert.equal(new URL(logout.data.redirectUrl).pathname,'/blitz/oauth/logout');
        const providerLogout=await request(logout.data.redirectUrl);assert.equal(providerLogout.status,302);assert.equal(providerLogout.headers.location,'https://panel.test/');assert.equal((await request('/api/projects')).status,401);
    });
    await writeFile(path.join(stage,'production-stack.json'),JSON.stringify({passed:passed.length,cases:passed,projectId,composeProject:project,release:process.env.NEUROCENTER_TEST_RELEASE||'verify-20261017',checkedAt:new Date().toISOString(),stopDurationMs,realBlitz:false,idp:'local HTTPS Blitz fixture',capacityCollector:true},null,2));
    console.log(JSON.stringify({passed:passed.length,realBlitz:false}));
}finally{
    socket?.close();
    try{await writeFile(path.join(directory,'services.log'),docker(['logs','--no-color']));}
    finally{docker(['down','--volumes','--remove-orphans']);}
}
