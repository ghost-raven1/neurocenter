import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const skillDirectory=await mkdtemp(path.join(tmpdir(),'nc-project-skill-refs-'));
const dist=process.env.PUBLICATION_TEST_DIST || fileURLToPath(new URL('../../services/catalog-service/dist/',import.meta.url));
const {ProjectAssetRepository}=require(path.join(dist,'catalog/project-asset-repository.js'));
const {PluginRepository}=require(path.join(dist,'publication/plugin-repository.js'));
const {ensureCatalogSchema}=require(path.join(dist,'database/catalog-schema.js'));
const {listAuditHistory}=require(path.join(dist,'catalog/audit-history.js'));
const skillsDist=process.env.SKILLS_TEST_DIST||fileURLToPath(new URL('../../services/skills-service/dist/',import.meta.url));
const {FsSkillsStorage}=require(path.join(skillsDist,'storage/fs-skills-storage.js'));
const {SkillsService}=require(path.join(skillsDist,'skills/skills.service.js'));
const {SkillAssetImportController}=require(path.join(skillsDist,'skills/asset-import.controller.js'));
const originalSkillsUrl=process.env.SKILLS_SERVICE_URL,originalInternalToken=process.env.NEUROCENTER_INTERNAL_TOKEN;
const token=randomBytes(24).toString('hex');
const adminUrl=process.env.PUBLICATION_TEST_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const reportPath=process.env.PROJECT_ASSETS_TEST_REPORT || fileURLToPath(new URL('../../.run/project-assets-db-smoke.json',import.meta.url));
const database='nc_project_assets_test_'+randomBytes(8).toString('hex');
const admin=new Pool({connectionString:adminUrl,max:2});
const beforeDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const scenarios=[];
let pool,assets,plugins,skillServer,skillStorage,created=false,ownDatabaseDropped=false,fatal;
const projectA='prj-own-qa-a',projectB='prj-own-qa-b';
const resource=(projectId,assetId,kind='mcp')=>`${projectId} · ${kind} · ${assetId}`;
const input=suffix=>({name:`Проверка состава ${suffix} ${randomUUID()}`,kind:'mcp',description:'Только изолированная проверка',
    config:{transport:'remote',url:'https://example.test/mcp'},publicationKey:randomUUID()});
const within=async(promise,label)=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Истекло ожидание: '+label)),8000);})]);}
    finally{clearTimeout(timer);}
};
// Обрабатываем отклонение сразу: конкурентная операция может завершиться раньше следующего await.
const observed=promise=>promise.then(value=>({value}),error=>({error}));
const successful=async promise=>{const result=await promise;if(result.error){throw result.error;}return result.value;};
const rejected=async(promise,status)=>{const result=await promise;assert.ok(result.error);assert.equal(result.error.status,status);};
const count=async(sql,params)=>(await pool.query(sql,params)).rows[0].n;
const events=async(projectId,assetId,action,kind='mcp')=>(await pool.query(
    'SELECT actor,before_state,after_state FROM security_events WHERE resource_id=$1 AND action=$2 ORDER BY created_at,event_id',
    [resource(projectId,assetId,kind),`project.asset.${action}`])).rows;

// Обёртка только задерживает возврат настоящего SELECT после получения блокировки.
const controlledPool=match=>{
    let notifyAttempt,notifyAcquired,releaseGate;
    const attempt=new Promise(resolve=>{notifyAttempt=resolve;});
    const acquired=new Promise(resolve=>{notifyAcquired=resolve;});
    const gate=new Promise(resolve=>{releaseGate=resolve;});
    return{attempt,acquired,release:()=>releaseGate(),pool:{async connect(){
        const client=await pool.connect();
        const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return{async query(sql,params){
            const selected=match(String(sql));
            if(selected){notifyAttempt(pid);}
            const result=await client.query(sql,params);
            if(selected){notifyAcquired(pid);await gate;}
            return result;
        },release(){client.release();}};
    }}};
};
const assertBlockedBy=async(pid,blockingPid)=>{
    const deadline=Date.now()+5000;
    do{
        const blockers=(await pool.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0].blockers;
        if(blockers.includes(blockingPid)){return;}
        await new Promise(resolve=>setTimeout(resolve,20));
    }while(Date.now()<deadline);
    assert.fail('Конкурирующая операция не дождалась настоящей блокировки строки');
};

