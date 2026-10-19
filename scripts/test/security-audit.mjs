// Проверки атак используют только собственные временные сущности и отдельную веб-сессию.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const root=process.cwd();const dir=path.join(root,'.run/security-2026-10-17');await fs.mkdir(dir,{recursive:true});
const require=createRequire(path.join(root,'services/catalog-service/package.json'));const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog'});
const {io}=await import(path.join(root,'mcp/neurocenter-asset-sync/node_modules/socket.io-client/build/esm/index.js'));
const base=process.env.NEUROCENTER_TEST_URL||'http://localhost:5173';const login=await fetch(base+'/auth/login',{redirect:'manual'});
const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');const headers={'Content-Type':'application/json','X-Neurocenter-Request':'1',Cookie:cookie};
const results=[];const pairs=[];let project;const fake=path.join(dir,'server-projects');
async function request(method,route,body,override={}){
    const response=await fetch(base+route,{method,headers:{...headers,...override},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(10000)});
    const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:response.status,data,headers:response.headers};
}
async function call(method,route,body,expected=200){const response=await request(method,route,body);assert.equal(response.status,expected,method+' '+route);return response.data;}
async function check(name,run){try{await run();results.push({case:name,ok:true});}catch(error){results.push({case:name,ok:false,error:error.message});}}
async function pair(){const created=await call('POST','/api/device-channel/pair/start',{name:'Проверка безопасности '+randomUUID().slice(0,8),fingerprint:randomBytes(32).toString('hex')},201);pairs.push(createHash('sha256').update(created.deviceCode).digest('hex'));return created;}
try{
    await call('POST','/auth/switch-role',{role:'Главный админ'});
    await check('Чужой Origin не подтверждает MCP даже с корректным заголовком запроса',async()=>{
        const p=await pair();const response=await request('POST','/api/device-pairs/'+p.userCode+'/approve',undefined,{Origin:'https://attacker.example'});assert.equal(response.status,403);
    });
    await check('Форма text/plain не подтверждает MCP через cookie',async()=>{
        const p=await pair();const response=await request('POST','/api/device-pairs/'+p.userCode+'/approve','',{'Content-Type':'text/plain','X-Neurocenter-Request':'',Origin:'http://localhost:5173'});assert.equal(response.status,403);
    });
    await check('Чужой сайт не меняет роль через обычную HTML-форму',async()=>{
        const response=await request('POST','/auth/switch-role',new URLSearchParams({role:'Главный админ'}).toString(),{'Content-Type':'application/x-www-form-urlencoded','X-Neurocenter-Request':'',Origin:'https://attacker.example'});assert.equal(response.status,403);
    });
    await check('WebSocket отвергает чужой Origin до присоединения к личной комнате',async()=>{
        const socket=io(base,{transports:['websocket'],forceNew:true,reconnection:false,extraHeaders:{Cookie:cookie,Origin:'https://attacker.example'}});
        try{const allowed=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Нет результата WebSocket')),5000);socket.once('connect',()=>{clearTimeout(timeout);resolve(true);});socket.once('connect_error',()=>{clearTimeout(timeout);resolve(false);});});assert.equal(allowed,false);}finally{socket.disconnect();}
    });
    await check('Раздача установщика использует настроенный адрес, а не подставной forwarded-host',async()=>{
        const response=await request('GET','/api/bridge/install.sh',undefined,{'x-forwarded-host':'attacker.example','x-forwarded-proto':'https'});assert.ok(response.status===400||response.status===403||!String(response.data).includes('https://attacker.example/api/bridge'));
    });
    project=await call('POST','/api/projects',{name:'Проверка безопасности '+randomUUID().slice(0,8)},201);
    const fixtureFile=path.join(root,'.run/qa/project-fixtures.json');const tracked=JSON.parse(await fs.readFile(fixtureFile,'utf8').catch(()=>'[]'));tracked.push({id:project.id});await fs.writeFile(fixtureFile,JSON.stringify(tracked));
    const profile=await call('GET','/auth/me');await call('POST','/api/projects/'+project.id+'/members',{principalName:profile.user.email,role:'Наблюдатель'},201);
    await fs.mkdir(path.join(fake,'Чужой локальный проект','.opencode'),{recursive:true});
    await fs.writeFile(path.join(fake,'Чужой локальный проект','.opencode/opencode.json'),JSON.stringify({mcp:{private:{command:'node',env:{QA_SECRET:'qa-'+randomUUID()}}}}));
    await call('POST','/auth/switch-role',{role:'Наблюдатель'});
    await check('Наблюдатель не сканирует серверный home и конфигурации посторонних папок',async()=>{
        const response=await request('GET','/api/local-assets/scan?root='+encodeURIComponent(path.relative(os.homedir(),fake)));assert.ok([403,404,410].includes(response.status),'Серверный скан доступен наблюдателю: '+response.status);
    });
    await check('Наблюдатель не создаёт установку или резервную копию',async()=>{
        assert.equal((await request('POST','/api/local-assets/install',{projectName:project.name,kind:'mcp',name:'bad',config:{command:'node'}})).status,403);
        assert.equal((await request('POST','/api/projects/'+project.id+'/backups',{})).status,403);
    });
    await call('POST','/auth/switch-role',{role:'Главный админ'});
    await check('Список устройств не раскрывает токены и их хэши',async()=>{const devices=await call('GET','/api/devices');for(const device of devices){assert.equal('token' in device||'token_hash' in device||'tokenHash' in device,false);}});
    await check('Микросервисы не доверяют поддельной роли без внутреннего секрета',async()=>{for(const port of [4100,4200,4300]){assert.equal((await fetch('http://127.0.0.1:'+port+'/api/'+(port===4100?'projects':port===4200?'skills':'rag/projects'),{headers:{'x-bridge-roles':encodeURIComponent('Главный админ')}})).status,403);}});
    await check('API не принимает произвольный SQL как идентификатор проекта',async()=>{const response=await request('GET','/api/projects/'+encodeURIComponent("prj-unknown' OR 1=1 --"));assert.equal(response.status,404);});
}finally{
    await call('POST','/auth/switch-role',{role:'Главный админ'}).catch(()=>undefined);
    if(project){await call('DELETE','/api/projects/'+project.id).catch(()=>undefined);await pool.query('DELETE FROM operations WHERE project_id=$1 OR resource_id=$1',[project.id]);}
    for(const hash of pairs){await pool.query('DELETE FROM bridge_pairs WHERE code_hash=$1',[hash]);}
    await fs.rm(fake,{recursive:true,force:true});await pool.end();
    const report={results,passed:results.filter(row=>row.ok).length,failed:results.filter(row=>!row.ok).length};await fs.writeFile(path.join(dir,'security-scenarios.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.failed){process.exitCode=1;}
}
