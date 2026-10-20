#!/usr/bin/env node
import {mkdir,lstat,realpath,rename,rm,open,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {assertProductionModelKey,productionModelKeyIdentity} from './model-credentials.mjs';
import {composeClient,composeConfiguration,containers,docker,maintenanceLock,serviceImageIds,applicationServices,repositoryRoot,saveDiagnostic} from './compose-client.mjs';
import {volumeKeys} from './recovery-files.mjs';
import {verifyBackup,writeManifest,projectDatabasePattern} from './recovery-manifest.mjs';

const directoryExists=async filename=>{try{await lstat(filename);return true;}catch(error){if(error.code==='ENOENT'){return false;}throw error;}};
const quote=value=>"'"+value.replace(/'/g,"''")+"'";
const sql=(container,database,text,run=docker)=>run(['exec','-i',container,'psql','-X','-U','nc_owner','-d',database,'-v','ON_ERROR_STOP=1','-At'],{input:text});

async function privateDirectory(directory,{create=true}={}){
    if(create){await mkdir(directory,{recursive:true,mode:0o700});}const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077){throw new Error('Каталог копий должен быть обычным каталогом с правами 700');}
    const resolved=await realpath(directory);if(/[,\x00-\x1f]/.test(resolved)){throw new Error('Путь копии содержит неподдерживаемые символы');}return resolved;
}

/** Рекурсивная копия собственного backup-тома и запись внутрь PG исключаются заранее. */
export function assertExternalDestination(destination,mounts){
    for(const {Source:source} of mounts){if(typeof source==='string'&&(destination===source||destination.startsWith(source+path.sep))){throw new Error('Каталог копии должен находиться вне рабочих томов Docker');}}
}

async function imageId(image){return JSON.parse(await docker(['image','inspect',image]))[0].Id;}
async function postgresContainer(client){
    const found=(await containers(client)).find(item=>item.Config.Labels['com.docker.compose.service']==='postgres');
    if(!found?.State.Running){throw new Error('PostgreSQL не запущен');}return found;
}

export function volumeNames(config){
    // Веса воспроизводятся из релиза, но уже существующий целевой том нельзя незаметно присоединить к восстановлению.
    const keys=['postgres',...volumeKeys,...(config.volumes?.['model-weights']?['model-weights']:[])];
    const names=Object.fromEntries(keys.map(key=>[key,config.volumes?.[key]?.name]));
    if(Object.values(names).some(name=>typeof name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name))){throw new Error('Нужны именованные production-тома');}return names;
}

export async function volumeTransfer(mode,location,names,image,run=docker,cleanupRun=docker){
    const worker='neurocenter-recovery-files-'+randomUUID();
    const args=['run','--rm','--name',worker,'--network','none','--read-only','--memory','512m','--cpus','1','--pids-limit','64','--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--security-opt','no-new-privileges'];
    args.push('--mount',`type=bind,source=${path.join(repositoryRoot,'scripts/production')},target=/recovery,readonly`);
    args.push('--mount',`type=bind,source=${location},target=/backup${mode==='backup'?'':',readonly'}`);
    for(const key of volumeKeys){args.push('--mount',`type=volume,source=${names[key]},target=/volumes/${key}${mode==='restore'?'':',readonly'}`);}
    try{await run([...args,image,'node','/recovery/recovery-files.mjs',mode]);}
    finally{
        // При разрыве Docker-клиента помощник не должен продолжать запись удаляемого partial-каталога.
        try{const id=await cleanupRun(['ps','--all','--filter','name=^/'+worker+'$','--format','{{.ID}}']);if(id){await cleanupRun(['rm','--force',id]);}}
        catch(error){Object.defineProperty(error,'retainPartial',{value:true});throw error;}
    }
}