try{
    // Собственная БД исключает записи даже временных QA-строк в рабочем каталоге.
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;
    pool=new Pool({connectionString:url.href,max:6,options:'-c statement_timeout=10000 -c lock_timeout=7000'});
    await ensureCatalogSchema(pool);
    await pool.query('INSERT INTO projects(id,name) VALUES($1,$2),($3,$4)',[projectA,'Project assets A',projectB,'Project assets B']);
    plugins=new PluginRepository(pool);
    assets=new ProjectAssetRepository(pool);

    const shared=await plugins.create(input('повторы'),'qa-publisher');
    await Promise.all(Array.from({length:4},()=>assets.add(projectA,shared.id,'mcp','qa-original')));
    assert.equal(await count('SELECT count(*)::int AS n FROM project_assets WHERE project_id=$1 AND asset_id=$2',[projectA,shared.id]),1);
    const addition=await events(projectA,shared.id,'add');
    assert.equal(addition.length,1);assert.equal(addition[0].actor,'qa-original');
    assert.equal(addition[0].before_state,null);assert.equal(addition[0].after_state.addedBy,'qa-original');
    assert.equal(addition[0].after_state.projectId,projectA);assert.equal(addition[0].after_state.assetId,shared.id);
    assert.equal(addition[0].after_state.assetKind,'mcp');assert.ok(Number.isFinite(Date.parse(addition[0].after_state.addedAt)));
    scenarios.push('Четыре одновременных назначения создают одну связь и одно событие с исполнителем и временем');

    await assets.add(projectB,shared.id,'mcp','qa-other-project');
    assert.equal(await count('SELECT count(*)::int AS n FROM project_assets WHERE asset_id=$1',[shared.id]),2);
    const separate=await events(projectB,shared.id,'add');assert.equal(separate.length,1);
    assert.equal(separate[0].after_state.projectId,projectB);assert.equal(separate[0].actor,'qa-other-project');
    assert.equal((await events(projectA,shared.id,'add')).length,1);
    scenarios.push('Один инструмент назначается в разные проекты без перезаписи связи и аудита другого проекта');

    const removed=await Promise.all(Array.from({length:4},()=>assets.remove(projectA,shared.id,'mcp','qa-remover')));
    assert.equal(removed.filter(Boolean).length,1);assert.equal(await assets.remove(projectA,shared.id,'mcp','qa-repeat'),false);
    const removal=await events(projectA,shared.id,'remove');assert.equal(removal.length,1);
    assert.equal(removal[0].actor,'qa-remover');assert.equal(removal[0].before_state.addedBy,'qa-original');
    assert.equal(removal[0].after_state,null);
    assert.equal(await count('SELECT count(*)::int AS n FROM project_assets WHERE project_id=$1 AND asset_id=$2',[projectB,shared.id]),1);
    scenarios.push('Конкурентное удаление и повтор возвращают true один раз; аудит разделяет удалившего и добавившего');

    await pool.query("ALTER TABLE security_events ADD CONSTRAINT qa_asset_add_failure CHECK(action<>'project.asset.add') NOT VALID");
    try{await assert.rejects(assets.add(projectA,shared.id,'mcp','qa-rejected'),error=>error.code==='23514');}
    finally{await pool.query('ALTER TABLE security_events DROP CONSTRAINT qa_asset_add_failure');}
    assert.equal(await count('SELECT count(*)::int AS n FROM project_assets WHERE project_id=$1 AND asset_id=$2',[projectA,shared.id]),0);
    assert.equal((await events(projectA,shared.id,'add')).length,1);
    scenarios.push('Настоящий SQL CHECK отказа аудита откатывает INSERT связи без ложного события');

    await pool.query("ALTER TABLE security_events ADD CONSTRAINT qa_asset_remove_failure CHECK(action<>'project.asset.remove') NOT VALID");
    try{await assert.rejects(assets.remove(projectB,shared.id,'mcp','qa-rejected'),error=>error.code==='23514');}
    finally{await pool.query('ALTER TABLE security_events DROP CONSTRAINT qa_asset_remove_failure');}
    assert.equal(await count('SELECT count(*)::int AS n FROM project_assets WHERE project_id=$1 AND asset_id=$2',[projectB,shared.id]),1);
    assert.equal((await events(projectB,shared.id,'remove')).length,0);
    scenarios.push('Настоящий SQL CHECK отказа аудита откатывает DELETE и сохраняет назначение');

    skillStorage=new FsSkillsStorage(skillDirectory);await skillStorage.init();
    const skills=new SkillsService(skillStorage),skillImports=new SkillAssetImportController(skills);
    await skills.createSkill({path:'common',slug:'skill-own-qa',name:'Own skill fixture',body:'Use the exact packaged version.',meta:{description:'Isolated assignment fixture',mcp:[],plugins:[],dependencies:[]}},'qa');
    process.env.NEUROCENTER_INTERNAL_TOKEN=token;
    skillServer=createServer(async(req,res)=>{
        try{
            let value;
            if(req.method==='POST'&&req.url==='/internal/asset-sources/skills/inspect'){
                const chunks=[];for await(const chunk of req)chunks.push(chunk);
                value=await skillImports.inspect(req,JSON.parse(Buffer.concat(chunks).toString()));
            }else if(req.method==='GET'&&req.url==='/api/skills/_package/common/skill-own-qa?version=1'){
                assert.equal(req.headers['x-neurocenter-internal'],token);value=await skills.getSkill('common/skill-own-qa',1);
            }else{res.writeHead(404);res.end();return;}
            res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
        }catch(error){res.writeHead(error.getStatus?.()||500,{'content-type':'application/json'});res.end(JSON.stringify({message:error.message}));}
    });
    await new Promise((resolve,reject)=>{skillServer.once('error',reject);skillServer.listen(0,'127.0.0.1',resolve);});
    process.env.SKILLS_SERVICE_URL='http://127.0.0.1:'+skillServer.address().port;
    const skillId='common/skill-own-qa';
    await assets.add(projectA,skillId,'skill','qa-skill-adder');
    assert.equal((await events(projectA,skillId,'add','skill'))[0].after_state.assetKind,'skill');
    assert.equal(await assets.remove(projectA,skillId,'skill','qa-skill-remover'),true);
    assert.equal((await events(projectA,skillId,'remove','skill'))[0].actor,'qa-skill-remover');
    scenarios.push('Назначение и удаление скилла имеют аудит без поиска скилла в таблице MCP');

    await assert.rejects(assets.add(projectA,'ai-plug-missing','mcp','qa-invalid'),error=>error.status===404);
    assert.equal(await count("SELECT count(*)::int AS n FROM project_assets WHERE asset_id='ai-plug-missing'"),0);
    assert.equal((await events(projectA,'ai-plug-missing','add')).length,0);
    scenarios.push('Отсутствующая карточка получает 404 без осиротевшей связи и события');

    await assert.rejects(assets.add(projectA,shared.id,'plugin','qa-invalid'),error=>error.status===409);
    assert.equal(await count("SELECT count(*)::int AS n FROM project_assets WHERE asset_id=$1 AND asset_kind='plugin'",[shared.id]),0);
    assert.equal((await events(projectA,shared.id,'add','plugin')).length,0);
    scenarios.push('Неверный тип существующей карточки получает 400 без связи и события');

    const addFirst=await plugins.create(input('назначение первое'),'qa-publisher');
    const addGate=controlledPool(sql=>sql.includes('FROM ai_plugins')&&sql.includes('FOR SHARE'));
    const deleteObserver=controlledPool(sql=>sql.includes('FROM ai_plugins')&&sql.includes('FOR UPDATE'));
    const adding=observed(new ProjectAssetRepository(addGate.pool).add(projectA,addFirst.id,'mcp','qa-race-adder'));
    let deleting;
    try{
        const addPid=await within(addGate.acquired,'назначение получило SHARE');
        deleting=observed(new PluginRepository(deleteObserver.pool).delete(addFirst.id,'qa-race-deleter'));
        const deletePid=await within(deleteObserver.attempt,'удаление запросило UPDATE');
        await assertBlockedBy(deletePid,addPid);
    }finally{addGate.release();deleteObserver.release();}
    await successful(adding);await rejected(deleting,409);
    assert.ok(await plugins.get(addFirst.id));
    assert.equal(await count('SELECT count(*)::int AS n FROM project_assets WHERE asset_id=$1',[addFirst.id]),1);
    assert.equal((await events(projectA,addFirst.id,'add')).length,1);
    assert.equal(await count("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.archive'",[addFirst.id]),0);
    scenarios.push('Назначение первым удерживает SHARE: архив действительно ждёт строку и получает 409 по назначенному exact pin после COMMIT');

    const deleteFirst=await plugins.create(input('удаление первое'),'qa-publisher');
    const deleteGate=controlledPool(sql=>sql.includes('FROM ai_plugins')&&sql.includes('FOR UPDATE'));
    const addObserver=controlledPool(sql=>sql.includes('FROM ai_plugins')&&sql.includes('FOR SHARE'));
    const deletingFirst=observed(new PluginRepository(deleteGate.pool).delete(deleteFirst.id,'qa-race-deleter'));
    let addingAfterDelete;
    try{
        const deletePid=await within(deleteGate.acquired,'удаление получило UPDATE');
        addingAfterDelete=observed(new ProjectAssetRepository(addObserver.pool).add(projectA,deleteFirst.id,'mcp','qa-race-adder'));
        const addPid=await within(addObserver.attempt,'назначение запросило SHARE');
        await assertBlockedBy(addPid,deletePid);
    }finally{deleteGate.release();addObserver.release();}
    assert.equal(await successful(deletingFirst),true);await rejected(addingAfterDelete,409);
    assert.ok((await plugins.get(deleteFirst.id)).archivedAt);assert.ok(await plugins.version(deleteFirst.id,1));
    assert.equal(await count('SELECT count(*)::int AS n FROM project_assets WHERE asset_id=$1',[deleteFirst.id]),0);
    assert.equal((await events(projectA,deleteFirst.id,'add')).length,0);
    assert.equal(await count("SELECT count(*)::int AS n FROM security_events WHERE resource_id=$1 AND action='plugin.archive'",[deleteFirst.id]),1);
    scenarios.push('Архив первым удерживает UPDATE: назначение действительно ждёт и получает 409; история сохранена, новой связи нет');

    const history=await listAuditHistory(pool,1,100);
    const visible=history.items.filter(event=>event.action.startsWith('project.asset.'));
    const stored=await count("SELECT count(*)::int AS n FROM security_events WHERE action LIKE 'project.asset.%'");
    assert.equal(visible.length,stored);assert.ok(visible.length>0);
    for(const event of visible){assert.equal(event.details,null);assert.equal(event.source,'security');assert.equal(event.outcome,'SUCCEEDED');
        assert.equal('before_state' in event||'after_state' in event,false);assert.match(event.resourceId,/prj-own-qa-[ab] · (mcp|skill) · /);}
    assert.ok(visible.some(event=>event.action==='project.asset.remove'&&event.actor==='qa-remover'));
    scenarios.push('Общий API аудита показывает исполнителя и составной ресурс, скрывая before/after payload');

    console.log(JSON.stringify({ok:true,scenarios:scenarios.length},null,2));
}catch(error){fatal=error.stack||String(error);console.error(fatal);process.exitCode=1;}
finally{
    await pool?.end();
    if(skillServer)await new Promise(resolve=>{skillServer.close(resolve);skillServer.closeAllConnections();});
    await skillStorage?.onModuleDestroy();await rm(skillDirectory,{recursive:true,force:true});
    if(originalSkillsUrl===undefined)delete process.env.SKILLS_SERVICE_URL;else process.env.SKILLS_SERVICE_URL=originalSkillsUrl;
    if(originalInternalToken===undefined)delete process.env.NEUROCENTER_INTERNAL_TOKEN;else process.env.NEUROCENTER_INTERNAL_TOKEN=originalInternalToken;
    if(created){await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);ownDatabaseDropped=true;}
    const afterDatabases=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const originalDatabasesPreserved=JSON.stringify(beforeDatabases)===JSON.stringify(afterDatabases);
    await admin.end();
    await mkdir(path.dirname(reportPath),{recursive:true});
    await writeFile(reportPath,JSON.stringify({ok:!fatal&&ownDatabaseDropped&&originalDatabasesPreserved,scenarios,fatal:fatal||null,
        ownDatabase:database,beforeDatabases,afterDatabases,ownDatabaseDropped,originalDatabasesPreserved,realCatalogRowsCreated:false},null,2)+'\n');
    if(!originalDatabasesPreserved){process.exitCode=1;}
}
