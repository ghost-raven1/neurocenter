import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,realpath,chmod,lstat,link,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {applicationServices} from '../production/compose-client.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const schemaServices=['catalog-service','feature-flags-service','rag-sync-service'];
const schemaCommand=(service,mode)=>['run','--rm','--no-deps','-T','--read-only','--pull','never','--entrypoint','node',service,'dist/database/migrate.cli.js',mode];
const migrateCommand=service=>schemaCommand(service,'migrate');
const bindingCommands=['container-check','schema-images','schema-identity'];
const freshSchemaCommands=[...schemaServices.map(service=>schemaCommand(service,'check')),...bindingCommands,...schemaServices.flatMap(service=>[...bindingCommands,migrateCommand(service)]),...bindingCommands];
/** Настоящий CLI в отдельном checkout, без Docker/сети/пользовательской БД. */
async function fixture(t,mode,fail='',initial={}){
    const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'nc setup source ')));t.after(()=>rm(directory,{recursive:true,force:true}));
    const scripts=path.join(directory,'scripts/production'),config=path.join(directory,'config'),calls=path.join(directory,'calls.jsonl');
    await mkdir(scripts,{recursive:true});await mkdir(path.join(directory,'scripts/workspace'));await writeFile(path.join(directory,'scripts/workspace/model-credentials.mjs'),'export const ensureModelCredentialKey=async()=>{};');await mkdir(config,{mode:0o700});await writeFile(path.join(config,'.env'),"NEUROCENTER_RELEASE='fixture'\n",{mode:0o600});await writeFile(path.join(config,'tls'),'fixture');
    await copyFile(path.join(root,'scripts/production/setup.mjs'),path.join(scripts,'setup.mjs'));
    await copyFile(path.join(root,'scripts/production/schema-migrations.mjs'),path.join(scripts,'schema-migrations.mjs'));
    await copyFile(path.join(root,'scripts/production/schema-initialization.mjs'),path.join(scripts,'schema-initialization.mjs'));
    await writeFile(path.join(scripts,'configuration.mjs'),'export const ensureMetricsToken=async()=>{};export const configureProduction=async()=>{};');
    await writeFile(path.join(scripts,'model-credentials.mjs'),`import fs from 'node:fs';export const assertProductionModelKey=async()=>{fs.appendFileSync(process.env.SETUP_CALLS,JSON.stringify('key-check')+'\\n');if(process.env.SETUP_FAIL==='model-key')throw Error('fixture failed');};`);
    await writeFile(path.join(scripts,'compose-client.mjs'),`
        import fs from 'node:fs';
        const record=value=>fs.appendFileSync(process.env.SETUP_CALLS,JSON.stringify(value)+'\\n');
        export const applicationServices=${JSON.stringify(applicationServices)};
        const stateFile=${JSON.stringify(path.join(config,'fixture-state.json'))};
        const state=()=>fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
        export const containers=async()=>{record('container-check');return state().drift==='app'||process.env.SETUP_APP_RUNNING==='true'||process.env.SETUP_APP_STOPPED==='true'?[{Config:{Labels:{'com.docker.compose.service':'frontend'}},State:{Running:process.env.SETUP_APP_RUNNING==='true'}}]:[];};
        export const serviceImageIds=async()=>{record('schema-images');return Object.fromEntries(applicationServices.map(service=>[service,'sha256:'+(state().drift==='image'?'b':process.env.SETUP_IMAGE).repeat(64)]));};
        export const composeClient=clientOptions=>({run:async(command,options)=>{
            if(options?.input?.includes('pg_control_system')){record('schema-identity');return JSON.stringify({systemIdentifier:state().drift==='cluster'?'1234567890123456790':process.env.SETUP_CLUSTER_ID,databases:{catalog:state().drift==='database'?'12346':process.env.SETUP_DATABASE_ID,rag:'54321'}});}
            record(command);if(command.includes(process.env.SETUP_FAIL)&&process.env.SETUP_FAIL)throw Error('fixture failed');
            const service=command.at(-3),current=state(),ready=process.env.SETUP_SCHEMA_READY==='true'||current[service]===true;
            if(command.at(-1)==='check')return process.env.SETUP_CHECK_OUTPUT||JSON.stringify({ok:true,ready,existingSchema:ready||process.env.SETUP_EXISTING_SCHEMA==='true'||command.includes('rag-sync-service')&&process.env.SETUP_RAG_EXISTING==='true',applied:ready?[1]:JSON.parse(process.env.SETUP_APPLIED),pending:ready?[]:[1]});
            if(command.at(-1)==='migrate'){
                if(clientOptions.files?.length){const overlay=clientOptions.files.at(-1);const image=JSON.parse(fs.readFileSync(overlay,'utf8')).services[service].image;fs.appendFileSync(${JSON.stringify(path.join(config,'pinned-images.jsonl'))},JSON.stringify({service,image,overlay})+'\\n');}
                if(service===process.env.SETUP_FAIL_MIGRATION_ONCE&&!current.failed){current.failed=true;fs.writeFileSync(stateFile,JSON.stringify(current));throw Error('fixture transient migration failed');}
                current[service]=true;
                if(service===process.env.SETUP_MUTATE_AFTER){current.drift=process.env.SETUP_MUTATION;if(current.drift==='env')fs.writeFileSync(${JSON.stringify(path.join(config,'.env'))},"NEUROCENTER_RELEASE='changed'\\n");}
                fs.writeFileSync(stateFile,JSON.stringify(current));return JSON.stringify({ok:true,ready:true,existingSchema:true,applied:[1],pending:[]});
            }
            if(command.includes('bootstrap-admin')||command.join(' ')==='up -d --wait'){
                const receipt=${JSON.stringify(path.join(config,'schema-initialization.json'))};
                if(fs.existsSync(receipt)&&JSON.parse(fs.readFileSync(receipt,'utf8')).state!=='schema-ready')throw Error('fixture apps started before schema-ready receipt');
            }
            return '';
        }});
        export const composeConfiguration=async()=>({services:{'catalog-service':{image:'fixture',environment:{VARIANT:state().drift==='config'?'changed':process.env.SETUP_CONFIG_VARIANT}}},secrets:{tls_cert:{file:${JSON.stringify(path.join(config,'tls'))}},tls_key:{file:${JSON.stringify(path.join(config,'tls'))}}}});
        export const maintenanceLock=async(client,image,mode,action)=>{record('lock');try{return await action();}finally{record('unlock');}};
    `);
    const preload=path.join(directory,'no-network.mjs');await writeFile(preload,'globalThis.fetch=()=>{throw Error("Unexpected asset network")};');
    const readCalls=()=>readFile(calls,'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(JSON.parse),error=>{if(error.code==='ENOENT')return [];throw error;});
    const run=async changes=>{
        const options={ready:false,running:false,stopped:false,applied:[],existingSchema:false,ragExisting:false,image:'a',databaseId:'12345',clusterId:'1234567890123456789',configVariant:'same',...initial,...changes};
        const offset=(await readCalls()).length;
        const result=spawnSync(process.execPath,['--import',preload,path.join(scripts,'setup.mjs'),mode,'--directory',config,'--project-name','fixture'],
            {encoding:'utf8',env:{...process.env,SETUP_CALLS:calls,SETUP_FAIL:fail,SETUP_SCHEMA_READY:String(options.ready),SETUP_APP_RUNNING:String(options.running),SETUP_APP_STOPPED:String(options.stopped),SETUP_APPLIED:JSON.stringify(options.applied),SETUP_EXISTING_SCHEMA:String(options.existingSchema),SETUP_RAG_EXISTING:String(options.ragExisting),SETUP_CHECK_OUTPUT:options.checkOutput??'',SETUP_IMAGE:options.image,SETUP_DATABASE_ID:options.databaseId,SETUP_CLUSTER_ID:options.clusterId,SETUP_CONFIG_VARIANT:options.configVariant,SETUP_FAIL_MIGRATION_ONCE:options.failMigrationOnce??'',SETUP_MUTATE_AFTER:options.mutateAfter??'',SETUP_MUTATION:options.mutation??''},timeout:10000});assert.equal(result.error,undefined);
        return {result,events:(await readCalls()).slice(offset)};
    };
    return {...await run(),run,config,receiptFile:path.join(config,'schema-initialization.json'),pinnedImagesFile:path.join(config,'pinned-images.jsonl')};
}
test('Production up запускает пустой каталог без скрытого импорта ассетов и весов',async t=>{
    const {result,events}=await fixture(t,'up');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(events,['lock',['up','-d','--wait','postgres'],['--profile','setup','run','--rm','database-init'],...freshSchemaCommands,'key-check',['up','-d','--wait','capacity-collector'],['up','-d','--wait'],'unlock']);
});
test('Production build не готовит старые bridge-dist/runtime или source binaries',async t=>{
    const {result,events}=await fixture(t,'build');assert.equal(result.status,0,result.stderr);assert.deepEqual(events,[['build']]);
});
test('Fresh DDL использует закреплённые image IDs, а временный overlay удаляется',async t=>{
    const f=await fixture(t,'up');assert.equal(f.result.status,0,f.result.stderr);
    const pinned=(await readFile(f.pinnedImagesFile,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(pinned.map(({service,image})=>({service,image})),schemaServices.map(service=>({service,image:'sha256:'+'a'.repeat(64)})));
    assert.equal(new Set(pinned.map(item=>item.overlay)).size,1);await assert.rejects(lstat(pinned[0].overlay),{code:'ENOENT'});
});
for(const mutation of ['env','config','image','database','cluster','app'])test('Изменение окружения внутри fresh attempt не фиксирует schema-ready: '+mutation,async t=>{
    const f=await fixture(t,'up','',{mutateAfter:'rag-sync-service',mutation});assert.equal(f.result.status,1,f.result.stderr);
    assert.match(f.result.stderr,/квитанция|контейнерах приложений/);
    assert.equal(JSON.parse(await readFile(f.receiptFile,'utf8')).state,'initializing');
    assert.equal(f.events.filter(value=>Array.isArray(value)&&value.at(-1)==='migrate').length,3);
    assert.ok(!f.events.some(value=>value==='key-check'||Array.isArray(value)&&value[0]==='up'&&value.at(-1)!=='postgres'));
    const pinned=(await readFile(f.pinnedImagesFile,'utf8')).trim().split('\n').map(JSON.parse);await assert.rejects(lstat(pinned[0].overlay),{code:'ENOENT'});
});
test('Изменение tag после первого CLI останавливает следующие DDL',async t=>{
    const f=await fixture(t,'up','',{mutateAfter:'catalog-service',mutation:'image'});assert.equal(f.result.status,1);assert.match(f.result.stderr,/квитанция/);
    assert.equal(f.events.filter(value=>Array.isArray(value)&&value.at(-1)==='migrate').length,1);
    assert.equal(JSON.parse(await readFile(f.receiptFile,'utf8')).state,'initializing');
});
test('Seed создаёт только первого администратора и не добавляет карточки',async t=>{
    const {result,events}=await fixture(t,'seed');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(events,['lock',['up','-d','--wait','postgres'],['--profile','setup','run','--rm','database-init'],...freshSchemaCommands,'key-check',['--profile','setup','run','--rm','bootstrap-admin'],'unlock']);
});
test('Pending DDL при живых приложениях требует update, не останавливая и не мигрируя их',async t=>{
    const {result,events}=await fixture(t,'up','',{running:true});assert.equal(result.status,1);assert.match(result.stderr,/production update/);
    assert.ok(events.includes('container-check'));assert.ok(!events.some(value=>Array.isArray(value)&&['migrate','stop','restart'].includes(value.at(-1))));
    assert.ok(!events.some(value=>Array.isArray(value)&&value[0]==='up'&&value.at(-1)!=='postgres'));assert.equal(events.at(-1),'unlock');
});
test('Ready schema разрешает idempotent up при уже живых приложениях',async t=>{
    const {result,events}=await fixture(t,'up','',{ready:true,running:true});assert.equal(result.status,0,result.stderr);
    assert.equal(events.filter(value=>Array.isArray(value)&&value.at(-1)==='migrate').length,3);
    assert.ok(events.some(value=>Array.isArray(value)&&value.join(' ')==='up -d --wait'));
});
for(const state of [{applied:[1,2,3,4,5],existingSchema:false},{applied:[],existingSchema:true},{ragExisting:true}])test('Остановленный существующий стек требует backup/update до новых DDL: '+JSON.stringify(state),async t=>{
    const {result,events}=await fixture(t,'up','',state);assert.equal(result.status,1);assert.match(result.stderr,/production update/);
    assert.ok(!events.some(value=>Array.isArray(value)&&value.at(-1)==='migrate'));
    assert.ok(!events.some(value=>Array.isArray(value)&&value[0]==='up'&&value.at(-1)!=='postgres'));assert.equal(events.at(-1),'unlock');
});
test('Unknown check не превращается в разрешение DDL или запуска приложений',async t=>{
    const {result,events}=await fixture(t,'up','',{checkOutput:'not-json'});assert.equal(result.status,1);assert.match(result.stderr,/готовность схемы/);
    assert.ok(!events.some(value=>Array.isArray(value)&&value.at(-1)==='migrate'));
    assert.ok(!events.some(value=>Array.isArray(value)&&value[0]==='up'&&value.at(-1)!=='postgres'));assert.equal(events.at(-1),'unlock');
});
for(const stage of ['postgres','database-init',...schemaServices,'model-key','capacity-collector'])test('Отказ '+stage+' не запускает приложения и освобождает обслуживание',async t=>{
    const {result,events}=await fixture(t,'up',stage);assert.equal(result.status,1);assert.match(result.stderr,/fixture failed/);
    assert.equal(events.some(value=>Array.isArray(value)&&value.join(' ')==='up -d --wait'),false);assert.equal(events.at(-1),'unlock');
});
for(const service of ['feature-flags-service','rag-sync-service'])test('Fresh setup повторяет тот же durable intent после частично применённых схем: '+service,async t=>{
    const f=await fixture(t,'up','',{failMigrationOnce:service});assert.equal(f.result.status,1);assert.match(f.result.stderr,/transient migration failed/);
    const before=JSON.parse(await readFile(f.receiptFile,'utf8'));assert.equal(before.state,'initializing');
    assert.ok(!f.events.some(value=>Array.isArray(value)&&value.join(' ')==='up -d --wait'));
    const retried=await f.run();assert.equal(retried.result.status,0,retried.result.stderr);
    const after=JSON.parse(await readFile(f.receiptFile,'utf8'));assert.equal(after.state,'schema-ready');
    assert.equal(after.requestKey,before.requestKey);assert.equal(after.createdAt,before.createdAt);assert.deepEqual(after.binding,before.binding);
    assert.equal((await lstat(f.receiptFile)).mode&0o777,0o600);
});
for(const changed of [{image:'b'},{databaseId:'12346'},{clusterId:'1234567890123456790'},{configVariant:'changed'}])test('Fresh continuation отвергает другой образ/кластер/БД/конфигурацию: '+JSON.stringify(changed),async t=>{
    const f=await fixture(t,'up','',{failMigrationOnce:'feature-flags-service'});assert.equal(f.result.status,1);
    const before=await readFile(f.receiptFile,'utf8'),retried=await f.run(changed);assert.equal(retried.result.status,1);assert.match(retried.result.stderr,/квитанция/);
    assert.ok(!retried.events.some(value=>Array.isArray(value)&&value.at(-1)==='migrate'));assert.equal(await readFile(f.receiptFile,'utf8'),before);
});
test('Изменённый env не переиспользует разрешение первоначальной инициализации',async t=>{
    const f=await fixture(t,'up','',{failMigrationOnce:'feature-flags-service'});await writeFile(path.join(f.config,'.env'),"NEUROCENTER_RELEASE='other'\n");
    const retried=await f.run();assert.equal(retried.result.status,1);assert.match(retried.result.stderr,/квитанция/);
    assert.ok(!retried.events.some(value=>Array.isArray(value)&&value.at(-1)==='migrate'));
});
for(const presence of [{running:true},{stopped:true}])test('Fresh continuation не касается появившегося app container: '+JSON.stringify(presence),async t=>{
    const f=await fixture(t,'up','',{failMigrationOnce:'feature-flags-service'});const retried=await f.run(presence);
    assert.equal(retried.result.status,1);assert.match(retried.result.stderr,/контейнерах приложений/);
    assert.ok(!retried.events.some(value=>Array.isArray(value)&&['migrate','stop','restart'].includes(value.at(-1))));
});
test('Новая fresh квитанция не создаётся при остановленном app container',async t=>{
    const f=await fixture(t,'up','',{stopped:true});assert.equal(f.result.status,1);await assert.rejects(lstat(f.receiptFile),{code:'ENOENT'});
});
for(const corruption of ['json','foreign-project','foreign-owner','permissions','hardlink','symlink'])test('Неподтверждённая fresh квитанция не разрешает продолжение: '+corruption,async t=>{
    const f=await fixture(t,'up','',{failMigrationOnce:'feature-flags-service'});
    if(corruption==='json')await writeFile(f.receiptFile,'not-json');
    if(corruption==='permissions')await chmod(f.receiptFile,0o644);
    if(corruption==='foreign-project'||corruption==='foreign-owner'){
        const value=JSON.parse(await readFile(f.receiptFile,'utf8'));
        if(corruption==='foreign-project')value.projectName='different';else value.ownerUid=-1;
        await writeFile(f.receiptFile,JSON.stringify(value));
    }
    if(corruption==='hardlink')await link(f.receiptFile,path.join(f.config,'second-link'));
    if(corruption==='symlink'){
        const value=await readFile(f.receiptFile);await rm(f.receiptFile);const target=path.join(f.config,'other-receipt');await writeFile(target,value,{mode:0o600});await symlink(target,f.receiptFile);
    }
    const retried=await f.run();assert.equal(retried.result.status,1);assert.match(retried.result.stderr,/квитанция/);
    assert.ok(!retried.events.some(value=>Array.isArray(value)&&value.at(-1)==='migrate'));
});
test('Schema-ready историческая квитанция не разрешает новые pending DDL',async t=>{
    const f=await fixture(t,'up');assert.equal(f.result.status,0,f.result.stderr);
    const stateFile=path.join(f.config,'fixture-state.json'),state=JSON.parse(await readFile(stateFile,'utf8'));delete state['rag-sync-service'];await writeFile(stateFile,JSON.stringify(state));
    const retried=await f.run();assert.equal(retried.result.status,1);assert.match(retried.result.stderr,/production update/);
    assert.ok(!retried.events.some(value=>Array.isArray(value)&&value.at(-1)==='migrate'));
});
