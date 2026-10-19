#!/usr/bin/env node
import {readFile,writeFile,mkdir,lstat,rename,open,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {applicationServices,composeClient,composeConfiguration,containers,docker,serviceImageIds,repositoryRoot,saveDiagnostic} from './compose-client.mjs';
import {withQuiescedProductionBackup} from './recovery.mjs';
import {runCatalogSync} from './sync-catalog.mjs';
import {runModelBundleSync} from './sync-models.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const imagePattern=/^sha256:[a-f0-9]{64}$/;
const releasePattern=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const adapters={composeClient,composeConfiguration,containers,docker,serviceImageIds,runCatalogSync,runModelBundleSync,withBackup:withQuiescedProductionBackup};
const sameImages=(left,right)=>applicationServices.every(service=>left?.[service]===right?.[service]);

/** План привязан к точным образам и квитанции репетиции, а не к подвижной метке latest. */
export function validateUpdatePlan(plan){
    if(plan?.format!=='neurocenter-update-v1'||!(/^[a-z0-9][a-z0-9_-]{0,62}$/).test(plan.id||'')){throw new Error('Некорректный план обновления');}
    for(const key of ['sourceRelease','targetRelease']){
        if(!releasePattern.test(plan[key]||'')||plan[key]==='latest'){throw new Error('Нужны постоянные метки исходного и нового релиза');}
    }
    if(plan.sourceRelease===plan.targetRelease||!imagePattern.test(plan.postgresImage||'')||plan.rollback!=='restore-new-project'
        ||!['backward-compatible','restore-required'].includes(plan.migrationCompatibility)||!(/^[a-f0-9]{64}$/).test(plan.rehearsalSha256||'')){
        throw new Error('Не заданы совместимость, репетиция и восстановление в новый проект');
    }
    for(const key of ['sourceImages','targetImages']){
        if(Object.keys(plan[key]||{}).length!==applicationServices.length||applicationServices.some(service=>!imagePattern.test(plan[key]?.[service]||''))){throw new Error('Зафиксируйте все '+applicationServices.length+' образов '+key);}
    }
    if(!Number.isSafeInteger(plan.maxPauseMs)||plan.maxPauseMs<60000||plan.maxPauseMs>86400000){throw new Error('maxPauseMs должен быть от минуты до суток');}
    assertMigrationPrefix([],plan.catalogMigrations);
    return plan;
}

/** Старый/изменённый префикс миграций отклоняется до остановки приложений. */
export function assertMigrationPrefix(applied,target){
    if(!Array.isArray(target)||target.some((row,index)=>row?.version!==index+1||typeof row.name!=='string'||!row.name||!(/^[a-f0-9]{64}$/).test(row.checksum||''))){throw new Error('Некорректная опись миграций нового образа');}
    if(!Array.isArray(applied)||applied.length>target.length||applied.some((row,index)=>!isDeepStrictEqual(row,target[index]))){throw new Error('История миграций несовместима с новым образом');}
}

function releaseOf(text){
    const matches=[...text.matchAll(/^NEUROCENTER_RELEASE=(?:'([^'\r\n]*)'|"([^"\r\n]*)"|([^\r\n#]+))\r?$/gm)];
    if(matches.length!==1){throw new Error('В .env нужна ровно одна NEUROCENTER_RELEASE');}
    return (matches[0][1]??matches[0][2]??matches[0][3]).trim();
}
function topology(config){
    const value=structuredClone(config);
    for(const service of [...applicationServices,'database-init','bootstrap-admin','capacity-collector','model-volume-init']){if(value.services?.[service]){delete value.services[service].image;}}
    return value;
}
async function privateFile(filename){
    const info=await lstat(filename);
    if(!info.isFile()||info.nlink!==1||info.mode&0o077||info.size>1024*1024){throw new Error('Нужен закрытый обычный файл '+path.basename(filename));}
    return readFile(filename,'utf8');
}
async function atomicWrite(filename,value){
    const temporary=filename+'.'+randomUUID()+'.tmp';
    try{
        await writeFile(temporary,value,{flag:'wx',mode:0o600,flush:true});await rename(temporary,filename);
        const handle=await open(path.dirname(filename),'r');try{await handle.sync();}finally{await handle.close();}
    }finally{await rm(temporary,{force:true});}
}
async function privateFolder(directory,{create=false}={}){
    if(create){await mkdir(directory,{mode:0o700});}
    const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077){throw new Error('Нужен закрытый обычный каталог обновления');}
}
async function rehearsal(filename,plan){
    const raw=await privateFile(filename);
    if(sha(raw)!==plan.rehearsalSha256){throw new Error('Репетиция не соответствует SHA256 плана');}
    const report=JSON.parse(raw);
    if(report.format!=='neurocenter-update-rehearsal-v1'||report.passed!==true||report.copyOfData!==true||report.settingsPreserved!==true
        ||report.repeatSafe!==true||report.restoreVerified!==true||report.postgresImage!==plan.postgresImage
        ||!sameImages(report.sourceImages,plan.sourceImages)||!sameImages(report.targetImages,plan.targetImages)){
        throw new Error('Нужна успешная репетиция на копии данных для этих точных образов');
    }
}
async function assertLive(client,expected,postgresImage,deps){
    const values=await deps.containers(client);
    for(const service of [...applicationServices,'postgres']){
        const selected=values.filter(item=>item.Config?.Labels?.['com.docker.compose.service']===service);
        if(selected.length!==1||!selected[0].State?.Running||selected[0].State.Health?.Status!=='healthy'
            ||selected[0].Image!==(service==='postgres'?postgresImage:expected[service])){throw new Error('Состояние или образ сервиса расходится с планом: '+service);}
    }
}

/** Preflight читает Docker/БД и проверяет настройки; контейнеры и копии не создаёт. */
export async function preflightUpdate(options,injected={}){
    const deps={...adapters,...injected};const {plan,directory,projectName,files=[]}=options;
    validateUpdatePlan(plan);await rehearsal(options.rehearsalFile,plan);
    const env=await privateFile(path.join(directory,'.env'));
    if(releaseOf(env)!==plan.sourceRelease){throw new Error('Исходная метка .env расходится с планом');}
    const source=deps.composeClient({directory,projectName,files});const target=deps.composeClient({directory,projectName,files,release:plan.targetRelease});
    const [sourceConfig,targetConfig]=await Promise.all([deps.composeConfiguration(source),deps.composeConfiguration(target)]);
    if(!isDeepStrictEqual(topology(sourceConfig),topology(targetConfig))){throw new Error('Обновление меняет настройки, секреты или тома; нужна отдельная процедура');}
    const [sourceImages,targetImages,postgres]=await Promise.all([deps.serviceImageIds(sourceConfig),deps.serviceImageIds(targetConfig),deps.docker(['image','inspect',sourceConfig.services.postgres.image])]);
    if(!sameImages(sourceImages,plan.sourceImages)||!sameImages(targetImages,plan.targetImages)||JSON.parse(postgres)[0]?.Id!==plan.postgresImage){throw new Error('Локальные образы расходятся с планом выпуска');}
    await assertLive(source,plan.sourceImages,plan.postgresImage,deps);
    const pg=(await deps.containers(source)).find(item=>item.Config?.Labels?.['com.docker.compose.service']==='postgres');
    const sql="SELECT coalesce(json_agg(json_build_object('version',version,'name',name,'checksum',checksum) ORDER BY version),'[]'::json) FROM catalog_schema_migrations;";
    const applied=JSON.parse(await deps.docker(['exec','-i',pg.Id,'psql','-X','-U','nc_owner','-d','catalog','-v','ON_ERROR_STOP=1','-At'],{input:sql}));
    assertMigrationPrefix(applied,plan.catalogMigrations);
    return {ok:true,dryRun:true,planId:plan.id,sourceRelease:plan.sourceRelease,targetRelease:plan.targetRelease,envSha256:sha(env),rollback:plan.rollback,hasCapacityCollector:!!targetConfig.services['capacity-collector'],hasModelBundle:!!targetConfig.services['model-volume-init']};
}

/** Одна квитанция не допускает повтор миграций после успеха или неопределённого прерывания. */
export async function updateProduction(options,injected={}){
    const deps={...adapters,...injected};const {directory,projectName,files=[],execute=false}=options;
    if(!projectName){throw new Error('Укажите явное имя Compose-проекта');}
    const plan=validateUpdatePlan(options.plan);
    if(!execute){return preflightUpdate(options,deps);}
    if(!options.backupDestination){throw new Error('Укажите новый каталог предварительной копии');}
    await privateFolder(directory);
    const folder=path.join(directory,'updates');
    try{await privateFolder(folder,{create:true});}catch(error){if(error.code!=='EEXIST'){throw error;}await privateFolder(folder);}
    const filename=path.join(folder,plan.id+'.json');const planHash=sha(JSON.stringify(plan));
    let existing;
    try{existing=JSON.parse(await privateFile(filename));}catch(error){if(error.code!=='ENOENT'){throw error;}}
    if(existing){
        if(existing.planSha256!==planHash||existing.projectName!==projectName){throw new Error('Идентификатор операции уже связан с другим планом');}
        if(existing.state!=='completed'){throw new Error('Операция прервана или завершилась ошибкой: повтор запрещён; проверьте квитанцию и восстановление');}
        if(sha(await privateFile(path.join(directory,'.env')))!==existing.targetEnvSha256){throw new Error('Настройки после обновления изменились');}
        const target=deps.composeClient({directory,projectName,files});await assertLive(target,plan.targetImages,plan.postgresImage,deps);
        return {...existing,repeated:true};
    }
    const checked=await preflightUpdate(options,deps);const before=await privateFile(path.join(directory,'.env'));
    const journal={format:'neurocenter-update-receipt-v1',planId:plan.id,planSha256:planHash,projectName,state:'planned',createdAt:new Date().toISOString(),
        sourceRelease:plan.sourceRelease,targetRelease:plan.targetRelease,rollback:plan.rollback,envSha256:checked.envSha256};
    // wx разрешает только одному процессу владеть этой операцией.
    await writeFile(filename,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
    const save=async state=>{journal.state=state;await atomicWrite(filename,JSON.stringify(journal,null,2)+'\n');};
    const pinnedFile=path.join(folder,plan.id+'.compose.json');
    const pinned={services:Object.fromEntries([...applicationServices,'database-init','bootstrap-admin',...(checked.hasCapacityCollector?['capacity-collector']:[]),...(checked.hasModelBundle?['model-volume-init']:[])].map(service=>[service,{image:plan.targetImages[applicationServices.includes(service)?service:'catalog-service']}]))};
    let targetStarted=false;let failureRecorded=false;
    const recordFailure=async cause=>{
        failureRecorded=true;journal.failurePhase=journal.state;journal.failedAt=new Date().toISOString();
        try{await save('failed');}
        catch(error){if(cause?.retainMaintenanceLock===true){error.retainMaintenanceLock=true;}throw error;}
    };
    const target=deps.composeClient({directory,projectName,files:[...files,pinnedFile],release:plan.targetRelease});
    try{
        await writeFile(path.join(folder,plan.id+'.env.before'),before,{flag:'wx',mode:0o600,flush:true});
        await writeFile(pinnedFile,JSON.stringify(pinned,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
        return await deps.withBackup({directory,projectName,files,destination:options.backupDestination,offline:true,maxPauseMs:plan.maxPauseMs,progress:options.progress}, {
            beforePause:async()=>{
                await preflightUpdate(options,deps);
                if(sha(await privateFile(path.join(directory,'.env')))!==journal.envSha256){throw new Error('Настройки изменены после preflight');}
                // Большие архивы загружаются до остановки приложений; БД каталога ещё не меняется.
                journal.catalogDownload=await deps.runCatalogSync(target,{downloadOnly:true});
                if(checked.hasModelBundle){journal.modelDownload=await deps.runModelBundleSync(target,{downloadOnly:true});}
            },
            afterBackup:async(receipt,{remainingMs})=>{
                try{
                    journal.backup=receipt;await save('backed-up');
                    if(sha(await privateFile(path.join(directory,'.env')))!==journal.envSha256){throw new Error('Настройки изменены во время копирования');}
                    await save('applying');targetStarted=true;
                    journal.catalog=await deps.runCatalogSync(target,{timeout:remainingMs()});
                    if(checked.hasModelBundle){journal.models=await deps.runModelBundleSync(target,{timeout:remainingMs()});}
                    await target.run(['up','-d','--no-build','--pull','never','--wait',...applicationServices,...(checked.hasCapacityCollector?['capacity-collector']:[])],{timeout:remainingMs()});
                    await assertLive(target,plan.targetImages,plan.postgresImage,deps);remainingMs();
                    const current=await privateFile(path.join(directory,'.env'));
                    if(sha(current)!==journal.envSha256){throw new Error('Конфликт сохранения production-конфига');}
                    const after=current.replace(/^NEUROCENTER_RELEASE=.*$/m,"NEUROCENTER_RELEASE='"+plan.targetRelease+"'");
                    await atomicWrite(path.join(directory,'.env'),after);
                    journal.targetEnvSha256=sha(after);journal.completedAt=new Date().toISOString();await save('completed');
                    return {...journal,repeated:false};
                }catch(error){
                    // Остановка и квитанция остаются под общей daemon-блокировкой.
                    if(targetStarted){try{await target.run(['stop','--timeout','45',...applicationServices]);}catch{journal.stopFailed=true;}}
                    await recordFailure(error);throw error;
                }
            },
        });
    }catch(error){
        if(!failureRecorded&&journal.state!=='completed'){await recordFailure(error);}
        throw error;
    }
}

async function main(){
    process.umask(0o077);const args=process.argv.slice(2);const mode=args.shift();
    if(!['preflight','apply'].includes(mode)){throw new Error('Команды: preflight | apply --directory <конфиг> --project-name <стек> --plan <json> --rehearsal <json> [--backup-destination <новая папка>]');}
    const options={files:[],execute:mode==='apply',progress:message=>console.error(message)};
    const names={'--directory':'directory','--project-name':'projectName','--plan':'planFile','--rehearsal':'rehearsalFile','--backup-destination':'backupDestination','--compose-file':'files'};
    for(let i=0;i<args.length;i++){const key=names[args[i]];if(!key||!args[i+1]||args[i+1].startsWith('--')){throw new Error('Незаполненный параметр '+args[i]);}const value=args[++i];if(key==='files'){options.files.push(value);}else{options[key]=value;}}
    if(!options.directory||!options.projectName||!options.planFile||!options.rehearsalFile){throw new Error('Укажите directory, project-name, plan и rehearsal');}
    options.directory=path.resolve(options.directory);options.plan=JSON.parse(await privateFile(path.resolve(options.planFile)));
    console.log(JSON.stringify(await updateProduction(options),null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    void main().catch(async error=>{console.error(error.message);const i=process.argv.indexOf('--directory');const directory=path.resolve(i<0?repositoryRoot:process.argv[i+1]||'.');const diagnostic=await saveDiagnostic(error,directory).catch(()=>undefined);if(diagnostic){console.error('Закрытый технический журнал: '+diagnostic);}process.exitCode=1;});
}
