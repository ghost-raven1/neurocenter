import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {hostname,tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.PUBLICATION_TEST_PG_URL).href;

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const catalogDist=process.env.PUBLICATION_TEST_DIST||fileURLToPath(new URL('../../services/catalog-service/dist/',import.meta.url));
const skillsDist=process.env.SKILLS_TEST_DIST||fileURLToPath(new URL('../../services/skills-service/dist/',import.meta.url));
const {PluginRepository}=require(path.join(catalogDist,'publication/plugin-repository.js'));
const {reserveSkillDependencies:reserveSql}=require(path.join(catalogDist,'publication/skill-dependency-registry.js'));
const {ensureCatalogSchema}=require(path.join(catalogDist,'database/catalog-schema.js'));
const {buildPackage}=require(path.join(catalogDist,'catalog/bundle-package.js'));
const {FsSkillsStorage}=require(path.join(skillsDist,'storage/fs-skills-storage.js'));
const {reserveSkillDependencies:reserveHttp,dependencyReservation}=require(path.join(skillsDist,'storage/skill-dependency-reservation.js'));
const {SkillsService}=require(path.join(skillsDist,'skills/skills.service.js'));
const {versionRelative}=require(path.join(skillsDist,'storage/skill-versions.js'));
const {scanSkillDependencyUsage}=require(path.join(skillsDist,'storage/skill-dependency-usage.js'));
const {serializeSkillFile}=require(path.join(skillsDist,'storage/frontmatter.js'));
const adminUrl=adminConnection;
const reportPath=process.env.SKILL_DEPENDENCIES_TEST_REPORT||fileURLToPath(new URL('../../.run/skill-dependencies-db-smoke.json',import.meta.url));
const database='nc_skill_refs_test_'+randomBytes(8).toString('hex');
const directory=await mkdtemp(path.join(tmpdir(),'nc-skill-ref-protocol-'));
const admin=new Pool({connectionString:adminUrl,max:2});
const beforeDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const scenarios=[];
let pool,repository,server,reservationPool,created=false,ownDatabaseDropped=false,fatal;
let reserveMode='normal',scanMode='normal';
const token=randomBytes(24).toString('hex');
process.env.NODE_ENV='production';
process.env.NEUROCENTER_INTERNAL_TOKEN=token;
const observed=promise=>promise.then(value=>({value}),error=>({error}));
const successful=async promise=>{const result=await promise;if(result.error)throw result.error;return result.value;};
const rejected=async(promise,status)=>{const result=await promise;assert.ok(result.error);assert.equal(result.error.status,status);};
const within=async(promise)=>{
    let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Истекло ожидание SQL-блокировки')),7000);})]);}
    finally{clearTimeout(timer);}
};
// Задерживает настоящий advisory lock, не подменяя SQL или результат мутации.
const gatePool=()=>{
    let notifyAttempt,notifyAcquired,release;
    const attempt=new Promise(resolve=>{notifyAttempt=resolve;});
    const acquired=new Promise(resolve=>{notifyAcquired=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    return{attempt,acquired,release:()=>release(),pool:{async connect(){
        const client=await pool.connect(),pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return{async query(sql,params){
            const graph=String(sql).startsWith('SELECT pg_advisory_xact_lock')&&params?.[0]==='publication:dependency-graph';
            if(graph)notifyAttempt(pid);
            const result=await client.query(sql,params);
            if(graph){notifyAcquired(pid);await gate;}
            return result;
        },release(){client.release();}};
    }}};
};
const assertBlocked=async(pid,by)=>{
    const deadline=Date.now()+5000;
    do{const blockers=(await pool.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0].blockers;
        if(blockers.includes(by))return;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<deadline);
    assert.fail('Операция не ждала настоящую блокировку графа');
};
const plugin=async suffix=>repository.create({name:'Ссылки '+suffix+' '+randomUUID(),kind:'mcp',description:'Изолированная проверка',
    config:{transport:'remote',url:'https://example.test/mcp'},publicationKey:randomUUID()},'qa');
const pinFor=entry=>({id:entry.id,kind:entry.kind,version:entry.version,manifest:buildPackage(
    {id:entry.id,name:entry.name,kind:entry.kind,version:entry.version},[], '',entry.config).manifest.sha256});
const meta=(slug,pins=[],version=1,generation=randomUUID())=>({generation,name:slug,slug,description:'Изолированная проверка зависимости',scope:'common',mcp:[],plugins:[],tags:[],version,
    dependencies:pins,owner:'qa',updatedAt:new Date().toISOString(),history:[{version,at:new Date().toISOString(),author:'qa'}]});
const exists=async relative=>{try{await readFile(path.join(directory,relative+'.md'));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const reservationCount=async()=>Number((await pool.query('SELECT count(*)::int AS n FROM skill_dependency_reservations')).rows[0].n);

try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;
    pool=new Pool({connectionString:url.href,max:7,options:'-c statement_timeout=12000 -c lock_timeout=8000'});reservationPool=pool;
    await ensureCatalogSchema(pool);
    repository=new PluginRepository(pool);
    server=createServer(async(req,res)=>{
        const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
        try{
            if(req.headers['x-neurocenter-internal']!==token){send(403,{message:'Нет служебного доступа'});return;}
            const url=new URL(req.url,'http://127.0.0.1');
            if(req.method==='POST'&&url.pathname==='/internal/skill-dependencies/reserve'){
                if(reserveMode==='unavailable'){send(503,{message:'Контролируемый отказ'});return;}
                const chunks=[];for await(const chunk of req)chunks.push(chunk);
                const result=await reserveSql(reservationPool,JSON.parse(Buffer.concat(chunks).toString()));
                if(reserveMode==='lost-ack'){reserveMode='normal';req.socket.destroy();return;}
                send(201,{ok:true,...result});return;
            }
            if(req.method==='GET'&&url.pathname==='/internal/skill-dependencies/usage'){
                if(scanMode==='unavailable'){send(503,{message:'Контролируемый отказ'});return;}
                if(scanMode==='malformed'){send(200,{inUse:'false'});return;}
                send(200,{inUse:await scanSkillDependencyUsage(directory,url.searchParams.get('assetId'))});return;
            }
            send(404,{message:'Нет маршрута'});
        }catch(error){send(error.getStatus?.()||error.status||500,{message:error.message});}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base='http://127.0.0.1:'+server.address().port;
    process.env.CATALOG_SERVICE_URL=base;process.env.SKILLS_SERVICE_URL=base;
    const storage=new FsSkillsStorage(directory,reserveHttp),legacy=new FsSkillsStorage(directory);
    await storage.init();
    assert.equal((await fetch(base+'/internal/skill-dependencies/usage?assetId=ai-plug-no-access')).status,403);
    assert.equal((await fetch(base+'/internal/skill-dependencies/reserve',{method:'POST',body:'{}'})).status,403);
    scenarios.push('Оба служебных HTTP-маршрута требуют внутренний токен; используются настоящие клиенты, SQL и файлы');

    const first=await plugin('текущий'),firstPin=pinFor(first),firstMeta=meta('current',[firstPin]);
    await storage.createSkill('common/current',firstMeta,'Инструкция');
    assert.equal(await reservationCount(),1);assert.ok(await exists('common/current'));
    assert.equal(await repository.delete(first.id,'qa'),true);
    assert.equal((await repository.version(first.id,1)).version,firstPin.version);
    const nextMeta={...firstMeta,version:2,dependencies:[]};
    await storage.writeSkill('common/current',nextMeta,'Новая инструкция');await storage.deleteSkill('common/current');
    assert.equal(await repository.delete(first.id,'qa'),true);
    assert.equal((await pool.query("SELECT count(*)::int n FROM security_events WHERE resource_id=$1 AND action='plugin.archive'",[first.id])).rows[0].n,1);
    assert.equal(await exists('common/current'),false);
    scenarios.push('Скилл резервирует точный pin; архив инструмента, очистка head и удаление файла сохраняют immutable версию и единственный archive audit');

    const old=await plugin('старая история'),oldPin=pinFor(old);
    await legacy.createSkill('common/legacy',meta('legacy',[oldPin]),'Старая версия');
    assert.equal(await reservationCount(),1);
    assert.equal(await repository.delete(old.id,'qa'),true);assert.equal((await repository.version(old.id,1)).version,oldPin.version);
    await legacy.deleteSkill('common/legacy');
    assert.equal(await repository.delete(old.id,'qa'),true);assert.equal((await repository.version(old.id,1)).version,oldPin.version);
    scenarios.push('Незарегистрированный исторический файл и снимок удалённого поколения остаются читаемы после архивирования зависимости');

    const free=await plugin('проверка отказов');scanMode='unavailable';
    assert.equal(await repository.delete(free.id,'qa'),true);scanMode='normal';
    assert.ok((await repository.get(free.id)).archivedAt);assert.ok(await repository.version(free.id,1));
    assert.equal(await repository.delete('ai-plug-no-such-fixture','qa'),false);
    scenarios.push('Архив не требует недоступного файлового сервиса: история сохранена; неизвестный ID не создаёт карточку');

    const badMeta=meta('bad',[{...firstPin,manifest:'f'.repeat(64)}]);
    await assert.rejects(storage.createSkill('common/bad',badMeta,'Не публиковать'),error=>error.status===409);
    assert.equal(await exists('common/bad'),false);
    reserveMode='unavailable';await assert.rejects(storage.createSkill('common/offline',meta('offline',[firstPin]),'Не публиковать'),error=>error.status===503);
    reserveMode='normal';assert.equal(await exists('common/offline'),false);
    scenarios.push('Неверный SHA и отказ регистрации останавливают создание до публикации файла');

    const batchTarget=await plugin('пакет'),batchPin=pinFor(batchTarget),beforeBatch=await reservationCount();
    await assert.rejects(storage.applySkillChanges([
        {path:'common/batch-a',next:{path:'common/batch-a',meta:meta('batch-a',[batchPin]),body:'А'}},
        {path:'common/batch-b',next:{path:'common/batch-b',meta:meta('batch-b',[{...batchPin,version:999}]),body:'Б'}},
    ]),error=>error.status===409);
    assert.equal(await exists('common/batch-a'),false);assert.equal(await exists('common/batch-b'),false);
    assert.equal(await reservationCount(),beforeBatch);
    assert.deepEqual(await readdir(path.join(directory,'.neurocenter-sync-journal')).catch(error=>{if(error.code==='ENOENT')return[];throw error;}),[]);
    scenarios.push('Ошибка второго элемента резервирования откатывает SQL-пакет до первого файла и до создания журнала');

    const lost=await plugin('потеря подтверждения'),lostPin=pinFor(lost),lostMeta=meta('lost',[lostPin]);reserveMode='lost-ack';
    await assert.rejects(storage.createSkill('common/lost',lostMeta,'Инструкция'),error=>error.status===503);
    assert.equal(await exists('common/lost'),false);assert.equal(await repository.delete(lost.id,'qa'),true);assert.ok(await repository.version(lost.id,1));
    const beforeRetry=await reservationCount();await storage.createSkill('common/lost',lostMeta,'Инструкция');
    assert.equal(await reservationCount(),beforeRetry);
    scenarios.push('Потеря HTTP ACK после SQL COMMIT не публикует файл; резерв и архив сохраняют точную историю, повтор идемпотентен');

    const racing=await plugin('резерв первым'),racingPin=pinFor(racing),reserveGate=gatePool(),deleteObserver=gatePool();
    reservationPool=reserveGate.pool;
    const creating=observed(storage.createSkill('common/reserve-first',meta('reserve-first',[racingPin]),'Инструкция'));
    let deletion;
    try{
        const reservePid=await within(reserveGate.acquired);
        deletion=observed(new PluginRepository(deleteObserver.pool).delete(racing.id,'qa'));
        await assertBlocked(await within(deleteObserver.attempt),reservePid);
    }finally{reserveGate.release();deleteObserver.release();}
    await successful(creating);assert.equal(await successful(deletion),true);reservationPool=pool;
    assert.ok(await repository.version(racing.id,1));assert.equal(await exists('common/reserve-first'),true);
    scenarios.push('Резерв первым удерживает настоящий graph lock: архив ждёт и сохраняет точный pin опубликованного файла');

    const deleted=await plugin('удаление первым'),deletedPin=pinFor(deleted),deleteGate=gatePool(),reserveObserver=gatePool();
    const deleting=observed(new PluginRepository(deleteGate.pool).delete(deleted.id,'qa'));
    let creation;
    try{
        const deletePid=await within(deleteGate.acquired);reservationPool=reserveObserver.pool;
        creation=observed(storage.createSkill('common/delete-first',meta('delete-first',[deletedPin]),'Не публиковать'));
        await assertBlocked(await within(reserveObserver.attempt),deletePid);
    }finally{deleteGate.release();reserveObserver.release();}
    assert.equal(await successful(deleting),true);await successful(creation);reservationPool=pool;
    assert.equal(await exists('common/delete-first'),true);assert.ok(await repository.version(deleted.id,1));
    scenarios.push('Архив первым удерживает настоящий graph lock: регистрация ждёт и использует сохранённую точную историческую версию');

    const journalTarget=await plugin('журнал'),journalPin=pinFor(journalTarget),raw=serializeSkillFile(meta('journal',[journalPin]),'Сохранённый текст');
    const journalDir=path.join(directory,'.neurocenter-sync-journal');await mkdir(journalDir,{recursive:true});
    const journalFile=path.join(journalDir,createHash('sha256').update('common').digest('hex')+'.json');
    await writeFile(journalFile,JSON.stringify({version:1,id:randomUUID(),state:'prepared',host:'own-test-host',pid:1,
        changes:[{relative:'common/journal.md',before:raw,after:null}]}));
    assert.equal(await scanSkillDependencyUsage(directory,journalTarget.id),true);
    assert.equal(await repository.delete(journalTarget.id,'qa'),true);assert.ok(await repository.version(journalTarget.id,1));await rm(journalFile);
    scenarios.push('Исторический prepared journal показывает before/after pins; архив сохраняет версию даже без текущего файла и PG-резерва');

    const service=new SkillsService(storage),missingPin={...firstPin,id:'ai-plug-legacy-missing'};
    const repairPath='common/repair-clear',repairMeta=meta('repair-clear',[missingPin]);
    await legacy.createSkill(repairPath,repairMeta,'Старая инструкция');
    const repairRaw=await readFile(path.join(directory,repairPath+'.md'),'utf8');
    reserveMode='unavailable';
    const unchanged=await service.updateSkill(repairPath,{expectedVersion:1,body:'Старая инструкция'},'qa-repair');
    assert.equal(unchanged.meta.version,1);assert.equal(await readFile(path.join(directory,repairPath+'.md'),'utf8'),repairRaw);
    reserveMode='normal';
    scenarios.push('Точный повтор broken head не пишет историю и не зависит от доступности каталога');

    await assert.rejects(service.updateSkill(repairPath,{expectedVersion:1,body:'Новый текст с прежней ошибкой'},'qa-repair'),error=>error.status===409);
    const repaired=await service.updateSkill(repairPath,{expectedVersion:1,body:'Исправленная инструкция',meta:{dependencies:[]}},'qa-repair');
    assert.equal(repaired.meta.version,2);assert.equal(repaired.meta.dependencies,undefined);
    assert.equal(await readFile(path.join(directory,versionRelative(repairPath,repairMeta,1)),'utf8'),repairRaw);
    const repairKey=createHash('sha256').update(repairRaw).digest('hex'),repairResource=repairPath+' · '+repairKey;
    const audit=await pool.query("SELECT actor,before_state,after_state FROM security_events WHERE action='skill.dependencies.preserve' AND resource_id=$1",[repairResource]);
    assert.equal(audit.rowCount,1);assert.equal(audit.rows[0].actor,'skills-service');assert.equal(audit.rows[0].before_state,null);
    assert.deepEqual(audit.rows[0].after_state,{path:repairPath,key:repairKey,dependencies:[missingPin],verification:'unavailable'});
    scenarios.push('Очистка недоступного pin сохраняет старый raw побайтно и фиксирует служебную квитанцию в SQL-транзакции');

    await reserveHttp([dependencyReservation(repairPath,repairRaw,'preserve')]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE action='skill.dependencies.preserve' AND resource_id=$1",[repairResource])).rows[0].n,1);
    await assert.rejects(reserveHttp([dependencyReservation(repairPath,repairRaw)]),error=>error.status===409);
    scenarios.push('Повтор preserve не дублирует квитанцию; тот же исторический key не разрешает новую публикацию');

    const replacePath='common/repair-replace';await legacy.createSkill(replacePath,meta('repair-replace',[{...firstPin,manifest:'e'.repeat(64)}]),'До замены');
    const replaced=await service.updateSkill(replacePath,{expectedVersion:1,meta:{dependencies:[firstPin]}},'qa-repair');
    assert.deepEqual(replaced.meta.dependencies,[firstPin]);assert.equal(replaced.meta.version,2);
    const deletedBroken='common/repair-delete';await legacy.createSkill(deletedBroken,meta('repair-delete',[missingPin]),'Сохранить историю');
    await assert.rejects(service.deleteSkill(deletedBroken),error=>error.status===409);
    await service.updateSkill(deletedBroken,{expectedVersion:1,meta:{dependencies:[]}},'qa-repair');
    const archiveExpected=await service.inspectAssetSkill(deletedBroken);
    const archivedBroken=await service.archiveAssetSkill(deletedBroken,archiveExpected,'qa-repair');
    assert.ok(archivedBroken.meta.archivedAt);assert.equal(await exists(deletedBroken),true);
    assert.deepEqual((await service.getSkill(deletedBroken,1)).meta.dependencies,[missingPin]);
    assert.deepEqual((await pool.query('SELECT dependencies FROM skill_dependency_reservations WHERE skill_path=$1',[deletedBroken])).rows[0].dependencies,[missingPin]);
    scenarios.push('Неверный исторический SHA заменяется валидным pin; legacy common DELETE запрещён, исправление и архив сохраняют исходную версию и резерв');

    const rollbackPath='common/repair-audit-failure',rollbackMeta=meta('repair-audit-failure',[missingPin]);
    await legacy.createSkill(rollbackPath,rollbackMeta,'До отказа аудита');const rollbackRaw=await readFile(path.join(directory,rollbackPath+'.md'),'utf8');
    await pool.query("ALTER TABLE security_events ADD CONSTRAINT qa_preserve_audit_failure CHECK(action<>'skill.dependencies.preserve') NOT VALID");
    try{await assert.rejects(service.updateSkill(rollbackPath,{expectedVersion:1,meta:{dependencies:[]}},'qa-repair'),error=>error.status===503);}
    finally{await pool.query('ALTER TABLE security_events DROP CONSTRAINT qa_preserve_audit_failure');}
    assert.equal(await readFile(path.join(directory,rollbackPath+'.md'),'utf8'),rollbackRaw);
    await assert.rejects(readFile(path.join(directory,versionRelative(rollbackPath,rollbackMeta,1))),error=>error.code==='ENOENT');
    assert.equal((await pool.query('SELECT 1 FROM skill_dependency_reservations WHERE skill_path=$1',[rollbackPath])).rowCount,0);
    scenarios.push('Настоящий SQL CHECK отказа аудита откатывает preserve и останавливает запись head и snapshot');

    const mixedPath='common/repair-mixed',mixedRaw=serializeSkillFile(meta('repair-mixed',[missingPin]),'Старый снимок');
    await assert.rejects(reserveSql(pool,{entries:[dependencyReservation(mixedPath,mixedRaw,'preserve'),dependencyReservation(mixedPath,mixedRaw)]}),error=>error.status===409);
    assert.equal((await pool.query('SELECT 1 FROM skill_dependency_reservations WHERE skill_path=$1',[mixedPath])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM security_events WHERE action='skill.dependencies.preserve' AND resource_id LIKE $1",[mixedPath+' · %'])).rowCount,0);
    scenarios.push('Пакет preserve плюс новый broken candidate откатывает и резерв, и квитанцию целиком');

    const recoveryPath='common/repair-recovery',beforeRecovery=serializeSkillFile(meta('repair-recovery',[missingPin]),'Исходное состояние');
    const afterRecovery=serializeSkillFile(meta('repair-recovery',[{...missingPin,version:2}],2),'Прерванная запись');
    await writeFile(path.join(directory,recoveryPath+'.md'),afterRecovery);
    const recoveryJournal=path.join(journalDir,createHash('sha256').update('common').digest('hex')+'.json');
    const recoveryJournalRaw=JSON.stringify({version:1,id:randomUUID(),state:'prepared',host:hostname(),pid:process.pid,
        changes:[{relative:recoveryPath+'.md',before:beforeRecovery,after:afterRecovery}]});
    await writeFile(recoveryJournal,recoveryJournalRaw);reserveMode='unavailable';
    await assert.rejects(storage.init(),error=>error.status===503);reserveMode='normal';
    assert.equal(await readFile(path.join(directory,recoveryPath+'.md'),'utf8'),afterRecovery);
    assert.equal(await readFile(recoveryJournal,'utf8'),recoveryJournalRaw);
    await storage.init();assert.equal(await readFile(path.join(directory,recoveryPath+'.md'),'utf8'),beforeRecovery);
    await assert.rejects(readFile(recoveryJournal),error=>error.code==='ENOENT');
    scenarios.push('Rollback старого prepared-журнала допускает прежние unavailable pins; отказ оставляет журнал и файлы для повтора');

    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE action='plugin.delete' AND resource_id=ANY($1::text[])",[[first.id,old.id,lost.id,racing.id]])).rows[0].n,0);
    scenarios.push('Не создаются события физического удаления: архивирование сохраняет версии и исторические резервы');
    console.log(JSON.stringify({ok:true,scenarios:scenarios.length}));
}catch(error){fatal=error.stack||String(error);console.error(fatal);process.exitCode=1;}
finally{
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await pool?.end();
    if(created){await admin.query(`DROP DATABASE "${database}"`);ownDatabaseDropped=true;}
    const afterDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const originalDatabasesPreserved=JSON.stringify(beforeDatabases)===JSON.stringify(afterDatabases);await admin.end();
    await rm(directory,{recursive:true,force:true});await mkdir(path.dirname(reportPath),{recursive:true});
    await writeFile(reportPath,JSON.stringify({ok:!fatal&&ownDatabaseDropped&&originalDatabasesPreserved,scenarios,fatal:fatal||null,
        ownDatabaseDropped,ownDirectoryRemoved:true,originalDatabasesPreserved,realCatalogRowsCreated:false,
        protocol:'Actual repository/storage/scanner/HTTP clients; isolated HTTP route adapters, not Nest startup'},null,2)+'\n');
    if(!originalDatabasesPreserved)process.exitCode=1;
}
