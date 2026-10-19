import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rm} from 'node:fs/promises';

/** Временные данные браузерной проверки никогда не используют реальный проект или MCP. */
const filename='.run/production-stage-3/ui-fixture.json';const mode=process.argv[2]||'create';
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));const {Pool}=require('pg');
let fixture=JSON.parse(await readFile(filename,'utf8').catch(()=>'null'));
const save=()=>writeFile(filename,JSON.stringify(fixture,null,2),{mode:0o600});
async function call(method,route,body,status=200){
    const response=await fetch('http://localhost:5173'+route,{method,headers:{Cookie:fixture.cookie,'Content-Type':'application/json','X-Neurocenter-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
}
const database=id=>'nc_rag_'+createHash('sha256').update(id).digest('hex').slice(0,32);
if(mode==='create'){
    assert.equal(fixture,null,'Предыдущая проверка требует очистки');
    const login=await fetch('http://localhost:5173/auth/login',{redirect:'manual'});fixture={cookie:login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),projects:[]};await save();
    const email=(await call('GET','/auth/me')).user.email;const suffix=randomUUID().slice(0,6);
    for(const role of ['Админ проекта','Разработчик','Наблюдатель']){
        const project=await call('POST','/api/projects',{name:'Проверка лимита '+role+' '+suffix},201);fixture.projects.push({id:project.id,name:project.name,database:database(project.id)});await save();
        await call('POST','/api/projects/'+project.id+'/members',{principalName:email,role},201);
    }
    fixture.primary=fixture.projects[0].id;
    await call('POST','/api/rag/sync',{projectKey:fixture.primary,chunks:[{id:'quota-ui',filePath:'Проверка.md',content:'Тестовые знания '.repeat(256)}]},201);
    await save();console.log(JSON.stringify({project:fixture.primary,url:'http://localhost:5173/projects/'+fixture.primary+'?tab=quotas'}));
}else if(mode==='change'){
    const quota=await call('GET','/api/rag/quota?projectKey='+fixture.primary);
    console.log(JSON.stringify(await call('PATCH','/api/rag/quota',{projectKey:fixture.primary,limitBytes:2*1024**2,expectedRevision:quota.revision})));
}else if(mode==='read'){
    console.log(JSON.stringify(await call('GET','/api/rag/quota?projectKey='+fixture.primary)));
}else if(mode==='break-read'||mode==='repair-read'){
    const url=new URL(process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog');url.pathname='/'+database(fixture.primary);const pool=new Pool({connectionString:url.href});
    try{await pool.query(mode==='break-read'?'ALTER TABLE rag_storage_budget RENAME TO qa_temporarily_unavailable_budget':'ALTER TABLE qa_temporarily_unavailable_budget RENAME TO rag_storage_budget');}finally{await pool.end();}
    console.log(mode==='break-read'?'Чтение временной базы недоступно.':'Чтение временной базы восстановлено.');
}else if(mode==='cleanup'){
    assert.ok(fixture?.primary);await call('POST','/auth/switch-role',{role:'Главный админ'});
    const pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog'});
    try{
        for(const item of fixture.projects){
            assert.match(item.name,/^Проверка лимита /);assert.equal(item.database,database(item.id));assert.match(item.database,/^nc_rag_[a-f0-9]{32}$/);
            await call('DELETE','/api/projects/'+item.id);await pool.query('DELETE FROM operations WHERE project_id=$1 OR resource_id=$1',[item.id]);
            await pool.query(`DROP DATABASE IF EXISTS ${item.database} WITH (FORCE)`);
        }
    }finally{await pool.end();}
    await rm(filename);console.log('Временные проекты и их базы удалены.');
}else{throw new Error('Неизвестный режим');}
