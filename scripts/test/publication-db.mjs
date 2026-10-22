import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.PUBLICATION_TEST_PG_URL).href;

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const dist=process.env.PUBLICATION_TEST_DIST || fileURLToPath(new URL('../../services/catalog-service/dist/',import.meta.url));
const {PluginRepository}=require(path.join(dist,'publication/plugin-repository.js'));
const {ProjectAssetRepository}=require(path.join(dist,'catalog/project-asset-repository.js'));
const {buildPackage}=require(path.join(dist,'catalog/bundle-package.js'));
const {ensureCatalogSchema}=require(path.join(dist,'database/catalog-schema.js'));
const {listAuditHistory}=require(path.join(dist,'catalog/audit-history.js'));
const root=new URL('../../',import.meta.url);
// Сценарии публикации создают собственную БД, не добавляя даже временных строк в рабочий каталог.
const adminUrl=adminConnection;
const admin=new Pool({connectionString:adminUrl,max:2});
const database='nc_publication_test_'+randomBytes(8).toString('hex');
const reportPath=process.env.PUBLICATION_TEST_REPORT || fileURLToPath(new URL('.run/publication-db-smoke.json',root));
const beforeDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
let pool,repository,created=false,ownDatabaseDropped=false,fatal;
const prefix=`Проверка публикации ${randomUUID()}`;
const ids=[];const report=[];
const input=(suffix)=>({name:`${prefix} ${suffix}`,kind:'mcp',description:'Исходное описание',config:{transport:'remote',url:'https://example.org/mcp'},publicationKey:randomUUID()});
const within=async(promise,label)=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Истекло ожидание: '+label)),5000);})]);}
    finally{clearTimeout(timer);}
};
// Наблюдаем настоящий lock PostgreSQL; пауза не подменяет SQL или результат мутации.
const controlledRepository=(pause)=>{
    let notifyAttempt,notifyAcquired,releaseGate;
    const attempt=new Promise(resolve=>{notifyAttempt=resolve;});
    const acquired=new Promise(resolve=>{notifyAcquired=resolve;});
    const gate=new Promise(resolve=>{releaseGate=resolve;});
    const controlledPool={async connect(){
        const client=await pool.connect();
        const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return{async query(sql,params){
            const graphLock=String(sql).startsWith('SELECT pg_advisory_xact_lock')&&params?.[0]==='publication:dependency-graph';
            if(graphLock){notifyAttempt(pid);}
            const result=await client.query(sql,params);
            if(graphLock){notifyAcquired(pid);if(pause){await gate;}}
            return result;
        },release(){client.release();}};
    }};
    return{repository:new PluginRepository(controlledPool),attempt,acquired,release:()=>releaseGate()};
};
const assertGraphBlocked=async(pid)=>{
    const deadline=Date.now()+5000;
    do{
        const blockers=(await pool.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0].blockers;
        if(blockers.length){return;}
        await new Promise(resolve=>setTimeout(resolve,20));
    }while(Date.now()<deadline);
    assert.fail('Конкурирующая публикация/удаление не дождалась блокировки графа');
};
const dependencyPin=async(plugin,version=plugin.version)=>{
    const saved=await repository.version(plugin.id,version);
    const dependencies=saved.metadata?.dependencies||[];
    const config=dependencies.length?{...saved.config,extra:{...saved.config?.extra,requirements:{mcp:[],plugins:[],dependencies}}}:saved.config;
    const kind=saved.metadata?.kind||plugin.kind;
    const pkg=buildPackage({id:plugin.id,name:plugin.name,kind,version},saved.files.map(file=>({path:file.path,content:file.content??''})),'',config);
    return{kind,id:plugin.id,version,manifest:pkg.manifest.sha256};
};
try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;
    pool=new Pool({connectionString:url.href,max:5});
    await ensureCatalogSchema(pool);
    repository=new PluginRepository(pool);
    const body=input('русское название');
    const repeated=await Promise.all([repository.create(body,'qa-publication'),repository.create(body,'qa-publication')]);
    ids.push(repeated[0].id);
    assert.equal(repeated[0].id,repeated[1].id);
    assert.equal((await repository.versions(ids[0])).length,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.create'",[ids[0]])).rows[0].n,1);
    report.push('Повтор и одновременная отправка возвращают одну карточку и одну первую версию');
    await assert.rejects(repository.create({...body,publicationKey:randomUUID()},'qa-publication'),error=>error.status===409);
    await assert.rejects(repository.create({...body,description:'Другое содержимое'},'qa-publication'),error=>error.status===409);
    report.push('Новое создание того же названия и повтор ключа с другим содержимым дают 409');
    const other=await repository.create(input('другое русское название'),'qa-publication');ids.push(other.id);
    assert.notEqual(ids[0],other.id);
    report.push('Разные русские названия получают разные ID');
    const edits=await Promise.allSettled(['Версия А','Версия Б'].map(description=>repository.update(ids[0],{description,expectedVersion:1},'qa-editor')));
    assert.equal(edits.filter(item=>item.status==='fulfilled').length,1);
    assert.equal(edits.find(item=>item.status==='rejected').reason.status,409);
    const current=await repository.get(ids[0]);assert.equal(current.version,2);
    const versions=await repository.versions(ids[0]);assert.equal(versions.length,2);assert.equal(versions[0].author,'qa-editor');
    report.push('Одновременное редактирование сохраняет одну версию, второй редактор получает 409');
    await repository.update(ids[0],{description:current.description,expectedVersion:2},'qa-editor');
    assert.equal((await repository.versions(ids[0])).length,2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.update'",[ids[0]])).rows[0].n,1);
    const restored=await repository.activate(ids[0],1,'qa-editor');
    assert.equal(restored.version,3);assert.equal(restored.description,body.description);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.activate'",[ids[0]])).rows[0].n,1);
    report.push('Повтор без изменений не увеличивает версию; восстановление создаёт новый номер и возвращает метаданные');
    const pin=await dependencyPin(other);
    const pinned=await repository.create({...input('точные зависимости'),dependencies:[pin]},'qa-publication');ids.push(pinned.id);
    assert.deepEqual(pinned.dependencies,[pin]);
    assert.deepEqual((await repository.version(pinned.id,1)).metadata.dependencies,[pin]);
    await repository.update(pinned.id,{description:'Новый текст',expectedVersion:1},'qa-editor');
    assert.deepEqual((await repository.get(pinned.id)).dependencies,[pin]);
    report.push('JSONB сохраняет точные зависимости в карточке и неизменяемой версии; правка текста сохраняет pins');
    const otherV2=await repository.update(other.id,{description:'Реальная вторая версия зависимости',expectedVersion:1},'qa-editor');
    const changedPin=await dependencyPin(otherV2);
    await repository.update(pinned.id,{dependencies:[changedPin],expectedVersion:2},'qa-editor');
    assert.deepEqual((await repository.version(pinned.id,1)).metadata.dependencies,[pin]);
    assert.deepEqual((await repository.get(pinned.id)).dependencies,[changedPin]);
    assert.equal((await repository.update(pinned.id,{dependencies:[changedPin],expectedVersion:3},'qa-editor')).version,3);
    const cleared=await repository.update(pinned.id,{dependencies:[],expectedVersion:3},'qa-editor');
    assert.equal(cleared.version,4);assert.equal(cleared.dependencies,undefined);
    assert.equal((await repository.update(pinned.id,{dependencies:[],expectedVersion:4},'qa-editor')).version,4);
    const restoredPins=await repository.activate(pinned.id,1,'qa-editor');
    assert.equal(restoredPins.version,5);assert.deepEqual(restoredPins.dependencies,[pin]);
    report.push('Изменение и удаление pins версионируется; повторы не создают версию, восстановление возвращает точные pins');
    const oldBeforePins=await repository.activate(ids[0],1,'qa-editor');
    await repository.update(ids[0],{dependencies:[pin],expectedVersion:oldBeforePins.version},'qa-editor');
    const restoredWithoutPins=await repository.activate(ids[0],1,'qa-editor');
    assert.equal(restoredWithoutPins.dependencies,undefined);
    report.push('Восстановление старой версии без pins не наследует зависимости текущего head');
    assert.equal(await repository.delete(other.id,'qa-delete'),true);assert.ok((await repository.get(other.id)).archivedAt);
    assert.equal((await repository.versions(other.id)).length,2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.delete'",[other.id])).rows[0].n,0);
    report.push('Архив зависимости сохраняет обе точные версии и pin чужого head без события физического удаления');
    await repository.update(pinned.id,{dependencies:[],expectedVersion:restoredPins.version},'qa-editor');
    assert.equal(await repository.delete(other.id,'qa-delete'),true);assert.ok((await repository.get(other.id)).archivedAt);
    report.push('После очистки head исторический pin сохраняется; повтор архива не дублирует событие');
    for(const badPin of [{...pin,version:999},{...pin,kind:'plugin'},{...pin,manifest:'f'.repeat(64)},{...pin,id:'ai-plug-missing'}]){
        const invalid=input('невалидная зависимость '+randomUUID());
        await assert.rejects(repository.create({...invalid,dependencies:[badPin]},'qa-publication'),error=>error.status===409);
        assert.equal((await pool.query('SELECT id FROM ai_plugins WHERE name=$1',[invalid.name])).rowCount,0);
    }
    report.push('Несуществующая карточка/версия, другой тип и неверный SHA отвергаются внутри транзакции без публикации');
    const legacy=await repository.create(input('исторический неподтверждённый pin'),'qa-publication');
    const malformed=[{...pin,manifest:'f'.repeat(64)}];
    await pool.query("UPDATE ai_plugin_versions SET metadata=jsonb_set(metadata,'{dependencies}',$2::jsonb) WHERE ai_plugin_id=$1 AND version=1",[legacy.id,JSON.stringify(malformed)]);
    await assert.rejects(repository.activate(legacy.id,1,'qa-editor'),error=>error.status===409);
    assert.equal((await repository.versions(legacy.id)).length,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.activate'",[legacy.id])).rows[0].n,0);
    report.push('Активация старого неподтверждённого pin прекращается до записи новой версии и аудита');
    const publishFirstDependency=await repository.create(input('зависимость публикация первая'),'qa-publication');
    const publishFirstPin=await dependencyPin(publishFirstDependency);
    const publisherGate=controlledRepository(true),deleteObserver=controlledRepository(false);
    const concurrentPublication=publisherGate.repository.create({...input('конкурентная публикация первая'),dependencies:[publishFirstPin]},'qa-publication');
    let concurrentDelete;
    try{
        await within(publisherGate.acquired,'публикация заняла граф');
        concurrentDelete=deleteObserver.repository.delete(publishFirstDependency.id,'qa-delete');
        const deletePid=await within(deleteObserver.attempt,'удаление запросило граф');
        await assertGraphBlocked(deletePid);
    }finally{publisherGate.release();}
    const publishedBeforeDelete=await concurrentPublication;
    assert.equal(await concurrentDelete,true);assert.ok((await repository.get(publishFirstDependency.id)).archivedAt);
    assert.deepEqual(publishedBeforeDelete.dependencies,[publishFirstPin]);
    assert.ok(await repository.get(publishFirstDependency.id));
    report.push('Публикация первой держит настоящий advisory lock: конкурентный архив ждёт и сохраняет опубликованный exact pin');
    const deleteFirstDependency=await repository.create(input('зависимость удаление первое'),'qa-publication');
    const deleteFirstPin=await dependencyPin(deleteFirstDependency);
    const deleteGate=controlledRepository(true),publicationObserver=controlledRepository(false);
    const deletedFirst=deleteGate.repository.delete(deleteFirstDependency.id,'qa-delete');
    const rejectedPublication=input('конкурентная публикация после удаления');
    let publicationAfterDelete;
    try{
        await within(deleteGate.acquired,'удаление заняло граф');
        publicationAfterDelete=publicationObserver.repository.create({...rejectedPublication,dependencies:[deleteFirstPin]},'qa-publication');
        const publicationPid=await within(publicationObserver.attempt,'публикация запросила граф');
        await assertGraphBlocked(publicationPid);
    }finally{deleteGate.release();}
    assert.equal(await deletedFirst,true);
    const publishedAfterArchive=await publicationAfterDelete;
    assert.deepEqual(publishedAfterArchive.dependencies,[deleteFirstPin]);assert.ok(await repository.version(deleteFirstDependency.id,1));
    report.push('Архив первым держит настоящий advisory lock: публикация ждёт и читает сохранённую историческую версию');
    const failure=input('откат при ошибке');
    const brokenPool={async connect(){const client=await pool.connect();return{query(sql,params){if(String(sql).startsWith('INSERT INTO ai_plugin_versions')){throw new Error('qa-version-write-failed');}return client.query(sql,params);},release(){client.release();}};}};
    await assert.rejects(new PluginRepository(brokenPool).create(failure,'qa-publication'),/qa-version-write-failed/);
    assert.equal((await pool.query('SELECT id FROM ai_plugins WHERE name=$1',[failure.name])).rowCount,0);
    report.push('Ошибка записи первой версии откатывает карточку целиком');
    const auditFailure=input('откат при ошибке аудита');
    const brokenAuditPool={async connect(){const client=await pool.connect();return{query(sql,params){if(String(sql).startsWith('INSERT INTO security_events')){throw new Error('qa-audit-write-failed');}return client.query(sql,params);},release(){client.release();}};}};
    await assert.rejects(new PluginRepository(brokenAuditPool).create(auditFailure,'qa-publication'),/qa-audit-write-failed/);
    assert.equal((await pool.query('SELECT id FROM ai_plugins WHERE name=$1',[auditFailure.name])).rowCount,0);
    const summary=(await pool.query('SELECT after_state FROM security_events WHERE resource_id=$1 ORDER BY created_at LIMIT 1',[ids[0]])).rows[0].after_state;
    assert.equal('config' in summary||'files' in summary,false);assert.match(summary.contentHash,/^[a-f0-9]{64}$/);
    report.push('Публикация, изменение и восстановление имеют один аудит на мутацию; сбой аудита откатывает карточку, содержимое настроек в журнал не попадает');
    const deletable=await repository.create(input('удаление с аудитом'),'qa-publication');
    const deletableVersions=await repository.versions(deletable.id);
    await pool.query("ALTER TABLE security_events ADD CONSTRAINT qa_delete_audit_failure CHECK (action<>'plugin.archive') NOT VALID");
    await assert.rejects(repository.delete(deletable.id,'qa-delete'),error=>error.code==='23514');
    await pool.query('ALTER TABLE security_events DROP CONSTRAINT qa_delete_audit_failure');
    assert.equal((await repository.get(deletable.id)).archivedAt,undefined);
    assert.deepEqual(await repository.versions(deletable.id),deletableVersions);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.delete'",[deletable.id])).rows[0].n,0);
    report.push('Ошибка INSERT аудита откатывает архивирование карточки, все версии остаются неизменны');
    await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',['prj-own-qa','Publication deletion fixture']);
    await new ProjectAssetRepository(pool).add('prj-own-qa',deletable.id,'mcp','qa');
    await assert.rejects(repository.delete(deletable.id,'qa-delete'),error=>error.status===409);
    assert.ok(await repository.get(deletable.id));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.delete'",[deletable.id])).rows[0].n,0);
    await pool.query('DELETE FROM project_assets WHERE asset_id=$1',[deletable.id]);
    report.push('Используемый MCP получает 409 без потери карточки и без ложного события удаления');
    const removals=await Promise.all([repository.delete(deletable.id,'qa-delete'),repository.delete(deletable.id,'qa-delete')]);
    assert.equal(removals.every(Boolean),true);
    assert.ok((await repository.get(deletable.id)).archivedAt);
    assert.deepEqual(await repository.versions(deletable.id),deletableVersions);
    await assert.rejects(new ProjectAssetRepository(pool).add('prj-own-qa',deletable.id,'mcp','qa'),error=>error.status===409);
    assert.equal((await repository.list(1,100,'')).items.some(item=>item.id===deletable.id),false);
    const deletion=(await pool.query("SELECT actor,before_state,after_state FROM security_events WHERE resource_id=$1 AND action='plugin.archive'",[deletable.id])).rows;
    assert.equal(deletion.length,1);assert.equal(deletion[0].actor,'qa-delete');
    assert.equal(deletion[0].before_state.name,deletable.name);assert.equal(deletion[0].after_state.archived,true);
    assert.equal('config' in deletion[0].before_state || 'files' in deletion[0].before_state,false);
    assert.match(deletion[0].before_state.contentHash,/^[a-f0-9]{64}$/);
    assert.equal(await repository.delete(deletable.id,'qa-delete'),true);
    assert.equal(await repository.delete('ai-plug-missing','qa-delete'),false);
    assert.equal((await pool.query("SELECT count(*)::int n FROM security_events WHERE resource_id=$1 AND action='plugin.archive'",[deletable.id])).rows[0].n,1);
    report.push('Два конкурентных архива и повтор оставляют одно событие; новые назначения запрещены, история и версии сохранены');
    const history=await listAuditHistory(pool,1,100);
    const visible=history.items.find(event=>event.resourceId===deletable.id&&event.action==='plugin.archive');
    assert.ok(visible);assert.equal(visible.actor,'qa-delete');assert.equal(visible.source,'security');
    assert.equal(visible.outcome,'SUCCEEDED');assert.equal(visible.details,null);
    report.push('Общая страница аудита читает событие архивирования без раскрытия исходных конфигураций');
    console.log(JSON.stringify({ok:true,scenarios:report.length},null,2));
}catch(error){fatal=error.stack||String(error);console.error(fatal);process.exitCode=1;}
finally{
    await pool?.end();
    if(created){await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);ownDatabaseDropped=true;}
    const afterDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const originalDatabasesPreserved=JSON.stringify(beforeDatabases)===JSON.stringify(afterDatabases);
    await admin.end();
    await mkdir(path.dirname(reportPath),{recursive:true});
    await writeFile(reportPath,JSON.stringify({ok:!fatal&&ownDatabaseDropped&&originalDatabasesPreserved,scenarios:report,fatal:fatal||null,
        ownDatabaseDropped,originalDatabasesPreserved,realCatalogRowsCreated:false},null,2)+'\n');
    if(!originalDatabasesPreserved){process.exitCode=1;}
}
