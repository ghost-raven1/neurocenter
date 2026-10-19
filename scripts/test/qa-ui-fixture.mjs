// Изолированный набор для ручной проверки ролей, WebSocket и очереди в браузере.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(new URL('../../',import.meta.url).pathname);
const stateFile=path.join(root,'.run/qa/ui-fixture.json');
const require=createRequire(path.join(root,'services/catalog-service/package.json'));const {Pool}=require('pg');
const mode=process.argv[2]||'create';
let fixture=JSON.parse(await fs.readFile(stateFile,'utf8').catch(()=>'null'));
const save=()=>fs.writeFile(stateFile,JSON.stringify(fixture),{mode:0o600});
async function call(method,route,body,status=200){const response=await fetch('http://localhost:5173'+route,{method,headers:{Cookie:fixture.cookie,'Content-Type':'application/json','X-Neurocenter-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.equal(response.status,status,method+' '+route+': '+String(value?.message||response.status));return value;}
if(mode==='create'){
    assert.equal(fixture,null,'Сначала очистите предыдущую UI-проверку');
    const login=await fetch('http://localhost:5173/auth/login',{redirect:'manual'});fixture={cookie:login.headers.getSetCookie().map(item=>item.split(';')[0]).join('; '),projects:[],skills:[],devices:[],pairs:[]};await save();
    const email=(await call('GET','/auth/me')).user.email;const run=randomUUID().slice(0,6);
    for(const [title,role] of [['Разработка','Разработчик'],['Наблюдение','Наблюдатель'],['Администрирование','Админ проекта']]){
        const project=await call('POST','/api/projects',{name:'Проверка интерфейса '+title+' '+run},201);fixture.projects.push(project);await save();
        const file=path.join(root,'.run/qa/project-fixtures.json');const all=JSON.parse(await fs.readFile(file,'utf8'));all.push({id:project.id,database:'nc_rag_'+createHash('sha256').update(project.id).digest('hex').slice(0,32)});await fs.writeFile(file,JSON.stringify(all));
        await call('POST','/api/projects/'+project.id+'/members',{principalName:email,role},201);
    }
    const project=fixture.projects[0];const skill=await call('POST','/api/skills',{path:'project-'+project.id,slug:'qa-ui-helper',name:'Проверка собственного скилла',body:'Тестовая инструкция без исполняемого кода',meta:{description:'Временная карточка для проверки прав редактора'}},201);fixture.skills.push(skill.path);await save();
    const pair=await call('POST','/api/device-channel/pair/start',{name:'Проверка UI · MCP отключён',fingerprint:randomBytes(32).toString('hex')},201);fixture.pairs.push(createHash('sha256').update(pair.deviceCode).digest('hex'));await save();
    await call('POST','/api/device-pairs/'+pair.userCode+'/approve',{},201);const paired=await call('POST','/api/device-channel/pair/poll',{deviceCode:pair.deviceCode},201);fixture.devices.push(paired.deviceId);await save();
    fixture.job=await call('POST','/api/device-jobs',{deviceId:paired.deviceId,projectId:project.id,kind:'bind-project',folderName:'Тестовая папка',requestKey:randomUUID()},201);await save();
    console.log(JSON.stringify({projects:fixture.projects.map(({id,name})=>({id,name})),job:fixture.job.id}));
}else if(mode==='cancel'){
    await call('DELETE','/api/device-jobs/'+fixture.job.id);console.log('Ожидающее задание отменено через API');
}else if(mode==='retry'){
    fixture.job=await call('POST','/api/device-jobs/'+fixture.job.id+'/retry',{requestKey:randomUUID()},201);await save();console.log(JSON.stringify({job:fixture.job.id,state:fixture.job.state}));
}else if(mode==='cleanup'){
    if(!fixture){console.log('Набор уже очищен');process.exit(0);}
    await call('POST','/auth/switch-role',{role:'Главный админ'});
    const pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog'});
    try{
        for(const relative of fixture.skills){await call('DELETE','/api/skills/'+relative);}
        for(const project of fixture.projects){await call('DELETE','/api/projects/'+project.id);await pool.query('DELETE FROM operations WHERE project_id=$1 OR resource_id=$1',[project.id]);await fs.rm(path.join(root,'data/skills/project-'+project.id),{recursive:true,force:true});}
        for(const device of fixture.devices){await call('DELETE','/api/devices/'+device);await pool.query("DELETE FROM operations WHERE operation_id IN (SELECT 'bridge-'||id FROM bridge_jobs WHERE device_id=$1)",[device]);await pool.query('DELETE FROM bridge_jobs WHERE device_id=$1',[device]);await pool.query('DELETE FROM bridge_devices WHERE id=$1',[device]);}
        for(const hash of fixture.pairs){await pool.query('DELETE FROM bridge_pairs WHERE code_hash=$1',[hash]);}
    }finally{await pool.end();}
    await fs.rm(stateFile);console.log('Временные данные UI удалены');
}else{throw new Error('Неизвестный режим');}
