// Все проекты, роли и инструкции этого воспроизведения создаются и удаляются самим тестом.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const root=process.cwd();const base='http://localhost:5173';const login=await fetch(base+'/auth/login',{redirect:'manual'});const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const require=createRequire(path.join(root,'services/catalog-service/package.json'));const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog'});
const legacy=new Pool({connectionString:process.env.RAG_PG_URL||'postgresql://rag:rag@localhost:5432/rag'});let legacyKey;
const created=[];const results=[];let skill;
async function request(method,route,body){const response=await fetch(base+route,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Neurocenter-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}
async function call(method,route,body,status=200){const r=await request(method,route,body);assert.equal(r.status,status,method+' '+route);return r.data;}
async function check(name,run){try{await run();results.push({case:name,ok:true});}catch(error){results.push({case:name,ok:false,error:error.message});}}
try{
    await call('POST','/auth/switch-role',{role:'Главный админ'});const email=(await call('GET','/auth/me')).user.email;
    const victim=await call('POST','/api/projects',{name:'Проверка изоляции чужой '+randomUUID().slice(0,8)},201);created.push(victim);
    const collision=await request('POST','/api/projects',{name:victim.id});
    const own=collision.status===201?(await pool.query('SELECT id,name FROM projects WHERE name=$1 AND id<>$1',[victim.id])).rows[0]:await call('POST','/api/projects',{name:'Проверка изоляции свой '+randomUUID().slice(0,8)},201);
    assert.ok(own);created.push(own);
    // Старая запись моделируется напрямую: новые имена API уже обязан отклонять.
    if(collision.status===400){await pool.query('UPDATE projects SET name=$2 WHERE id=$1',[own.id,victim.id]);}
    legacyKey=victim.id;await legacy.query("INSERT INTO rag_chunks(id,project_key,content,content_hash) VALUES('qa-private-legacy',$1,'Приватная тестовая строка старого индекса','test')",[legacyKey]);
    const file=path.join(root,'.run/qa/project-fixtures.json');const tracked=JSON.parse(await fs.readFile(file,'utf8').catch(()=>'[]'));tracked.push(...created.map(p=>({id:p.id})));await fs.writeFile(file,JSON.stringify(tracked));
    skill=await call('POST','/api/skills',{path:'project-'+victim.id,slug:'private-audit',name:'Приватная проверочная инструкция',body:'Только содержимое тестового проекта',meta:{description:'Проверка изоляции'}},201);
    await call('POST','/api/projects/'+own.id+'/members',{principalName:email,role:'Админ проекта'},201);await call('POST','/auth/switch-role',{role:'Админ проекта'});
    await check('Имя нового проекта не может подменить постоянный ID другого проекта',async()=>{assert.equal(collision.status,400);});
    await check('Коллизия имени и ID не открывает инструкцию чужого проекта',async()=>{const r=await request('GET','/api/skills/'+skill.path);assert.equal(r.status,403,'Чтение чужого скилла при коллизии: '+r.status);});
    await check('Коллизия имени и ID не перезаписывает чужую инструкцию',async()=>{const r=await request('PUT','/api/skills/'+skill.path,{expectedVersion:1,body:'Только проверка защиты записи'});assert.equal(r.status,403);});
    await check('Коллизия имени и ID не позволяет добавить себя в чужой проект',async()=>{const r=await request('POST','/api/projects/'+victim.id+'/members',{principalName:email,role:'Разработчик'});assert.equal(r.status,403);});
    await check('Старая коллизия имени не переносит чужой общий RAG в свою проектную БД',async()=>{const r=await call('GET','/api/rag/chunks?projectKey='+own.id);assert.equal(r.count,0);});
}finally{
    await call('POST','/auth/switch-role',{role:'Главный админ'}).catch(()=>undefined);
    if(skill){await call('DELETE','/api/skills/'+skill.path).catch(()=>undefined);}
    for(const project of [...created].reverse()){await call('DELETE','/api/projects/'+project.id).catch(()=>undefined);await pool.query('DELETE FROM operations WHERE project_id=$1 OR resource_id=$1',[project.id]);await fs.rm(path.join(root,'data/skills/project-'+project.id),{recursive:true,force:true});}
    if(legacyKey){await legacy.query('DELETE FROM rag_chunks WHERE project_key=$1',[legacyKey]);}await legacy.end();
    await pool.end();const report={results,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length};await fs.writeFile(path.join(root,'.run/security-2026-10-17/project-isolation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.failed){process.exitCode=1;}
}
