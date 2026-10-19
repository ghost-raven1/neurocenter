// Сквозные проверки используют только собственные проекты, карточки, учётные записи и устройства.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';

const base=process.env.NEUROCENTER_TEST_URL||'http://localhost:5173';const root=path.resolve(new URL('../../',import.meta.url).pathname);
const require=createRequire(path.join(root,'services/catalog-service/package.json'));const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',application_name:'qa-api'});
const run=randomUUID().slice(0,8);const prefix='Проверка QA '+run;
const login=await fetch(base+'/auth/login',{redirect:'manual'});const cookie=login.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
const projects=[];const skills=[];const plugins=[];const devices=[];const pairs=[];const users=[];const results=[];const operationIds=[];
async function call(method,route,body,expected=200,token){
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Neurocenter-Request':'1',...(token?{Authorization:'Bearer '+token}:{Cookie:cookie})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={message:'Ответ не в JSON'};}
    assert.equal(response.status,expected,method+' '+route+': '+String(data?.message||data?.error||response.status));return data;
}
async function check(name,action){try{await action();results.push({case:name,ok:true});}catch(error){results.push({case:name,ok:false,error:error.message});}}
const role=value=>call('POST','/auth/switch-role',{role:value});
async function trackProject(project){projects.push(project);const file=path.join(root,'.run/qa/project-fixtures.json');const tracked=JSON.parse(await fs.readFile(file,'utf8').catch(()=>'[]'));tracked.push({id:project.id,database:'nc_rag_'+createHash('sha256').update(project.id).digest('hex').slice(0,32)});await fs.writeFile(file,JSON.stringify(tracked));}
async function skill(directory,slug){const value=await call('POST','/api/skills',{path:directory,slug,name:prefix+' помощник',body:'Исходная инструкция',meta:{description:'Скилл временного проекта'}},201);skills.push(value.path);return value;}
try{
    await role('Главный админ');const profile=await call('GET','/auth/me');const email=profile.user.email;
    for(const suffix of ['разработка','наблюдение','администрирование','без доступа']){await trackProject(await call('POST','/api/projects',{name:prefix+' '+suffix},201));}
    const [project,readProject,adminProject,foreignProject]=projects;
    const membership=await call('POST',`/api/projects/${project.id}/members`,{principalName:email,role:'Разработчик'},201);
    await call('POST',`/api/projects/${readProject.id}/members`,{principalName:email,role:'Наблюдатель'},201);
    await call('POST',`/api/projects/${adminProject.id}/members`,{principalName:email,role:'Админ проекта'},201);
    const common=await skill('common','qa-'+run);await skill('project-'+foreignProject.id,'qa-foreign');
    const plugin=await call('POST','/api/ai-plugins',{publicationKey:randomUUID(),name:prefix+' MCP',kind:'mcp',description:'Тестовый удалённый MCP',config:{transport:'remote',url:'https://example.test/mcp'},files:[]},201);plugins.push(plugin.id);
    await check('API без сессии не принимает поддельные identity-заголовки',async()=>{const response=await fetch(base+'/api/projects',{headers:{'x-bridge-roles':encodeURIComponent('Главный админ'),'x-neurocenter-internal':'wrong'}});assert.equal(response.status,401);});
    await check('Сервисы недоступны в обход шлюза',async()=>{for(const [port,route] of [[4100,'projects'],[4200,'skills'],[4300,'rag/projects']]){assert.equal((await fetch(`http://127.0.0.1:${port}/api/${route}`)).status,403);}});
    await check('Пагинация списка проектов и поиск используют реальные счётчики',async()=>{const page=await call('GET','/api/projects?size=2&q='+encodeURIComponent(prefix));assert.equal(page.total,4);assert.equal(page.items.length,2);});
    for(const route of ['/api/projects?page=-1','/api/projects?size=-1','/api/operations?page=-1','/api/audit?size=-1','/api/ai-plugins?size=-1','/api/ai-plugins?page=abc','/api/projects?page=1.5']){await check('Некорректная пагинация возвращает 400: '+route,()=>call('GET',route,undefined,400));}
    for(const input of [{retention:-1},{retention:1.5},{retention:101},{retention:null},{state:'INVALID'},{quotas:{currentBytesLimit:-1}},{quotas:{currentBytesLimit:1.5}},{quotas:[]},{fsRootPath:55}]){await check('Настройки проекта отклоняются до записи: '+JSON.stringify(input),()=>call('PATCH','/api/projects/'+project.id,input,400));}
    await check('Частичное обновление квот сохраняет остальные лимиты',async()=>{await call('PATCH','/api/projects/'+project.id,{quotas:{currentBytesLimit:100,retentionBytesLimit:200}});const updated=await call('PATCH','/api/projects/'+project.id,{quotas:{currentBytesLimit:300}});assert.equal(updated.quota.currentBytesLimit,300);assert.equal(updated.quota.retentionBytesLimit,200);});
    await check('Дубликат русского названия проекта возвращает конфликт',()=>call('POST','/api/projects',{name:project.name},409));
    await role('Разработчик');
    await check('Разработчик видит назначенные проекты и не читает чужой',async()=>{const page=await call('GET','/api/projects?size=100');assert.equal(page.total,3);assert.equal(page.items.some(item=>item.id===foreignProject.id),false);await call('GET','/api/projects/'+foreignProject.id,undefined,403);});
    await check('PUT не подменяет область URL скилла через body.path',async()=>{await call('PUT','/api/skills/'+common.path,{path:'project-'+project.id,body:'Запрещённая запись',expectedVersion:1},403);});
    await check('DELETE не подменяет область URL скилла через body.path',()=>call('DELETE','/api/skills/'+common.path,{path:'project-'+project.id},403));
    await check('Роль разработчика не меняет квоты или каталог команды',async()=>{await call('PATCH','/api/projects/'+project.id,{retention:4},403);await call('POST',`/api/projects/${project.id}/assets`,{assetId:plugin.id,assetKind:'mcp'},403);});
    await check('Прямой доступ к общему неутверждённому инструменту закрыт',()=>call('GET','/api/ai-plugins/'+plugin.id,undefined,403));
    const syncItem={slug:'qa-project',name:'Проектный помощник',body:'Инструкция проекта',description:'Описание',version:1};
    await call('POST','/api/skills/sync',{projectKey:project.id,skills:[syncItem]},201);skills.push('project-'+project.id+'/'+syncItem.slug);
    await check('Проектный скилл доступен разработчику своего проекта',async()=>{const list=await call('GET','/api/skills?projectKey='+project.id);assert.ok(list.some(item=>item.path==='project-'+project.id+'/'+syncItem.slug));});
    await check('Неверный пакет синхронизации не меняет предыдущую карточку',async()=>{await call('POST','/api/skills/sync',{projectKey:project.id,skills:[{...syncItem,body:'Новый текст'},{slug:'broken',name:'Нет инструкции'}]},400);const file=await call('GET','/api/skills/project-'+project.id+'/'+syncItem.slug);assert.equal(file.body,syncItem.body);});
    await check('Пустая синхронизация не удаляет инструкции',()=>call('POST','/api/skills/sync',{projectKey:project.id,skills:[]},409));
    await check('Правка в редакторе защищена от старой локальной версии',async()=>{await call('PUT','/api/skills/project-'+project.id+'/'+syncItem.slug,{body:'Изменено в браузере',expectedVersion:1});await call('POST','/api/skills/sync',{projectKey:project.id,skills:[syncItem]},409);});
    await role('Наблюдатель');await check('Наблюдатель читает скилл, но не меняет его',async()=>{await call('GET','/api/skills/project-'+project.id+'/'+syncItem.slug);await call('PUT','/api/skills/project-'+project.id+'/'+syncItem.slug,{body:'Запрещено',expectedVersion:2},403);});
    await role('Админ проекта');await check('Проектный админ видит общий каталог и управляет только своим проектом',async()=>{await call('GET','/api/ai-plugins/'+plugin.id);await call('POST',`/api/projects/${adminProject.id}/assets`,{assetId:plugin.id,assetKind:'mcp'},201);await call('POST',`/api/projects/${project.id}/assets`,{assetId:plugin.id,assetKind:'mcp'},403);});
    await role('Главный админ');await call('POST',`/api/projects/${project.id}/assets`,{assetId:plugin.id,assetKind:'mcp'},201);
    await check('Используемую карточку MCP нельзя удалить до удаления из проектных каталогов',()=>call('DELETE','/api/ai-plugins/'+plugin.id,undefined,409));
    for(const [method,route] of [['POST','versions/test/activate'],['POST','versions/test/rollback'],['DELETE','versions/test'],['POST','release-profile']]){await check('Нереализованная команда не выдаёт успех: '+route,()=>call(method,`/api/projects/${project.id}/`+route,{},501));}
    const row={id:'ordinary',filePath:'README.md',content:'a\0b',embedding:null};
    await check('RAG очищает NUL и считает хэш от сохранённого контента',async()=>{await call('POST','/api/rag/sync',{projectKey:project.id,chunks:[row,{...row,id:'__proto__',content:'Прототип'}]},201);const value=await call('GET','/api/rag/chunks?projectKey='+project.id);assert.equal(value.chunks.find(item=>item.id==='ordinary').content,'ab');assert.equal(value.chunks.find(item=>item.id==='ordinary').contentHash,createHash('sha256').update('ab').digest('hex'));});
    await check('Специальный ID __proto__ сохраняется в манифесте',async()=>{const manifest=await call('GET','/api/rag/manifest?projectKey='+project.id);assert.equal(manifest.count,2);assert.ok(Object.hasOwn(manifest.ids,'__proto__'));});
    for(const input of [{chunks:[{...row,content:42}]},{chunks:[row,row]},{chunks:[{...row,embedding:[1,2]}]},{chunks:'wrong'},{deletes:[null]},{chunks:[row],deletes:['ordinary']}]){await check('Неверная дельта RAG не меняет базу: '+JSON.stringify(input).slice(0,100),async()=>{await call('POST','/api/rag/sync',{projectKey:project.id,...input},400);assert.equal((await call('GET','/api/rag/summary?projectKey='+project.id)).rowCount,2);});}
    await check('Пагинация RAG отклоняет дробные значения',()=>call('GET','/api/rag/chunks?projectKey='+project.id+'&limit=1.5',undefined,400));
    await check('Несуществующий проект RAG возвращает 404',()=>call('GET','/api/rag/summary?projectKey=prj-missing-'+run,undefined,404));
    const pair=await call('POST','/api/device-channel/pair/start',{name:prefix+' MCP',fingerprint:randomBytes(32).toString('hex')},201);pairs.push(createHash('sha256').update(pair.deviceCode).digest('hex'));
    assert.equal((await call('POST','/api/device-channel/pair/poll',{deviceCode:pair.deviceCode},201)).state,'pending');await call('POST',`/api/device-pairs/${pair.userCode}/approve`,{},201);const connection=await call('POST','/api/device-channel/pair/poll',{deviceCode:pair.deviceCode},201);devices.push(connection.deviceId);
    await check('Код подключения выдаёт ключ ровно один раз',()=>call('POST','/api/device-channel/pair/poll',{deviceCode:pair.deviceCode},409));
    await check('Ключ MCP не открывает административный API',()=>call('GET','/api/platform/users',undefined,403,connection.token));
    await check('Некорректный отчёт MCP не сохраняется',()=>call('POST','/api/device-channel/heartbeat',[],400,connection.token));
    const job=await call('POST','/api/device-jobs',{deviceId:connection.deviceId,projectId:project.id,kind:'bind-project',folderName:'qa-project',requestKey:randomUUID()},201);
    await check('Общий журнал не подделывает отмену или повтор задания',async()=>{await call('POST','/api/operations/bridge-'+job.id+'/cancel',{},501);await call('POST','/api/operations/bridge-'+job.id+'/retry',{},501);assert.equal((await call('GET','/api/device-jobs')).find(item=>item.id===job.id).state,'queued');});
    await check('Реальная отмена меняет очередь и журнал вместе',async()=>{await call('DELETE','/api/device-jobs/'+job.id);assert.equal((await call('GET','/api/device-jobs')).find(item=>item.id===job.id).state,'cancelled');assert.equal((await call('GET','/api/operations/bridge-'+job.id)).state,'CANCELLED');});
    await check('Повтор создаёт новое задание и идемпотентен по ключу',async()=>{const key=randomUUID();const first=await call('POST','/api/device-jobs/'+job.id+'/retry',{requestKey:key},201);const second=await call('POST','/api/device-jobs/'+job.id+'/retry',{requestKey:key},201);assert.notEqual(first.id,job.id);assert.equal(first.id,second.id);await call('POST','/api/device-jobs/'+first.id+'/retry',{requestKey:randomUUID()},409);});
    await role('Разработчик');await check('Разработчик устанавливает собственный проектный скилл без копирования из общего каталога',async()=>{await call('POST','/api/device-jobs',{deviceId:connection.deviceId,projectId:project.id,kind:'install',assetKind:'skill',assetId:'project-'+project.id+'/'+syncItem.slug,version:2,requestKey:randomUUID()},201);});
    await role('Главный админ');
    const counts=Array.from({length:12},(_,index)=>({id:'qa-'+randomUUID(),state:index===0?'QUEUED':'SUCCEEDED',created:new Date(Date.now()-60000+index).toISOString()}));operationIds.push(...counts.map(item=>item.id));
    for(const item of counts){await pool.query("INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,created_at) VALUES($1,'PROJECT',$2,'qa',$1,$3,$4,$5)",[item.id,project.id,email,item.state,item.created]);}
    await check('Активный счётчик учитывает задания за пределами текущей страницы',async()=>{const page=await call('GET',`/api/operations?projectId=${project.id}&size=1`);assert.ok(page.activeCount>=2);assert.equal(page.items.length,1);assert.ok((await call('GET','/api/projects/'+project.id)).activeOperations>=2);});
    await check('Аудит ожидающей операции сохраняет время создания',async()=>{const page=await call('GET','/api/audit?size=100');const item=page.items.find(item=>item.id===counts[0].id);assert.equal(new Date(item.at).toISOString(),counts[0].created);});
    await role('Разработчик');await check('Фильтр проекта не примешивает собственные операции из других проектов',async()=>{const page=await call('GET','/api/operations?projectId='+readProject.id);assert.equal(page.items.every(item=>item.projectId===readProject.id||item.projectId===readProject.name),true);});await role('Главный админ');
    await check('Обрыв idle-соединения проектной PostgreSQL не останавливает RAG',async()=>{const database='nc_rag_'+createHash('sha256').update(project.id).digest('hex').slice(0,32);await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND state='idle'",[database]);await delay(120);assert.equal((await fetch('http://127.0.0.1:4300/health')).status,200);assert.equal((await call('GET','/api/rag/summary?projectKey='+project.id)).rowCount,2);});
    for(const application of ['neurocenter:access','neurocenter:devices','neurocenter:catalog']){await check('Каталог переживает обрыв соединения пула '+application,async()=>{await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND state='idle'",[application]);await delay(100);await call('GET','/api/projects/'+project.id);});}
}finally{
    await role('Главный админ').catch(()=>undefined);
    for(const device of devices){await call('DELETE','/api/devices/'+device).catch(()=>undefined);await pool.query("DELETE FROM operations WHERE operation_id IN (SELECT 'bridge-'||id FROM bridge_jobs WHERE device_id=$1)",[device]);await pool.query('DELETE FROM bridge_jobs WHERE device_id=$1',[device]);await pool.query('DELETE FROM bridge_devices WHERE id=$1',[device]);}
    for(const hash of pairs){await pool.query('DELETE FROM bridge_pairs WHERE code_hash=$1',[hash]);}
    for(const relative of skills){await call('DELETE','/api/skills/'+relative).catch(()=>undefined);}
    for(const project of projects){await call('DELETE','/api/projects/'+project.id).catch(()=>undefined);await pool.query('DELETE FROM operations WHERE project_id=$1',[project.id]);await fs.rm(path.join(root,'data/skills','project-'+project.id),{recursive:true,force:true});}
    for(const plugin of plugins){await call('DELETE','/api/ai-plugins/'+plugin);}
    for(const email of users){await pool.query('DELETE FROM platform_users WHERE email=$1',[email]);}
    await pool.end();await fs.writeFile(path.join(root,'.run/qa/api-matrix.json'),JSON.stringify({results,passed:results.filter(item=>item.ok).length,failed:results.filter(item=>!item.ok).length},null,2));
}
console.log(JSON.stringify({passed:results.filter(item=>item.ok).length,failed:results.filter(item=>!item.ok)}));if(results.some(item=>!item.ok)){process.exitCode=1;}