async function databaseInventory(container,run=docker){
    const query=(database,text)=>sql(container,database,text,run);
    const version=Number(await query('postgres','SHOW server_version_num;'));
    if(Math.floor(version/10000)!==16){throw new Error('Поддерживается PostgreSQL 16');}
    const roles=JSON.parse(await query('postgres',"SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname !~ '^pg_';"));
    if(JSON.stringify(roles)!==JSON.stringify(['nc_backup','nc_catalog','nc_owner','nc_provisioner','nc_rag'])){throw new Error('В кластере есть нестандартные роли: требуется отдельная процедура восстановления');}
    if(await query('postgres','SELECT count(*) FROM pg_db_role_setting;')!=='0'){throw new Error('Нестандартные настройки ролей или баз требуют отдельной процедуры восстановления');}
    const extraTables=await query('postgres',"SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','m','S','v','f');");
    if(extraTables!=='0'){throw new Error('В служебной базе postgres есть пользовательские объекты');}
    const databases=JSON.parse(await query('postgres',"SELECT coalesce(json_agg(json_build_object('name',datname,'owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype) ORDER BY datname),'[]'::json) FROM pg_database WHERE datname NOT IN ('template0','template1','postgres','nc_rag_template');"));
    for(const db of databases){
        if(!(db.name==='catalog'||db.name==='rag'||projectDatabasePattern.test(db.name))||db.owner!==(db.name==='catalog'?'nc_catalog':'nc_rag')){throw new Error('Нестандартная база или её владелец: копирование остановлено');}
        db.file='databases/'+db.name+'.dump';
    }
    if(!databases.some(db=>db.name==='catalog')||!databases.some(db=>db.name==='rag')){throw new Error('Production-кластер не инициализирован');}
    const registered=JSON.parse(await query('rag',"SELECT coalesce(json_agg(database_name ORDER BY database_name),'[]'::json) FROM neurocenter_project_databases;"));
    if(registered.some(name=>!databases.some(db=>db.name===name))){throw new Error('В реестре есть отсутствующая проектная база');}
    return databases;
}

async function noOtherClients(container,run=docker){
    const count=await sql(container,'postgres',"SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid();",run);
    if(count!=='0'){throw new Error('К PostgreSQL ещё подключены другие клиенты: согласованная копия невозможна');}
}

async function noPendingJobs(container,run=docker){
    const count=await sql(container,'catalog',"SELECT count(*) FROM bridge_jobs WHERE state IN ('queued','running');",run);
    if(count!=='0'){throw new Error('Есть незавершённые задания MCP: дождитесь их завершения перед копированием');}
}

const backupAdapters={composeClient,composeConfiguration,containers,serviceImageIds,maintenanceLock,docker,volumeTransfer};

export function backupProduction(options,injected){
    if(options.beforePause!==undefined&&typeof options.beforePause!=='function'){throw new Error('beforePause должен быть проверкой перед остановкой');}
    return backupOperation(options,options.beforePause?{beforePause:options.beforePause}:undefined,injected);
}

/** Обновление держит ту же daemon-блокировку и получает управление только после проверенной копии. */
export function withQuiescedProductionBackup(options,hooks,injected){
    if(typeof hooks?.afterBackup!=='function'){throw new Error('Нужен обработчик обновления после копии');}
    return backupOperation(options,hooks,injected);
}

/** Дедлайн прерывает копирование; очистка и безопасный запуск приложений выполняются до возврата ошибки. */
export function pauseBudget(maxPauseMs,now=Date.now){
    if(maxPauseMs!==undefined&&(!Number.isSafeInteger(maxPauseMs)||maxPauseMs<1)){throw new Error('maxPauseMs должен быть положительным целым');}
    const deadline=maxPauseMs===undefined?Infinity:now()+maxPauseMs;
    return ()=>{const remaining=deadline-now();if(remaining<=0){const error=new Error('Превышена допустимая пауза обслуживания');error.code='MAINTENANCE_PAUSE_EXCEEDED';throw error;}return Number.isFinite(remaining)?remaining:30*60*1000;};
}

