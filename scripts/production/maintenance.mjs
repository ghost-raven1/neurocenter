#!/usr/bin/env node
import {readFile,writeFile,mkdir,rename,lstat,readdir,rm,open,realpath} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {composeClient,containers,docker,repositoryRoot,saveDiagnostic} from './compose-client.mjs';
import {backupProduction} from './recovery.mjs';
import {verifyBackup} from './recovery-manifest.mjs';
import {uploadExternalBackup,externalBackupConfiguration} from './external-backup.mjs';
import {reserveRestoreSource} from './restore-reservations.mjs';
import {validateMaintenancePolicy,dueMaintenanceRun} from '../../services/shared/maintenance-policy.cjs';

const quote=value=>"'"+String(value).replace(/'/g,"''")+"'";
const hash=value=>createHash('sha256').update(value).digest('hex');
const safeError=(phase,error)=>error?.code==='MAINTENANCE_PAUSE_EXCEEDED'?'PAUSE_EXCEEDED':error?.code==='CONFIG_CHANGED'?'CONFIG_CHANGED':phase==='backup'?'BACKUP_FAILED':'EXTERNAL_FAILED';

/** Публичная идентичность места хранения не содержит ключей и меняется вместе с endpoint/bucket. */
export function externalStorageBinding(config){
    if(['endpoint','bucket','region','storageId'].some(key=>typeof config?.[key]!=='string'||!config[key])){throw new Error('Неполная идентичность внешнего хранилища');}
    return hash(JSON.stringify(Object.fromEntries(['endpoint','bucket','region','storageId'].map(key=>[key,config[key]]))));
}
function validReceipt(receipt,ledger,storageId){
    const created=Date.parse(receipt?.createdAt),verified=Date.parse(receipt?.verifiedAt);
    return receipt?.ok===true&&receipt.verification==='sha256-readback'&&receipt.manifestSha256===ledger.sha256&&receipt.backupId===ledger.backupId
        &&typeof receipt.storageId==='string'&&receipt.storageId===storageId&&receipt.independence==='operator-declared'
        &&receipt.createdAt===ledger.createdAt&&Number.isFinite(created)&&Number.isFinite(verified)&&verified>=created;
}

/** Один слот нельзя выполнить одновременно или повторить после подтверждённого успеха. */
export async function maintenanceTick({load,claim,finish,fail,readLedger,writeLedger,backup,verify,upload,resolveStorage=externalBackupConfiguration,prune=async()=>{},now=()=>new Date()}){
    const settings=await load();const policy=validateMaintenancePolicy(settings.policy);const due=dueMaintenanceRun(policy,now());
    if(!due){return {ok:true,skipped:true,reason:policy.enabled?'OUTSIDE_WINDOW':'DISABLED'};}
    const runId=randomUUID();if(!await claim({runId,slot:due.slot,revision:settings.revision})){return {ok:true,skipped:true,reason:'ALREADY_CLAIMED_OR_RETRY_DELAY'};}
    let phase='external';
    try{
        const config=await resolveStorage();const storageBinding=externalStorageBinding(config);
        phase='backup';
        let ledger=await readLedger(due.slot);
        if(ledger){
            const manifest=await verify(ledger.source,ledger.sha256);
            if(manifest?.createdAt&&manifest.createdAt!==ledger.createdAt){throw new Error('Точка локального комплекта расходится с квитанцией');}
        }else{
            const beforePause=async()=>{
                const latest=await load();const current=dueMaintenanceRun(validateMaintenancePolicy(latest.policy),now());
                if(latest.revision!==settings.revision||!current||current.slot!==due.slot){const error=new Error('Политика или допустимое окно изменились до остановки');error.code='CONFIG_CHANGED';throw error;}
            };
            const result=await backup({maxPauseMs:policy.maxPauseMinutes*60000,slot:due.slot,beforePause});
            ledger={source:result.destination,sha256:result.sha256,backupId:'nc-'+hash(due.slot).slice(0,24)+'-'+runId,createdAt:result.createdAt,slot:due.slot,storageBinding};
            await writeLedger(due.slot,ledger);
        }
        phase='external';
        if(ledger.storageBinding!==storageBinding){
            // Старую квитанцию нельзя подтвердить или использовать для очистки после смены места хранения.
            ledger={...ledger,storageBinding};delete ledger.receipt;await writeLedger(due.slot,ledger);
        }
        const receipt=ledger.receipt||await upload({source:ledger.source,expectedHash:ledger.sha256,backupId:ledger.backupId,config});
        if(!validReceipt(receipt,ledger,config.storageId)){throw new Error('Неполная квитанция внешней проверки');}
        ledger.receipt=receipt;await writeLedger(due.slot,ledger);
        await finish(runId,receipt);
        let retentionWarning=false;try{await prune(policy.localCopies,storageBinding);}catch{retentionWarning=true;}
        return {ok:true,runId,backupId:receipt.backupId,verifiedAt:receipt.verifiedAt,retentionWarning};
    }catch(error){await fail(runId,safeError(phase,error)).catch(()=>undefined);throw error;}
}

async function privateDirectory(directory){await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077){throw new Error('Нужен обычный закрытый каталог runner с правами 700');}return realpath(directory);}
async function savePrivate(filename,value){
    try{const info=await lstat(filename);if(!info.isFile()||info.nlink!==1||info.isSymbolicLink()){throw new Error('Некорректная квитанция runner');}}catch(error){if(error.code!=='ENOENT'){throw error;}}
    const temporary=filename+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx',flush:true});await rename(temporary,filename);const handle=await open(path.dirname(filename),'r');try{await handle.sync();}finally{await handle.close();}}finally{await rm(temporary,{force:true});}
}
/** Ledger содержит только созданные runner комплекты; чужие каталоги никогда не очищаются. */
export async function runnerLedger(directory,backupRoot){
    const ledgers=await privateDirectory(path.join(directory,'maintenance-runner'));backupRoot=await privateDirectory(backupRoot);
    const filename=slot=>path.join(ledgers,hash(slot)+'.json');
    const read=async slot=>{try{const file=filename(slot);const info=await lstat(file);if(!info.isFile()||info.nlink!==1||info.size>65536||info.mode&0o077){throw new Error('Некорректная квитанция runner');}const value=JSON.parse(await readFile(file,'utf8'));if(value.slot!==slot||path.dirname(value.source)!==backupRoot||!/^nc-[a-f0-9-]+$/.test(path.basename(value.source))){throw new Error('Квитанция относится к другому каталогу копий');}return value;}catch(error){if(error.code==='ENOENT'){return null;}throw error;}};
    return {read,write:(slot,value)=>savePrivate(filename(slot),value),backupRoot,
        prune:async(keep,storageBinding)=>{
            if(!Number.isSafeInteger(keep)||keep<1||keep>100||!/^[a-f0-9]{64}$/.test(storageBinding||'')){throw new Error('Нужны retention и текущее место хранения');}
            const verified=[];
            for(const name of await readdir(ledgers)){
                if(!/^[a-f0-9]{64}\.json$/.test(name)){continue;}
                const file=path.join(ledgers,name);const info=await lstat(file);if(!info.isFile()||info.nlink!==1||info.size>65536||info.mode&0o077){continue;}
                const value=JSON.parse(await readFile(file,'utf8'));
                if(value.storageBinding===storageBinding&&typeof value.slot==='string'&&name===hash(value.slot)+'.json'&&validReceipt(value.receipt,value,value.receipt?.storageId)&&path.dirname(value.source)===backupRoot&&/^nc-[a-f0-9-]+$/.test(path.basename(value.source))){verified.push({file,value});}
            }
            verified.sort((a,b)=>Date.parse(b.value.createdAt)-Date.parse(a.value.createdAt));
            for(const {file,value} of verified.slice(keep)){
                let info;try{info=await lstat(value.source);}catch(error){if(error.code==='ENOENT'){continue;}throw error;}
                if(!info.isDirectory()||info.isSymbolicLink()){throw new Error('Комплект для очистки изменён');}
                const release=await reserveRestoreSource(backupRoot,value.source,'retention-'+randomUUID());
                if(!release)continue;
                try{await verifyBackup(value.source,value.sha256);await rm(value.source,{recursive:true});await rm(file);}
                finally{await release();}
            }
        }};
}

