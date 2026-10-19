// Конкурентные запросы и сбои проверяются только на собственных временных сущностях.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(new URL('../../',import.meta.url).pathname);
const require=createRequire(path.join(root,'services/catalog-service/package.json'));const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',application_name:'qa-concurrency'});
const {io}=await import(path.join(root,'mcp/neurocenter-asset-sync/node_modules/socket.io-client/build/esm/index.js'));
const base=process.env.NEUROCENTER_TEST_URL||'http://localhost:5173';
const reportPath=process.env.NEUROCENTER_QA_REPORT||path.join(root,'.run/qa-continue/concurrency.json');
const login=await fetch(base+'/auth/login',{redirect:'manual'});const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const results=[];const projects=[];const devices=[];const pairs=[];const plugins=[];const planIds=[];let token;let deviceId;let project;let socket;const events=[];let authEvents=0;
async function request(method,route,body,device=false){
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Neurocenter-Request':'1',...(device?{Authorization:'Bearer '+token}:{Cookie:cookie})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data={message:'Нечитаемый ответ'};}return {status:response.status,data};
}
async function call(method,route,body,status=200,device=false){const result=await request(method,route,body,device);assert.equal(result.status,status,method+' '+route+': '+String(result.data?.message||result.status));return result.data;}
async function check(name,action){try{await action();results.push({case:name,ok:true});}catch(error){results.push({case:name,ok:false,error:error.message});}}
const makeJob=(extra={})=>call('POST','/api/device-jobs',{deviceId,projectId:project.id,kind:'bind-project',folderName:'Проверочная папка',requestKey:randomUUID(),...extra},201);
const claim=()=>call('POST','/api/device-channel/jobs/claim',{},201,true);
const progress=(job,input,status=201)=>call('POST','/api/device-channel/jobs/'+job.id+'/progress',{lease:job.lease,message:'Проверка очереди',...input},status,true);
const complete=(job,result,status=201)=>call('POST','/api/device-channel/jobs/'+job.id+'/complete',{lease:job.lease,state:'succeeded',message:'Проверка завершения',result},status,true);
const report=()=>call('POST','/api/device-channel/heartbeat',{protocolVersion:2,bridgeVersion:'0.5.0',capabilities:['durable-completions','managed-installations','package-v3','package-v4','install-set-v1'],bindings:[{projectId:project.id,folderName:'Проверочная папка',bindingId:'a'.repeat(64),valid:true}]},201,true);
const state=async id=>(await pool.query('SELECT state,percent,message FROM bridge_jobs WHERE id=$1',[id])).rows[0];
const operation=async id=>(await pool.query("SELECT state,percent FROM operations WHERE operation_id='bridge-'||$1",[id])).rows[0];
async function clearPending(){const {rows}=await pool.query("UPDATE bridge_jobs SET state='cancelled' WHERE device_id=$1 AND state IN ('queued','running','reconciling') RETURNING id",[deviceId]);for(const {id} of rows){await pool.query("UPDATE operations SET state='CANCELLED' WHERE operation_id='bridge-'||$1",[id]);}}
try{
    await call('POST','/auth/switch-role',{role:'Главный админ'});
    const suffix=randomUUID().slice(0,8);const name='Проверка конкуренции '+suffix;
    await check('Одновременное создание одинакового проекта сохраняет ровно один',async()=>{
        const responses=await Promise.all(Array.from({length:8},()=>request('POST','/api/projects',{name})));
        const created=responses.filter(value=>value.status===201);projects.push(...created.map(value=>value.data));assert.equal(created.length,1);assert.equal(responses.filter(value=>value.status===409).length,7);
    });
    project=projects[0];assert.ok(project);
    const trackedFile=path.join(root,'.run/qa/project-fixtures.json');await fs.mkdir(path.dirname(trackedFile),{recursive:true});const tracked=JSON.parse(await fs.readFile(trackedFile,'utf8').catch(()=>'[]'));tracked.push({id:project.id,database:'nc_rag_'+createHash('sha256').update(project.id).digest('hex').slice(0,32)});await fs.writeFile(trackedFile,JSON.stringify(tracked));
    await fs.mkdir(path.join(root,'.run/qa-continue'),{recursive:true});await fs.writeFile(path.join(root,'.run/qa-continue/fixtures.json'),JSON.stringify(projects.map(({id,name})=>({id,name})),null,2));
    const pair=await call('POST','/api/device-channel/pair/start',{name:'Проверка конкурентного MCP '+suffix,fingerprint:randomBytes(32).toString('hex')},201);pairs.push(createHash('sha256').update(pair.deviceCode).digest('hex'));
    await call('POST','/api/device-pairs/'+pair.userCode+'/approve',{},201);
    await check('Одновременный обмен кода подключения выдаёт только один ключ',async()=>{
        const responses=await Promise.all(Array.from({length:8},()=>request('POST','/api/device-channel/pair/poll',{deviceCode:pair.deviceCode})));
        const connected=responses.filter(value=>value.status===201);assert.equal(connected.length,1);assert.equal(responses.filter(value=>value.status===409).length,7);
        token=connected[0].data.token;deviceId=connected[0].data.deviceId;devices.push(deviceId);
    });
    await report();
    socket=io(base,{transports:['websocket'],extraHeaders:{Cookie:cookie},forceNew:true});socket.on('section:changed',payload=>events.push(payload));socket.on('auth:changed',()=>authEvents++);
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Нет соединения WebSocket')),5000);socket.once('connect',()=>{clearTimeout(timeout);resolve();});socket.once('connect_error',error=>{clearTimeout(timeout);reject(error);});});
    await check('Пустая очередь отдаёт JSON null, который читает MCP',async()=>{assert.equal(await claim(),null);});
    await check('Удаление проекта обновляет доступ и роли открытого интерфейса через WebSocket',async()=>{
        const disposable=await call('POST','/api/projects',{name:'Проверка удаления доступа '+suffix},201);projects.push(disposable);
        const tracked=JSON.parse(await fs.readFile(trackedFile,'utf8'));tracked.push({id:disposable.id,database:'nc_rag_'+createHash('sha256').update(disposable.id).digest('hex').slice(0,32)});await fs.writeFile(trackedFile,JSON.stringify(tracked));
        const email=(await call('GET','/auth/me')).user.email;const granted=authEvents;
        await call('POST','/api/projects/'+disposable.id+'/members',{principalName:email,role:'Разработчик'},201);
        for(let index=0;index<40&&authEvents===granted;index++){await delay(25);}assert.ok(authEvents>granted,'Назначение не обновило доступ');
        const before=authEvents;const beforeSections=events.length;await call('DELETE','/api/projects/'+disposable.id);
        for(let index=0;index<40&&authEvents===before;index++){await delay(25);}assert.ok(authEvents>before,'Удаление не обновило роли шапки');
        assert.ok(events.slice(beforeSections).some(event=>event.sections.includes('access')),'Участники не обновили список назначений');
        assert.equal((await call('GET','/auth/me')).user.projectRoles.some(item=>item.projectId===disposable.id),false);
    });
    await check('WebSocket обновляет проекты при постановке и отмене задания',async()=>{
        const before=events.length;const queued=await makeJob();for(let index=0;index<40&&!events.slice(before).some(event=>event.sections.includes('projects'));index++){await delay(25);}assert.ok(events.slice(before).some(event=>event.sections.includes('projects')));
        const next=events.length;await call('DELETE','/api/device-jobs/'+queued.id);for(let index=0;index<40&&!events.slice(next).some(event=>event.sections.includes('projects'));index++){await delay(25);}assert.ok(events.slice(next).some(event=>event.sections.includes('projects')));
    });
    await check('Шестнадцать одинаковых запросов создают одно задание и одну операцию',async()=>{
        const key=randomUUID();const responses=await Promise.all(Array.from({length:16},()=>makeJob({requestKey:key})));
        assert.equal(new Set(responses.map(value=>value.id)).size,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM bridge_jobs WHERE email=$1 AND request_key=$2',[(await call('GET','/auth/me')).user.email,key])).rows[0].n,1);
        assert.ok(await operation(responses[0].id));await clearPending();
    });
    await check('Повтор JSON с другим порядком полей сохраняет исходное задание',async()=>{
        const key=randomUUID();const first=await makeJob({requestKey:key});const second=await call('POST','/api/device-jobs',{requestKey:key,folderName:'Проверочная папка',kind:'bind-project',projectId:project.id,deviceId},201);assert.equal(second.id,first.id);
    });await clearPending();
    await check('Тот же ключ с другим содержимым возвращает конфликт без дубля',async()=>{
        const key=randomUUID();const first=await makeJob({requestKey:key});await call('POST','/api/device-jobs',{deviceId,projectId:project.id,kind:'bind-project',folderName:'Другая папка',requestKey:key},409);assert.equal((await state(first.id)).state,'queued');
    });await clearPending();
    await check('Два одновременных получения не получают одно задание дважды',async()=>{
        const pending=await makeJob();const claims=await Promise.all([claim(),claim()]);const nonempty=claims.filter(Boolean);assert.equal(nonempty.length,1);assert.equal(nonempty[0].id,pending.id);await progress(nonempty[0],{state:'failed'});
    });
    await check('Двадцать гонок отмены и получения заканчиваются согласованным состоянием',async()=>{
        for(let index=0;index<20;index++){
            const pending=await makeJob();const [cancelled,claimed]=await Promise.all([request('DELETE','/api/device-jobs/'+pending.id),claim()]);
            if(cancelled.status===200){assert.equal(claimed,null);assert.equal((await state(pending.id)).state,'cancelled');assert.equal((await operation(pending.id)).state,'CANCELLED');}
            else{assert.equal(cancelled.status,409);assert.equal(claimed.id,pending.id);await progress(claimed,{state:'failed'});assert.equal((await operation(pending.id)).state,'FAILED');}
        }
    });
    await check('Старая или чужая аренда не обновляет прогресс',async()=>{
        await makeJob();const current=await claim();await progress({...current,lease:randomUUID()},{state:'running',percent:40},409);assert.equal((await state(current.id)).percent,0);await progress(current,{state:'failed'});
    });
    await check('Запоздалый heartbeat не уменьшает достигнутый прогресс',async()=>{
        await makeJob();const current=await claim();try{await progress(current,{state:'running',percent:73});await progress(current,{state:'running',percent:20});assert.equal((await state(current.id)).percent,73);assert.equal((await operation(current.id)).percent,73);}finally{await progress(current,{state:'failed'});}
    });
    await check('Ошибка без percent сохраняет один прогресс в очереди и журнале',async()=>{
        await makeJob();const current=await claim();await progress(current,{state:'running',percent:73});await progress(current,{state:'failed'});assert.equal((await state(current.id)).percent,73);assert.equal((await operation(current.id)).percent,73);
    });
    await check('Установка требует одобрения точного плана и не принимает успех с подменённой квитанцией',async()=>{
        const plugin=await call('POST','/api/ai-plugins',{publicationKey:randomUUID(),name:'Проверочный MCP '+suffix,kind:'mcp',description:'Синтетический MCP для проверки контракта без запуска',files:[],config:{transport:'remote',url:'https://example.test/mcp'}},201);plugins.push(plugin.id);
        await call('POST','/api/projects/'+project.id+'/assets',{assetKind:'mcp',assetId:plugin.id},201);
        const plan=await call('POST','/api/device-install-plans',{projectId:project.id,assetKind:'mcp',assetId:plugin.id,version:1},201);planIds.push(plan.id);assert.equal(plan.status,'pending');
        const input={deviceId,projectId:project.id,kind:'install',assetKind:'mcp',assetId:plugin.id,version:1,planId:plan.id,planRevision:plan.revision};
        await call('POST','/api/device-jobs',{...input,requestKey:randomUUID()},409);
        const beforeApproval=events.length;
        const approved=await call('POST','/api/device-install-plans/'+plan.id+'/approve',{expectedManifest:plan.manifest,expectedRevision:plan.revision},201);assert.equal(approved.status,'approved');
        for(let index=0;index<40&&!events.slice(beforeApproval).some(event=>event.sections.includes('catalog'));index++){await delay(25);}
        assert.ok(events.slice(beforeApproval).some(event=>event.sections.includes('catalog')),'Одобрение не обновило каталог через WebSocket');
        const pending=await call('POST','/api/device-jobs',{...input,planRevision:approved.revision,requestKey:randomUUID()},201);const current=await claim();assert.equal(current.id,pending.id);
        const result={projectId:project.id,assetId:plugin.id,version:1,manifest:plan.manifest,bindingId:'a'.repeat(64)};
        await progress(current,{state:'succeeded'},409);
        await complete(current,{...result,manifest:'b'.repeat(64)},409);
        assert.equal((await state(current.id)).state,'running');
        await complete(current,result);assert.equal((await state(current.id)).state,'succeeded');
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='installation.approved'",[plan.id])).rows[0].n,1);
    });await clearPending();
    await check('Завершение устанавливает 100 процентов и не принимает повторный отчёт',async()=>{
        await makeJob();const current=await claim();await complete(current,{projectId:project.id});assert.equal((await state(current.id)).percent,100);assert.equal((await operation(current.id)).percent,100);await progress(current,{state:'running',percent:1},409);
    });
    await check('Истёкшая аренда требует сверку исходного результата, затем завершает привязку без повтора',async()=>{
        await makeJob();const current=await claim();await pool.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[current.id]);await progress(current,{state:'succeeded',percent:100},409);await call('GET','/api/device-jobs');assert.equal((await state(current.id)).state,'reconciling');assert.equal((await operation(current.id)).state,'RUNNING');await complete(current,{projectId:project.id});assert.equal((await state(current.id)).state,'succeeded');
    });
    await check('Вектор вне диапазона float32 возвращает 400 и не удаляет прежние строки',async()=>{
        const row={id:'before',filePath:'README.md',content:'Прежний текст',embedding:null};await call('POST','/api/rag/sync',{projectKey:project.id,chunks:[row]},201);
        await call('POST','/api/rag/sync',{projectKey:project.id,deletes:['before'],chunks:[{...row,id:'overflow',embedding:Array(2560).fill(1e100)}]},400);
        assert.equal((await call('GET','/api/rag/manifest?projectKey='+project.id)).count,1);
    });
    await check('Прерывание подключения завершает очередь и активное задание отключённого MCP',async()=>{
        await makeJob();const running=await claim();await progress(running,{state:'running',percent:42});const waiting=await makeJob();
        await call('DELETE','/api/devices/'+deviceId);assert.equal((await state(waiting.id)).state,'cancelled');assert.equal((await operation(waiting.id)).state,'CANCELLED');
        assert.equal((await state(running.id)).state,'failed');assert.equal((await operation(running.id)).state,'FAILED');assert.equal((await operation(running.id)).percent,42);
        assert.equal((await call('GET','/api/projects/'+project.id)).activeOperations,0);await progress(running,{state:'succeeded'},401);
    });
    await check('Гонка создания заданий и отключения MCP не оставляет вечную очередь',async()=>{
        const secondPair=await call('POST','/api/device-channel/pair/start',{name:'Проверка отключения '+suffix,fingerprint:randomBytes(32).toString('hex')},201);pairs.push(createHash('sha256').update(secondPair.deviceCode).digest('hex'));
        await call('POST','/api/device-pairs/'+secondPair.userCode+'/approve',{},201);const connected=await call('POST','/api/device-channel/pair/poll',{deviceCode:secondPair.deviceCode},201);devices.push(connected.deviceId);deviceId=connected.deviceId;token=connected.token;await report();
        const input=()=>({deviceId,projectId:project.id,kind:'bind-project',folderName:'Проверочная папка',requestKey:randomUUID()});
        const responses=await Promise.all([...Array.from({length:12},()=>request('POST','/api/device-jobs',input())),request('DELETE','/api/devices/'+deviceId)]);
        assert.equal(responses.pop().status,200);assert.equal(responses.every(value=>[201,403].includes(value.status)),true);
        const pending=await pool.query("SELECT count(*)::int AS n FROM bridge_jobs WHERE device_id=$1 AND state IN ('queued','running')",[deviceId]);assert.equal(pending.rows[0].n,0);
    });
}finally{
    socket?.disconnect();
    for(const id of devices){await pool.query("DELETE FROM operations WHERE operation_id IN (SELECT 'bridge-'||id FROM bridge_jobs WHERE device_id=$1)",[id]);await pool.query('DELETE FROM bridge_jobs WHERE device_id=$1',[id]);await pool.query('DELETE FROM bridge_devices WHERE id=$1',[id]);}
    for(const hash of pairs){await pool.query('DELETE FROM bridge_pairs WHERE code_hash=$1',[hash]);}
    for(const created of projects){
        await call('DELETE','/api/projects/'+created.id).catch(()=>undefined);
        await pool.query('DELETE FROM operations WHERE project_id=$1 OR resource_id=$1',[created.id]);
        if(!(await pool.query('SELECT 1 FROM projects WHERE id=$1',[created.id])).rowCount){
            // Проект и его база созданы только этим запуском; чужие базы не перебираются.
            const database='nc_rag_'+createHash('sha256').update(created.id).digest('hex').slice(0,32);
            await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        }
    }
    for(const id of plugins){await call('DELETE','/api/ai-plugins/'+id);}
    if(planIds.length){await pool.query('DELETE FROM security_events WHERE resource_id=ANY($1::text[])',[planIds]);}
    await pool.end();await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify({results,passed:results.filter(item=>item.ok).length,failed:results.filter(item=>!item.ok).length},null,2));
}
console.log(JSON.stringify({passed:results.filter(item=>item.ok).length,failed:results.filter(item=>!item.ok)}));if(results.some(item=>!item.ok)){process.exitCode=1;}