/** Согласованная офлайн-копия всех БД и четырёх серверных томов. */
async function backupOperation({directory,projectName,files=[],destination,offline=false,maxPauseMs,progress=()=>{}},hooks,injected={}){
    const {composeClient,composeConfiguration,containers,serviceImageIds,maintenanceLock,docker,volumeTransfer}={...backupAdapters,...injected};
    if(!offline){throw new Error('Укажите --offline: команда приостанавливает приложения на время копирования');}
    if(!destination){throw new Error('Укажите --destination для новой копии');}
    const parent=await privateDirectory(path.dirname(path.resolve(destination)),{create:false});destination=path.join(parent,path.basename(destination));
    if(await directoryExists(destination)){throw new Error('Каталог назначения уже существует: копия не перезаписывается');}
    const client=composeClient({directory,projectName,files});const config=await composeConfiguration(client);const names=volumeNames(config);
    const images=await serviceImageIds(config);const helperImage=images['catalog-service'];
    return maintenanceLock(client,helperImage,'backup',async()=>{
        const states=await containers(client);const applications=states.filter(item=>applicationServices.includes(item.Config.Labels['com.docker.compose.service']));
        if(applications.length!==applicationServices.length||applications.some(item=>item.Image!==images[item.Config.Labels['com.docker.compose.service']])){throw new Error('Образы контейнеров и выбранный production-релиз расходятся');}
        const unexpected=states.filter(item=>item.State.Running&&!applicationServices.includes(item.Config.Labels['com.docker.compose.service'])&&!['postgres','capacity-collector','model-runtime'].includes(item.Config.Labels['com.docker.compose.service']));
        if(unexpected.length){throw new Error('В проекте запущены посторонние сервисы');}
        const postgres=states.find(item=>item.Config.Labels['com.docker.compose.service']==='postgres');
        if(!postgres?.State.Running){throw new Error('PostgreSQL не запущен');}
        const running=applications.filter(item=>item.State.Running).map(item=>item.Config.Labels['com.docker.compose.service']);
        assertExternalDestination(destination,states.flatMap(item=>item.Mounts));
        await noPendingJobs(postgres.Id,docker);
        const catalog=applications.find(item=>item.Config.Labels['com.docker.compose.service']==='catalog-service');
        if(catalog?.State.Running){
            const busy=await docker(['exec',catalog.Id,'node','-e',"console.log(require('fs').existsSync('/app/backups/.neurocenter-backup.lock'))"]);
            if(busy==='true'){throw new Error('Есть незавершённая резервная копия: дождитесь завершения или проверьте хранилище перед остановкой');}
        }
        // Изменённый Compose-файл не должен незаметно подменить реальные тома пустыми.
        for(const [service,target,key] of [['skills-service','/app/data/skills','skills'],['catalog-service','/data/projects','projects'],['catalog-service','/app/backups','backups'],['catalog-service','/app/runtime-artifacts','runtime-artifacts'],['rag-sync-service','/data/projects','projects'],['postgres','/var/lib/postgresql/data','postgres']]){
            const container=states.find(item=>item.Config.Labels['com.docker.compose.service']===service);const mount=container?.Mounts.find(item=>item.Destination===target);
            if(mount?.Type!=='volume'||mount.Name!==names[key]){throw new Error('Тома рабочего стека расходятся с выбранным Compose-профилем');}
        }
        await hooks?.beforePause?.();
        const temporary=destination+'.partial-'+randomUUID();await mkdir(temporary,{mode:0o700});let paused=false;let updating=false;let retainPartial=false;
        const started=Date.now();let result;let remainingMs;
        const timedDocker=async(args,options={})=>{try{return await docker(args,{...options,timeout:Math.min(options.timeout??30*60*1000,remainingMs())});}catch(error){remainingMs();throw error;}};
        try{
            remainingMs=pauseBudget(maxPauseMs);progress('Приостанавливаем приложения');paused=true;if(running.length){try{await client.run(['stop','--timeout','45',...running],{timeout:remainingMs()});}catch(error){remainingMs();throw error;}}
            remainingMs();
            const stopped=await containers({...client,run:(args,options={})=>client.run(args,{...options,timeout:remainingMs()})},timedDocker);
            if(stopped.some(item=>applicationServices.includes(item.Config.Labels['com.docker.compose.service'])&&(item.State.Running||item.State.OOMKilled||![0,143].includes(item.State.ExitCode)))){throw new Error('Приложение завершилось аварийно: перед копированием проверьте восстановление операций');}
            await noOtherClients(postgres.Id,timedDocker);await noPendingJobs(postgres.Id,timedDocker);const createdAt=new Date().toISOString();const databases=await databaseInventory(postgres.Id,timedDocker);
            await mkdir(path.join(temporary,'databases'),{mode:0o700});
            for(const db of databases){progress('Копируем БД '+db.name);await timedDocker(['exec',postgres.Id,'pg_dump','-U','nc_owner','-d',db.name,'--format=custom'],{outputFile:path.join(temporary,db.file)});}
            progress('Копируем Markdown, серверные проекты, готовые комплекты и сохранённые копии');await volumeTransfer('backup',temporary,names,helperImage,timedDocker);
            await noOtherClients(postgres.Id,timedDocker);
            const {manifest,sha256}=await writeManifest(temporary,{createdAt,postgresMajor:16,postgresImage:postgres.Image,images,quiesced:true,databases},{checkDeadline:remainingMs});
            await verifyBackup(temporary,sha256,{checkDeadline:remainingMs});remainingMs();await rename(temporary,destination);
            const handle=await open(parent,'r');try{await handle.sync();}finally{await handle.close();}
            remainingMs();result={ok:true,destination,sha256,createdAt,databases:databases.length,files:manifest.entries.filter(entry=>entry.type==='file').length,bytes:manifest.entries.reduce((sum,entry)=>sum+(entry.size||0),0)};
            if(hooks?.afterBackup){updating=true;return await hooks.afterBackup({...result,durationMs:Date.now()-started},{remainingMs});}
        }catch(error){retainPartial=error.retainPartial===true;throw error;}
        finally{
            try{if(!retainPartial){await rm(temporary,{recursive:true,force:true});}}
            finally{if(paused&&!updating&&running.length){progress('Возвращаем приложения в работу');await client.run(['start','--wait',...running]);}}
        }
        return {...result,durationMs:Date.now()-started};
    });
}