/** Общие SQL-переходы используются операторским runner и изолированной PostgreSQL-приёмкой. */
export function createMaintenanceStore(query){
    const transition=async(runId,state,receipt,errorCode)=>{
        const safe=receipt?{backupId:receipt.backupId,storageId:receipt.storageId,manifestSha256:receipt.manifestSha256,createdAt:receipt.createdAt,verifiedAt:receipt.verifiedAt,verification:receipt.verification,independence:receipt.independence,crossHostRestoreVerified:false}:null;
        const action=state==='succeeded'?'maintenance.external.verified':'maintenance.run.failed';
        const after=safe?quote(JSON.stringify(safe))+'::jsonb':"jsonb_build_object('code',"+quote(errorCode)+')';
        const result=await query(`WITH moved AS (
            UPDATE maintenance_runs SET state=${quote(state)},finished_at=now(),
            receipt=${safe?quote(JSON.stringify(safe))+'::jsonb':'NULL'},error_code=${errorCode?quote(errorCode):'NULL'}
            WHERE id=${quote(runId)}::uuid AND state='running' RETURNING id
        ), audited AS (
            INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state)
            SELECT ${quote(randomUUID())}::uuid,'system:maintenance',${quote(action)},id::text,null,${after} FROM moved RETURNING event_id
        ) SELECT count(*) FROM moved;`);
        return result.trim()==='1';
    };
    return {
        load:async()=>JSON.parse(await query('SELECT row_to_json(s) FROM (SELECT revision,policy FROM maintenance_settings WHERE singleton) s;')),
        claim:async({runId,slot,revision})=>{
            if(!Number.isSafeInteger(revision)||revision<0){throw new Error('Некорректная ревизия политики');}
            const result=await query(`BEGIN; DO $$BEGIN PERFORM pg_advisory_xact_lock(53709168); END$$;
                WITH claimed AS (
                    INSERT INTO maintenance_runs(id,slot,policy_revision,state)
                    SELECT ${quote(runId)}::uuid,${quote(slot)},${revision},'running'
                    WHERE EXISTS(SELECT 1 FROM maintenance_settings WHERE singleton AND revision=${revision})
                    AND NOT EXISTS(SELECT 1 FROM maintenance_runs WHERE state='running' OR (slot=${quote(slot)} AND state='succeeded') OR (slot=${quote(slot)} AND finished_at>now()-interval '5 minutes')) RETURNING id
                ) SELECT coalesce(json_agg(id),'[]'::json) FROM claimed; COMMIT;`);
            const ids=JSON.parse(result.trim());return Array.isArray(ids)&&ids.length===1&&ids[0]===runId;
        },
        finish:async(runId,receipt)=>{if(!await transition(runId,'succeeded',receipt)){throw new Error('Запуск уже завершён: успешная внешняя копия не зафиксирована повторно');}},
        fail:async(runId,code)=>transition(runId,'failed',null,code),
    };
}

