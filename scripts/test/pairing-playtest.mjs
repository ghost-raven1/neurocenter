// Временное подключение имитирует только heartbeat и не исполняет локальные задания.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const root=process.cwd();const file=path.join(root,'.run/security-2026-10-17/pairing-fixture.json');
const base=process.env.NEUROCENTER_TEST_URL||'http://localhost:5173';const mode=process.argv[2]||'create';
const login=await fetch(base+'/auth/login',{redirect:'manual'});const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
let fixture=JSON.parse(await fs.readFile(file,'utf8').catch(()=>'null'));
const save=async()=>{await fs.writeFile(file,JSON.stringify(fixture),{mode:0o600});await fs.chmod(file,0o600);};
async function call(route,body,device=false){const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Neurocenter-Request':'1',...(device?{Authorization:'Bearer '+fixture.token}:{Cookie:cookie})},body:JSON.stringify(body||{})});const data=await response.json();if(!response.ok){throw new Error('HTTP '+response.status+' '+route);}return data;}
if(mode==='create'){
    if(fixture){throw new Error('Сначала очистите временное подключение');}
    const fingerprint=randomBytes(32).toString('hex');fixture={fingerprint,pair:await call('/api/device-channel/pair/start',{name:'Проверка подключения · тестовый мост',fingerprint})};await save();
    console.log(JSON.stringify({url:base+'/start?step=1&connect='+fixture.pair.userCode,name:'Проверка подключения · тестовый мост'}));
}else if(mode==='approve'){
    await call('/api/device-pairs/'+fixture.pair.userCode+'/approve');console.log('Временное подключение подтверждено отдельной тестовой сессией');
}else if(mode==='connect'){
    const connected=await call('/api/device-channel/pair/poll',{deviceCode:fixture.pair.deviceCode});fixture.deviceId=connected.deviceId;fixture.token=connected.token;await save();
    await call('/api/device-channel/heartbeat',{platform:process.platform,root:null,folders:[],bindings:[]},true);console.log('Heartbeat временного подключения принят');
}else if(mode==='cleanup'){
    if(!fixture){console.log('Временное подключение уже очищено');process.exit(0);}
    const require=createRequire(path.join(root,'services/catalog-service/package.json'));const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog'});
    try{
        if(fixture.deviceId){
            const unsafe=await pool.query("SELECT 1 FROM bridge_jobs WHERE device_id=$1 AND (kind<>'choose-root' OR project_id IS NOT NULL OR state IN ('queued','running'))",[fixture.deviceId]);if(unsafe.rowCount){throw new Error('На временном устройстве есть незавершённые или посторонние задания');}
            await pool.query("DELETE FROM operations WHERE operation_id IN (SELECT 'bridge-'||id FROM bridge_jobs WHERE device_id=$1)",[fixture.deviceId]);await pool.query('DELETE FROM bridge_jobs WHERE device_id=$1',[fixture.deviceId]);await pool.query('DELETE FROM bridge_devices WHERE id=$1',[fixture.deviceId]);
        }
        await pool.query('DELETE FROM bridge_pairs WHERE code_hash=$1',[createHash('sha256').update(fixture.pair.deviceCode).digest('hex')]);await fs.rm(file,{force:true});console.log('Удалено только временное подключение плейтеста');
    }finally{await pool.end();}
}else{throw new Error('Неизвестный режим плейтеста');}