export async function assertNewTarget(client,names,injected={}){
    const deps={docker,containers,...injected};
    const volumes=(await deps.docker(['volume','ls','--format','{{.Name}}'])).split('\n');
    if((await deps.containers(client)).length||Object.values(names).some(name=>volumes.includes(name))){throw new Error('Восстановление разрешено только в новый Compose-проект без существующих контейнеров и томов');}
}

/** Восстановление никогда не удаляет или перезаписывает существующий рабочий стек. */
export async function restoreProduction({directory,projectName,files=[],source,expectedHash,progress=()=>{}}){
    if(!projectName){throw new Error('Укажите --project-name для нового стека восстановления');}
    source=await realpath(source);if(/[,\x00-\x1f]/.test(source)){throw new Error('Некорректный путь копии');}
    progress('Проверяем весь комплект до создания целевого PostgreSQL');const manifest=await verifyBackup(source,expectedHash);
    const client=composeClient({directory,projectName,files});const config=await composeConfiguration(client);const names=volumeNames(config);const images=await serviceImageIds(config);
    await productionModelKeyIdentity(directory,config);
    if(applicationServices.some(service=>images[service]!==manifest.images[service])||await imageId(config.services.postgres.image)!==manifest.postgresImage){throw new Error('Для восстановления нужны те же образы, что были при копировании; обновление выполняется отдельно');}
    return maintenanceLock(client,images['catalog-service'],'restore',async()=>{
        await assertNewTarget(client,names);const started=Date.now();
        progress('Готовим новый пустой кластер и роли из закрытой конфигурации');await client.run(['up','-d','--wait','postgres']);
        await client.run(['--profile','setup','run','--rm','database-init']);const postgres=await postgresContainer(client);
        await client.run(['create','--no-recreate','--no-build','catalog-service','skills-service']);
        await volumeTransfer('check-empty',source,names,images['catalog-service']);
        // Ни bootstrap, ни серверные процессы ещё не запускались: эти две базы созданы только initializer.
        for(const name of ['catalog','rag']){await sql(postgres.Id,'postgres','DROP DATABASE '+name+';');}
        for(const db of manifest.databases){
            progress('Восстанавливаем БД '+db.name);
            await sql(postgres.Id,'postgres',`CREATE DATABASE ${db.name} OWNER ${db.owner} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE ${quote(db.collate)} LC_CTYPE ${quote(db.ctype)}; REVOKE ALL ON DATABASE ${db.name} FROM PUBLIC;${db.name==='catalog'?'':` GRANT CONNECT ON DATABASE ${db.name} TO nc_backup;`}`);
            await docker(['exec','-i',postgres.Id,'pg_restore','-U','nc_owner','--exit-on-error','--single-transaction','--dbname',db.name],{inputFile:path.join(source,db.file)});
            await sql(postgres.Id,db.name,'ANALYZE;');
        }
        progress('Восстанавливаем серверные файлы');await volumeTransfer('restore',source,names,images['catalog-service']);
        await volumeTransfer('verify',source,names,images['catalog-service']);
        const actual=await databaseInventory(postgres.Id);
        if(JSON.stringify(actual)!==JSON.stringify(manifest.databases)){throw new Error('Список восстановленных баз расходится с описью');}
        await assertProductionModelKey(directory,config,input=>sql(postgres.Id,'catalog',input));
        // Старые коды подключения и индикатор online не переживают перенос на другой сервер.
        await sql(postgres.Id,'catalog','BEGIN; DELETE FROM bridge_pairs; UPDATE bridge_devices SET last_seen=NULL; COMMIT;');
        // Квитанция хранится отдельно от исходной копии; сессии и публичные приложения остаются остановлены.
        const receipt={ok:true,projectName,sha256:expectedHash,restoredAt:new Date().toISOString(),databases:actual.length,durationMs:Date.now()-started,applicationsStarted:false};
        const receipts=await privateDirectory(path.join(directory,'recovery-receipts'));await writeFile(path.join(receipts,projectName+'-'+randomUUID()+'.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
        return receipt;
    });
}

async function main(){
    process.umask(0o077);const args=process.argv.slice(2);const mode=args.shift();
    const values={files:[],progress:message=>console.error(message)};const options={'--directory':'directory','--project-name':'projectName','--destination':'destination','--source':'source','--expect-sha256':'expectedHash','--max-pause-ms':'maxPauseMs'};
    for(let i=0;i<args.length;i++){
        if(args[i]==='--offline'){values.offline=true;continue;}
        const key=options[args[i]];if(!key||!args[i+1]||args[i+1].startsWith('--')){throw new Error('Неизвестный или незаполненный параметр '+args[i]);}values[key]=args[++i];
    }
    if(values.maxPauseMs!==undefined){values.maxPauseMs=Number(values.maxPauseMs);}
    values.directory=path.resolve(values.directory||path.join(repositoryRoot,'deploy/production/local'));
    let result;
    if(mode==='backup'){result=await backupProduction(values);}
    else if(mode==='verify'){result={ok:true,databases:(await verifyBackup(path.resolve(values.source),values.expectedHash)).databases.length};}
    else if(mode==='restore'){result=await restoreProduction(values);}
    else{throw new Error('Команды: backup --offline --destination <новая папка> | verify | restore --project-name <новый стек>; для verify/restore: --source <копия> --expect-sha256 <квитанция>');}
    console.log(JSON.stringify(result,null,2));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    void main().catch(async error=>{
        console.error(error.message);const i=process.argv.indexOf('--directory');const directory=path.resolve(i<0?path.join(repositoryRoot,'deploy/production/local'):process.argv[i+1]||'.');
        const diagnostic=await saveDiagnostic(error,directory).catch(()=>undefined);if(diagnostic){console.error('Закрытый технический журнал: '+diagnostic);}process.exitCode=1;
    });
}
