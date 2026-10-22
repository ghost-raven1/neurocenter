import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,lstat} from 'node:fs/promises';
import {hostname,tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.PUBLICATION_TEST_PG_URL).href;

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const catalogDist=process.env.PUBLICATION_TEST_DIST||fileURLToPath(new URL('../../services/catalog-service/dist/',import.meta.url));
const skillsDist=process.env.SKILLS_TEST_DIST||fileURLToPath(new URL('../../services/skills-service/dist/',import.meta.url));
const {SkillAuditRepository}=require(path.join(catalogDist,'publication/skill-audit-repository.js'));
const {ensureCatalogSchema}=require(path.join(catalogDist,'database/catalog-schema.js'));
const {listAuditHistory}=require(path.join(catalogDist,'catalog/audit-history.js'));
const {FsSkillsStorage}=require(path.join(skillsDist,'storage/fs-skills-storage.js'));
const {deliverSkillAudit}=require(path.join(skillsDist,'storage/skill-audit.js'));
const {SkillsService}=require(path.join(skillsDist,'skills/skills.service.js'));
const {serializeSkillFile}=require(path.join(skillsDist,'storage/frontmatter.js'));
const adminUrl=adminConnection;
const reportPath=process.env.SKILL_AUDIT_TEST_REPORT||fileURLToPath(new URL('../../.run/skill-audit-db-smoke.json',import.meta.url));
const database='nc_skill_audit_test_'+randomBytes(8).toString('hex');
const directory=await mkdtemp(path.join(tmpdir(),'nc-skill-audit-'));
const admin=new Pool({connectionString:adminUrl,max:2});
const beforeDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const scenarios=[],stores=[],requests=[];
let pool,repository,server,created=false,ownDatabaseDropped=false,fatal,mode='normal';
let deliveryGate,notifyDeliveryGate;
const token=randomBytes(24).toString('hex'),actor='audit-qa@localhost';
process.env.NODE_ENV='production';process.env.NEUROCENTER_INTERNAL_TOKEN=token;
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const meta=(slug,version=1,generation=randomUUID())=>({generation,name:slug,slug,description:'Проверка аудита',scope:'common',mcp:[],plugins:[],tags:[],version,
    owner:'qa-author',updatedAt:new Date().toISOString(),history:[{version,at:new Date().toISOString(),author:'qa-author'}]});
