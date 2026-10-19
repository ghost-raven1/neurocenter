import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));const {Pool}=require('pg');
const receipt=path.resolve('.run/production-stage-4/ui-fixture.json');const mode=process.argv[2]||'create';
let fixture=JSON.parse(await readFile(receipt,'utf8').catch(()=>'null'));const save=()=>writeFile(receipt,JSON.stringify(fixture,null,2),{mode:0o600});
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
async function call(method,route,body,status=200){
    const response=await fetch('http://localhost:5173'+route,{method,headers:{Cookie:fixture.cookie,'Content-Type':'application/json','X-Neurocenter-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
}
const lock=path.resolve('data/backups/.neurocenter-backup.lock');
async function unlock(){if(!fixture?.lockOwner){return;}assert.equal(await readFile(path.join(lock,'owner'),'utf8'),fixture.lockOwner);await rm(lock,{recursive:true});delete fixture.lockOwner;await save();}
if(mode==='create'){
    assert.equal(fixture,null,'Предыдущая проверка требует очистки');const login=await fetch('http://localhost:5173/auth/login',{redirect:'manual'});
    fixture={cookie:login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};await save();
    await call('POST','/auth/switch-role',{role:'Главный админ'});
    const project=await call('POST','/api/projects',{name:'Проверка резервных копий '+randomUUID().slice(0,6)},201);fixture.projectId=project.id;await save();
    await call('POST','/api/rag/sync',{projectKey:project.id,chunks:[{id:'backup-ui',filePath:'Проверка.md',content:'Знания временного проекта для проверки копий.'}]},201);
    console.log(JSON.stringify({project:project.id,url:'http://localhost:5173/projects/'+project.id+'?tab=backups'}));
}else if(mode==='block'){
    assert.ok(fixture?.projectId&&!fixture.lockOwner);fixture.lockOwner='stage4-ui-'+randomUUID();await mkdir(lock,{mode:0o700});await writeFile(path.join(lock,'owner'),fixture.lockOwner,{flag:'wx',mode:0o600});await save();console.log('Тестовая блокировка создана.');
}else if(mode==='unblock'){await unlock();console.log('Тестовая блокировка снята.');
}else if(mode==='cleanup'){
    assert.match(fixture?.projectId||'',/^prj-[a-f0-9-]{36}$/);await unlock();const id=fixture.projectId;const pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog'});
    try{
        const project=await call('GET','/api/projects/'+id);assert.match(project.name,/^Проверка резервных копий /);
        await call('POST','/auth/switch-role',{role:'Главный админ'});await call('DELETE','/api/projects/'+id);
        await pool.query('DELETE FROM project_backups WHERE project_id=$1',[id]);await pool.query('DELETE FROM operations WHERE project_id=$1 OR resource_id=$1',[id]);
        const registryUrl=new URL(process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog');registryUrl.pathname='/rag';const registry=new Pool({connectionString:registryUrl.href});
        try{await registry.query('DELETE FROM neurocenter_project_databases WHERE project_id=$1 AND database_name=$2',[id,'nc_rag_'+hash(id)]);}finally{await registry.end();}
        await pool.query('DROP DATABASE IF EXISTS nc_rag_'+hash(id)+' WITH (FORCE)');
        await rm(path.resolve('data/backups/projects',hash(id)),{recursive:true,force:true});
    }finally{await pool.end();}
    await rm(receipt);console.log('Собственные проект, база и копии удалены.');
}else{throw new Error('Неизвестный режим');}
