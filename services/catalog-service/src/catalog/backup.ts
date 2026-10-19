import {link,lstat,readdir,rm,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {backupDirectory,backupError,backupFailure,backupPolicy,BACKUP_OPERATION_MS} from '../backups/backup-policy';
import {backupDirectories,backupFreeSpace,backupLock,backupUsage,BackupBudget,syncBackupDirectory} from '../backups/backup-storage';
import {parsePgUrl,runPgDump} from '../backups/pg-dump';
export {parsePgUrl,type IPgLocation} from '../backups/pg-dump';

export interface IBackupFile {label:string;file:string;sizeBytes:number;method:'pg_dump';}
export interface IBackupRunResult {directory:string;backupAt:string;files:IBackupFile[];errors:string[];warnings?:string[];}
interface IBackupOptions {rootDirectory?:string;confirm?:(result:IBackupRunResult)=>Promise<void>;afterPrune?:(files:string[])=>Promise<void>;}
const active=new Map<AbortController,Promise<void>>();let closing=false;

/** SIGTERM прерывает поток и ждёт cleanup, прежде чем каталог закроет своё подключение. */
export async function stopBackups():Promise<void> {
    closing=true;
    for(const controller of active.keys()){controller.abort(backupFailure('BACKUP_STOPPED','Сервер останавливается. Предыдущие копии сохранены. Обновите список после подключения.',503));}
    await Promise.allSettled(active.values());
}

/** Удаляются только файлы нашего формата и только после подтверждения новой копии. */
async function pruneDumps(directory:string,label:string,signal:AbortSignal,protectedFiles:Set<string>):Promise<{warnings:string[];removed:string[]}> {
    const pattern=new RegExp('^'+label+'-[0-9]{8}-[0-9]{9}-[a-f0-9-]{36}\\.dump$');
    const warnings:string[]=[];const removed:string[]=[];let entries:string[];
    try{entries=(await readdir(directory)).filter(name=>pattern.test(name)).sort();}
    catch{return {removed,warnings:['Новая копия создана, но список старых копий прочитать не удалось. Администратору нужно проверить хранилище.']};}
    for(const name of entries.filter(name=>!protectedFiles.has(path.join(directory,name))).slice(0,Math.max(0,entries.length-5))){
        if(signal.aborted){warnings.push('Новая копия создана, но очистка старых прервана. Администратору нужно проверить хранилище.');break;}
        try{const filename=path.join(directory,name);const info=await lstat(filename);if(!info.isFile()||info.nlink!==1){throw new Error('Нестандартный файл');}await unlink(filename);removed.push(filename);}
        catch{warnings.push('Новая копия создана, но одну из старых удалить не удалось. Администратору нужно проверить хранилище.');}
    }
    return {removed,warnings:[...new Set(warnings)]};
}

async function untilAbort(action:()=>Promise<void>,signal:AbortSignal):Promise<void> {
    signal.throwIfAborted();let aborted!:()=>void;
    try{const cancelled=new Promise<never>((_,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});});await Promise.race([Promise.resolve().then(action),cancelled]);}
    finally{signal.removeEventListener('abort',aborted);}
}

/** Общая блокировка и бюджет охватывают системные и проектные копии, включая подтверждение БД. */
export async function runAllBackups(labels:Record<string,string>,backupDir?:string,options:IBackupOptions={}):Promise<IBackupRunResult> {
    const policy=backupPolicy();const entries=Object.entries(labels);
    if(!entries.length||entries.some(([label])=>! /^[a-z][a-z0-9_-]{0,31}$/.test(label))){throw new Error('Некорректные имена баз для копирования');}
    const locations=entries.map(([label,url])=>({label,location:parsePgUrl(url)}));
    if(closing){throw backupFailure('BACKUP_STOPPED','Сервер останавливается. Повторите действие после подключения.',503);}
    let release:(()=>Promise<void>)|undefined;let timer:NodeJS.Timeout|undefined;
    const controller=new AbortController();let finish!:()=>void;const completed=new Promise<void>(resolve=>finish=resolve);
    const temporary:string[]=[];const published:string[]=[];let confirmed=false;
    try{
        const directory=path.resolve(backupDir||backupDirectory());
        const paths=await backupDirectories(options.rootDirectory||directory,directory);
        release=await backupLock(paths.root);
        if(closing){throw backupFailure('BACKUP_STOPPED','Сервер останавливается. Повторите действие после подключения.',503);}
        active.set(controller,completed);
        timer=setTimeout(()=>controller.abort(backupFailure('BACKUP_TIMEOUT','Создание копии не уложилось в отведённое время. Предыдущие копии сохранены. Для большой базы используйте операторское резервирование.',503)),BACKUP_OPERATION_MS);timer.unref();
        const budget=new BackupBudget(paths.directory,policy,await backupUsage(paths.root,controller.signal));
        await backupFreeSpace(paths.directory,policy.minFreeBytes);
        const stamp=new Date().toISOString().replace(/[-:.]/g,'').replace('T','-').replace('Z','')+'-'+randomUUID();
        const result:IBackupRunResult={directory:paths.directory,backupAt:new Date().toISOString(),files:[],errors:[]};
        for(const {label,location} of locations){
            controller.signal.throwIfAborted();const final=path.join(paths.directory,label+'-'+stamp+'.dump');const partial=final+'.partial';
            const sizeBytes=await runPgDump(location,partial,budget,controller.signal);temporary.push(partial);result.files.push({label,file:final,sizeBytes,method:'pg_dump'});
        }
        controller.signal.throwIfAborted();
        // link не заменяет уже существующее имя; до этого все файлы оставались private partial.
        for(let i=0;i<result.files.length;i++){await link(temporary[i],result.files[i].file);published.push(result.files[i].file);await unlink(temporary[i]);}
        await syncBackupDirectory(paths.directory);controller.signal.throwIfAborted();
        if(options.confirm){
            // После отправки записи в БД результат может быть неизвестен: файлы сохраняются для проверки.
            confirmed=true;
            try{await untilAbort(()=>options.confirm!(result),controller.signal);}
            catch{throw backupFailure('BACKUP_CONFIRMATION_FAILED','Файл копии сохранён, но каталог не подтвердил запись. Обновите список и обратитесь к администратору перед повтором. Предыдущие копии сохранены.',503);}
        }
        confirmed=true;
        const pruned=await Promise.all(locations.map(({label})=>pruneDumps(paths.directory,label,controller.signal,new Set(published))));const warnings=pruned.flatMap(item=>item.warnings);
        const removed=pruned.flatMap(item=>item.removed);
        if(options.afterPrune&&removed.length){try{await untilAbort(()=>options.afterPrune!(removed),controller.signal);}catch{warnings.push('Копия создана, но записи удалённых файлов не обновились. Администратору нужно проверить каталог копий.');}}
        if(warnings.length){result.warnings=[...new Set(warnings)];}
        result.backupAt=new Date().toISOString();return result;
    }catch(error){
        if(!confirmed){await Promise.all(published.map(file=>rm(file,{force:true})));}
        throw backupError(error);
    }finally{
        if(timer){clearTimeout(timer);}
        try{await Promise.all(temporary.map(file=>rm(file,{force:true})));}
        finally{try{await release?.();}finally{active.delete(controller);finish();}}
    }
}