const request=(slug,body='Закрытый текст инструкции')=>({path:'common',slug,name:slug,body,meta:{description:'Изолированная проверка аудита'}});
const count=async resource=>Number((await pool.query('SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1',[resource])).rows[0].n);
const rows=async resource=>(await pool.query('SELECT * FROM security_events WHERE resource_id=$1 ORDER BY created_at,event_id',[resource])).rows;
const newStorage=async root=>{const store=new FsSkillsStorage(root,undefined,deliverSkillAudit);stores.push(store);await store.init();await store.onModuleDestroy();return store;};
const journalDirectory=root=>path.join(root,'.neurocenter-sync-journal');
const journals=async root=>readdir(journalDirectory(root)).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
const post=async events=>fetch(process.env.CATALOG_SERVICE_URL+'/internal/skill-audit/events',{method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':token},body:JSON.stringify({events})});
const fixture=async(root,slug,state)=>{
    const skillPath='common/'+slug,skillMeta=meta(slug),raw=serializeSkillFile(skillMeta,'Текст прерванного процесса');
    const event={id:randomUUID(),at:new Date().toISOString(),actor,action:'skill.create',resourceId:skillPath,source:'editor',before:null,
        after:{generation:skillMeta.generation,version:1,sha256:digest(raw)}};
    await mkdir(path.join(root,'common'),{recursive:true});await mkdir(journalDirectory(root),{recursive:true});
    await writeFile(path.join(root,skillPath+'.md'),raw);
    const filename=path.join(journalDirectory(root),digest('common')+'.json');
    await writeFile(filename,JSON.stringify({version:1,id:randomUUID(),state,host:hostname(),pid:process.pid,
        changes:[{relative:skillPath+'.md',before:null,after:raw}],events:[event]}),{mode:0o600});
    return{skillPath,raw,event,filename};
};

// Прерывается только собственный одноразовый процесс, остановленный в реальной границе журнала.
const killAtCommit=async(root,stage)=>{
    const childCode=`const fs=require('node:fs/promises'),path=require('node:path');
        const cfg=JSON.parse(process.argv[1]);
        const {FsSkillsStorage}=require(path.join(cfg.dist,'storage/fs-skills-storage.js'));
        const wait=()=>new Promise(()=>{});
        if(cfg.stage==='prepared'){const rename=fs.rename.bind(fs);fs.rename=async(from,to)=>{
            if(String(to).includes('.neurocenter-sync-journal')&&/^[a-f0-9]{64}\\.json$/.test(path.basename(String(to)))){
                process.send({stage:'prepared'});await wait();
            }return rename(from,to);
        };}
        (async()=>{const storage=new FsSkillsStorage(cfg.root,undefined,async()=>{process.send({stage:'committed'});await wait();});
            await storage.init();await storage.createSkill('common/'+cfg.stage+'-kill',cfg.meta,'Текст перед SIGKILL',undefined,{actor:cfg.actor,source:'editor'});
        })().catch(error=>{process.send({error:error.message});process.exit(1);});`;
    const child=spawn(process.execPath,['-e',childCode,JSON.stringify({root,stage,dist:skillsDist,meta:meta(stage+'-kill'),actor})],
        {env:process.env,stdio:['ignore','ignore','ignore','ipc']});
    let timer;
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    try{
        await new Promise((resolve,reject)=>{
            timer=setTimeout(()=>reject(new Error('Не достигнута граница тестового процесса')),10000);
            child.once('error',reject);child.once('exit',()=>reject(new Error('Тестовый процесс завершился до границы')));
            child.on('message',message=>{if(message.stage===stage)resolve();else reject(new Error(message.error||'Неожиданная стадия процесса'));});
        });
        assert.equal(child.kill('SIGKILL'),true);assert.deepEqual(await exited,{code:null,signal:'SIGKILL'});
    }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
};

try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;
    pool=new Pool({connectionString:url.href,max:5,options:'-c statement_timeout=12000 -c lock_timeout=8000'});
    await ensureCatalogSchema(pool);repository=new SkillAuditRepository(pool);
    server=createServer(async(req,res)=>{
        const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
        try{
            if(req.headers['x-neurocenter-internal']!==token){send(403,{message:'Нет служебного доступа'});return;}
            if(req.method!=='POST'||req.url!=='/internal/skill-audit/events'){send(404,{message:'Нет маршрута'});return;}
            const chunks=[];for await(const chunk of req)chunks.push(chunk);
            const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
            if(mode==='unavailable'){send(503,{message:'Контролируемый отказ'});return;}
            if(mode==='gated'){notifyDeliveryGate();await deliveryGate;}
            const result=await repository.record(body);
            if(mode==='lost-ack'){mode='normal';req.socket.destroy();return;}
            send(201,mode==='malformed'?{accepted:0}:result);
        }catch(error){send(error.getStatus?.()||error.status||500,{message:error.message});}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    process.env.CATALOG_SERVICE_URL='http://127.0.0.1:'+server.address().port;
    assert.equal((await fetch(process.env.CATALOG_SERVICE_URL+'/internal/skill-audit/events',{method:'POST',body:'{}'})).status,403);
    const storage=await newStorage(directory),service=new SkillsService(storage);
    const createdSkill=await service.createSkill(request('crud'),'qa-author',actor);
    assert.equal(createdSkill.audit,undefined);assert.equal(await count('common/crud'),1);
    await service.updateSkill('common/crud',{expectedVersion:1,body:'Обновлённый закрытый текст'},'qa-author',actor);
    await assert.rejects(service.deleteSkill('common/crud',actor),error=>error.status===409);
    const expectedArchive=await service.inspectAssetSkill('common/crud'),archiveKey=randomUUID();
    const archivedSkill=await service.archiveAssetSkill('common/crud',expectedArchive,actor,false,archiveKey);
    assert.ok(archivedSkill.meta.archivedAt);
    await service.archiveAssetSkill('common/crud',expectedArchive,actor,false,archiveKey);
    assert.equal((await service.getSkill('common/crud',1)).body,createdSkill.body);
    const crudRows=await rows('common/crud');
    assert.deepEqual(crudRows.map(row=>row.action),['skill.create','skill.update','skill.update']);
    assert.ok(crudRows.every(row=>row.actor===actor));assert.equal(crudRows[0].before_state,null);assert.equal(crudRows[2].before_state.version,2);assert.equal(crudRows[2].after_state.version,3);
    assert.equal(crudRows[1].before_state.version,1);assert.equal(crudRows[1].after_state.version,2);
    assert.ok(crudRows.every(row=>(row.after_state||row.before_state).source==='editor'));
    const projectSkill=await service.createSkill({...request('crud-project'),path:'project-prj-audit'},'qa-author',actor);
    await service.deleteSkill(projectSkill.path,actor);
    assert.deepEqual((await rows(projectSkill.path)).map(row=>row.action),['skill.create','skill.delete']);
    scenarios.push('Реальные FS/service/HTTP/SQL: common DELETE запрещён, архив имеет один аудит и сохраняет версии; project CRUD пишет create/delete с доверенным actor');

    const stable=await service.createSkill(request('noop'),'qa-author',actor);
    const stableRaw=await readFile(path.join(directory,'common/noop.md'),'utf8');
    await service.updateSkill('common/noop',{expectedVersion:1,body:stable.body},'qa-author',actor);
    await assert.rejects(service.updateSkill('common/noop',{expectedVersion:9,body:'Не сохранить'},'qa-author',actor),error=>error.status===409);
    assert.equal(await count('common/noop'),1);assert.equal(await readFile(path.join(directory,'common/noop.md'),'utf8'),stableRaw);
    scenarios.push('Точный noop и CAS-конфликт не создают событий и не меняют файл');

    mode='unavailable';
    const pending=await service.createSkill(request('pending'),'qa-author',actor);
    assert.deepEqual(pending.audit,{state:'pending'});assert.equal((await storage.readSkill('common/pending')).body,pending.body);
    const pendingNoop=await service.updateSkill('common/pending',{expectedVersion:1,body:pending.body},'qa-author',actor);
    assert.deepEqual(pendingNoop.audit,{state:'pending'});assert.equal(await count('common/pending'),0);
    assert.equal(await storage.pendingAudit('common/pending'),true);
    const pendingFiles=await journals(directory);assert.equal(pendingFiles.filter(name=>name.endsWith('.json')).length,1);
    for(const name of pendingFiles.filter(name=>name.endsWith('.json'))){assert.equal((await lstat(path.join(journalDirectory(directory),name))).mode&0o777,0o600);}
    await assert.rejects(storage.flushSkillAudit());mode='normal';await storage.flushSkillAudit();
    assert.equal(await count('common/pending'),1);assert.equal(await storage.pendingAudit('common/pending'),false);
    scenarios.push('Отказ HTTP после файлового commit возвращает сохранённый результат с pending, оставляет закрытый outbox и допускает безопасный flush');

    mode='unavailable';
    for(const slug of ['backlog-one','backlog-two','backlog-three']){await service.createSkill(request(slug),'qa-author',actor);}
    let releaseDelivery,gateReached,timer;
    deliveryGate=new Promise(resolve=>{releaseDelivery=resolve;});
    const entered=new Promise(resolve=>{gateReached=resolve;});notifyDeliveryGate=gateReached;mode='gated';
    const savedWithBacklog=service.createSkill(request('backlog-current'),'qa-author',actor);
    try{
        const [result]=await Promise.race([Promise.all([savedWithBacklog,entered]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Сохранение ждёт чужой HTTP outbox вместо pending')),3000);})]);
        assert.deepEqual(result.audit,{state:'pending'});
        assert.equal((await storage.readSkill('common/backlog-current')).meta.version,1);
        assert.equal(await count('common/backlog-current'),0);assert.equal(await storage.pendingAudit('common/backlog-current'),true);
    }finally{clearTimeout(timer);mode='normal';releaseDelivery();await savedWithBacklog.catch(()=>undefined);}
    await storage.flushSkillAudit();assert.equal(await count('common/backlog-current'),1);
    assert.equal(await storage.pendingAudit(),false);
    scenarios.push('Удержанный настоящий HTTP ACK старого outbox не блокирует ответ нового сохранения; pending доставляется после освобождения без повторной записи');

    mode='lost-ack';const lost=await service.createSkill(request('lost-ack'),'qa-author',actor);
    assert.deepEqual(lost.audit,{state:'pending'});assert.equal(await count('common/lost-ack'),1);
    await storage.flushSkillAudit();assert.equal(await count('common/lost-ack'),1);assert.equal(await storage.pendingAudit('common/lost-ack'),false);
    const lostDeliveries=requests.flatMap(body=>body.events).filter(event=>event.resourceId==='common/lost-ack');
    assert.equal(lostDeliveries.length,2);assert.equal(lostDeliveries[0].id,lostDeliveries[1].id);
    scenarios.push('SQL COMMIT и потеря HTTP ACK повторяются с прежним UUID: ровно одно событие');

    await service.createSkill(request('sql-failure'),'qa-author',actor);
    await pool.query("ALTER TABLE security_events ADD CONSTRAINT qa_skill_audit_failure CHECK(action<>'skill.update') NOT VALID");
    const sqlPending=await service.updateSkill('common/sql-failure',{expectedVersion:1,body:'Сохранено при отказе SQL'},'qa-author',actor);
    assert.deepEqual(sqlPending.audit,{state:'pending'});assert.equal(sqlPending.meta.version,2);assert.equal(await count('common/sql-failure'),1);
    assert.equal((await pool.query("SELECT 1 FROM skill_audit_receipts WHERE payload->>'resourceId'='common/sql-failure'")).rowCount,1);
    await pool.query('ALTER TABLE security_events DROP CONSTRAINT qa_skill_audit_failure');await storage.flushSkillAudit();
    assert.equal(await count('common/sql-failure'),2);assert.equal((await storage.readSkill('common/sql-failure')).meta.version,2);
    scenarios.push('Настоящий SQL CHECK откатывает квитанцию вместе с событием, сохраняя уже завершённую файловую запись до повтора');

    mode='malformed';const malformed=await service.createSkill(request('malformed-ack'),'qa-author',actor);
    assert.deepEqual(malformed.audit,{state:'pending'});assert.equal(await count('common/malformed-ack'),1);
    mode='normal';await storage.flushSkillAudit();assert.equal(await count('common/malformed-ack'),1);
    scenarios.push('Неверный accepted не стирает outbox; повтор подтверждает прежнее событие без дубля');

    const prior=requests.flatMap(body=>body.events).find(event=>event.resourceId==='common/noop');
    assert.equal((await post([prior,prior])).status,201);assert.equal(await count('common/noop'),1);
    assert.equal((await post([{...prior,actor:'other@example.test'}])).status,409);
    const fresh={...prior,id:'00000000-0000-0000-0000-000000000001',resourceId:'common/transaction-aborted'};
    assert.equal((await post([fresh,{...prior,actor:'other@example.test'}])).status,409);
    assert.equal(await count(fresh.resourceId),0);assert.equal((await pool.query('SELECT 1 FROM skill_audit_receipts WHERE event_id=$1',[fresh.id])).rowCount,0);
    assert.equal((await post([{...prior,body:'Нельзя передавать тело'}])).status,400);
    scenarios.push('Повтор UUID идемпотентен; другой payload даёт 409, смешанный пакет целиком откатывается, лишние поля дают 400');

    const concurrentEvent={...prior,id:randomUUID(),resourceId:'common/concurrent-http'};
    const concurrentResponses=await Promise.all([post([concurrentEvent]),post([concurrentEvent]),post([concurrentEvent])]);
    assert.deepEqual(concurrentResponses.map(response=>response.status),[201,201,201]);
    assert.equal(await count(concurrentEvent.resourceId),1);
    scenarios.push('Три конкурентные HTTP-доставки одного UUID фиксируют единственное SQL-событие');

    await service.syncSkills('qa-audit',[{slug:'a',name:'a',body:'А'},{slug:'b',name:'b',body:'Б'}],actor);
    const syncBefore=(await pool.query("SELECT * FROM security_events WHERE resource_id LIKE 'project-qa-audit/%'")).rows;
    assert.equal(syncBefore.length,2);
    const repeat=await service.syncSkills('qa-audit',[{slug:'a',name:'a',body:'А'},{slug:'b',name:'b',body:'Б'}],actor);assert.equal(repeat.upserted,0);
    await service.syncSkills('qa-audit',[{slug:'a',name:'a',body:'А изменено'},{slug:'c',name:'c',body:'В'}],actor);
    const syncRows=(await pool.query("SELECT * FROM security_events WHERE resource_id LIKE 'project-qa-audit/%'")).rows;
    assert.equal(syncRows.length,5);assert.ok(syncRows.every(row=>row.actor===actor&&(row.after_state||row.before_state).source==='sync'));
    assert.equal((await storage.readSkill('project-qa-audit/a')).meta.history.at(-1).author,'mcp-sync');
    scenarios.push('Смешанный sync пишет только реальные create/update/delete, повтор не добавляет события, служебный history author сохранён');

    const preparedRoot=path.join(directory,'prepared-case'),prepared=await fixture(preparedRoot,'prepared','prepared');
    await newStorage(preparedRoot);await assert.rejects(readFile(path.join(preparedRoot,prepared.skillPath+'.md')),error=>error.code==='ENOENT');
    assert.equal(await count(prepared.skillPath),0);assert.deepEqual(await journals(preparedRoot),[]);
    scenarios.push('Подготовленный журнал частичной записи восстанавливается откатом без событий аудита');

    const committedRoot=path.join(directory,'committed-case'),committed=await fixture(committedRoot,'committed','committed');
    await newStorage(committedRoot);assert.equal(await readFile(path.join(committedRoot,committed.skillPath+'.md'),'utf8'),committed.raw);
    assert.equal(await count(committed.skillPath),1);assert.deepEqual(await journals(committedRoot),[]);
    scenarios.push('Committed-журнал после перезапуска доставляется без повторного исполнения файловой мутации');

    const killedPrepared=path.join(directory,'killed-prepared');await killAtCommit(killedPrepared,'prepared');
    assert.equal(await readFile(path.join(killedPrepared,'common/prepared-kill.md'),'utf8').then(()=>true),true);
    await newStorage(killedPrepared);await assert.rejects(readFile(path.join(killedPrepared,'common/prepared-kill.md')),error=>error.code==='ENOENT');
    assert.equal(await count('common/prepared-kill'),0);
    scenarios.push('Настоящий SIGKILL до commit: частично опубликованный файл откатывается, событий нет');

    const killedCommitted=path.join(directory,'killed-committed');await killAtCommit(killedCommitted,'committed');
    const killedRaw=await readFile(path.join(killedCommitted,'common/committed-kill.md'),'utf8');
    await newStorage(killedCommitted);assert.equal(await readFile(path.join(killedCommitted,'common/committed-kill.md'),'utf8'),killedRaw);
    assert.equal(await count('common/committed-kill'),1);assert.deepEqual(await journals(killedCommitted),[]);
    scenarios.push('Настоящий SIGKILL после commit до ACK: файл сохранён, перезапуск доставляет единственное событие');

    const restartRoot=path.join(directory,'restart-case'),offline=await newStorage(restartRoot),offlineService=new SkillsService(offline);
    mode='unavailable';await offlineService.createSkill(request('restart'),'qa-author',actor);
    await offlineService.updateSkill('common/restart',{expectedVersion:1,body:'Следующая версия уже на диске'},'qa-author',actor);
    const finalRaw=await readFile(path.join(restartRoot,'common/restart.md'),'utf8');
    assert.equal((await journals(restartRoot)).filter(name=>name.endsWith('.json')).length,2);
    mode='normal';const restarted=await newStorage(restartRoot);assert.equal(await count('common/restart'),2);
    assert.equal(await readFile(path.join(restartRoot,'common/restart.md'),'utf8'),finalRaw);assert.equal(await restarted.pendingAudit(),false);
    scenarios.push('Две последовательные версии не блокируются ожидающим аудитом и после рестарта доставляются без отката последнего head');

    const siblings=await Promise.all(['one','two','three'].map(slug=>storage.createSkill('concurrent/'+slug,meta(slug),'Конкурентная запись',undefined,{actor,source:'editor'})));
    assert.deepEqual(siblings,[true,true,true]);
    const raceMeta=meta('same'),races=await Promise.all([1,2].map(()=>storage.createSkill('concurrent/same',raceMeta,'Один победитель',undefined,{actor,source:'editor'})));
    assert.deepEqual(races.sort(),[false,true]);assert.equal(await count('concurrent/same'),1);
    scenarios.push('Соседние файлы одной коллекции сериализуются, гонка create одного пути имеет одного победителя и одно событие');

    const corruptRoot=path.join(directory,'corrupt-case');await mkdir(journalDirectory(corruptRoot),{recursive:true});
    const corruptFile=path.join(journalDirectory(corruptRoot),digest('common')+'.json');await writeFile(corruptFile,'{broken');
    const corrupt=new FsSkillsStorage(corruptRoot,undefined,deliverSkillAudit);stores.push(corrupt);
    await assert.rejects(corrupt.init());assert.equal(await readFile(corruptFile,'utf8'),'{broken');assert.equal(await corrupt.pendingAudit(),true);
    scenarios.push('Повреждённый журнал останавливает init, остаётся на диске и не объявляется подтверждённым');

    const history=await listAuditHistory(pool,1,200);
    assert.ok(history.items.length>10);assert.ok(history.items.every(event=>event.resourceType==='skill'&&event.details===null));
    const sqlPayloads=(await pool.query('SELECT payload FROM skill_audit_receipts')).rows.map(row=>row.payload);
    assert.ok(sqlPayloads.every(event=>Object.keys(event).sort().join(',')==='action,actor,after,at,before,id,resourceId,source'));
    assert.ok(sqlPayloads.every(event=>[event.before,event.after].filter(Boolean).every(summary=>Object.keys(summary).sort().join(',')==='generation,sha256,version')));
    assert.equal(JSON.stringify(sqlPayloads).includes('Закрытый текст'),false);
    scenarios.push('SQL хранит только фиксированные сводки; публичная история показывает actor/путь/действие без приватного payload');
    console.log(JSON.stringify({ok:true,scenarios:scenarios.length}));
}catch(error){fatal=error.stack||String(error);console.error(fatal);process.exitCode=1;}
finally{
    for(const store of stores){await store.onModuleDestroy();}
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await pool?.end();
    if(created){await admin.query(`DROP DATABASE "${database}"`);ownDatabaseDropped=true;}
    const afterDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const originalDatabasesPreserved=JSON.stringify(beforeDatabases)===JSON.stringify(afterDatabases);await admin.end();
    await rm(directory,{recursive:true,force:true});await mkdir(path.dirname(reportPath),{recursive:true});
    await writeFile(reportPath,JSON.stringify({ok:!fatal&&ownDatabaseDropped&&originalDatabasesPreserved,scenarios,fatal:fatal||null,
        ownDatabaseDropped,ownDirectoryRemoved:true,originalDatabasesPreserved,realCatalogRowsCreated:false,
        protocol:'Actual repository/storage/service/HTTP client, two disposable-process SIGKILL checks; isolated HTTP route adapter and temporary PostgreSQL, not Nest startup or OS power loss'},null,2)+'\n');
    if(!originalDatabasesPreserved)process.exitCode=1;
}