/** Только локальный оператор с доступом к Docker может фиксировать результаты полной копии. */
export async function runMaintenance({directory,projectName='neurocenter-production',backupRoot}){
    if(!backupRoot){throw new Error('Укажите --backup-root на отдельном диске вне production-томов');}
    const client=composeClient({directory,projectName});
    const postgres=(await containers(client)).find(item=>item.Config.Labels['com.docker.compose.service']==='postgres');if(!postgres?.State.Running){throw new Error('PostgreSQL не запущен');}
    const query=text=>docker(['exec','-i',postgres.Id,'psql','-X','-qAt','-U','nc_owner','-d','catalog','-v','ON_ERROR_STOP=1'],{input:text});
    const ledger=await runnerLedger(directory,backupRoot);
    return maintenanceTick({
        ...createMaintenanceStore(query),
        readLedger:ledger.read,writeLedger:ledger.write,prune:ledger.prune,
        backup:async({maxPauseMs,beforePause})=>{return backupProduction({directory,projectName,destination:path.join(ledger.backupRoot,'nc-'+randomUUID()),offline:true,maxPauseMs,beforePause,progress:message=>console.error(message)});},
        verify:verifyBackup,upload:uploadExternalBackup,
    });
}
async function main(){
    process.umask(0o077);const args=process.argv.slice(2),values={};if(args.shift()!=='tick'){throw new Error('Команда: tick --directory <production config> --project-name <stack> --backup-root <закрытый каталог>');}
    const names={'--directory':'directory','--project-name':'projectName','--backup-root':'backupRoot'};
    for(let i=0;i<args.length;i+=2){const key=names[args[i]];if(!key||!args[i+1]||values[key]!==undefined){throw new Error('Некорректный параметр runner');}values[key]=args[i+1];}
    values.directory=path.resolve(values.directory||path.join(repositoryRoot,'deploy/production/local'));
    console.log(JSON.stringify(await runMaintenance(values)));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    main().catch(async error=>{
        console.error('Обслуживание не завершено: '+error.message);
        const index=process.argv.indexOf('--directory');
        const directory=path.resolve(index<0?path.join(repositoryRoot,'deploy/production/local'):process.argv[index+1]||'.');
        const diagnostic=await saveDiagnostic(error,directory).catch(()=>undefined);
        if(diagnostic){console.error('Закрытый технический журнал: '+diagnostic);}
        process.exitCode=1;
    });
}
