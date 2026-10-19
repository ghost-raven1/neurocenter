import {lstat,mkdir,opendir,open,readFile,realpath,rm,statfs,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {backupFailure,type IBackupPolicy} from './backup-policy';
import {reserveCapacity} from '../../../shared/capacity.cjs';

export const BACKUP_LOCK='.neurocenter-backup.lock';

/** Проверяет каждый подкаталог, не переходя по ссылкам внутри управляемого корня. */
export async function backupDirectories(root:string,directory:string):Promise<{root:string;directory:string}> {
    root=path.resolve(root);directory=path.resolve(directory);
    const relative=path.relative(root,directory);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) {throw new Error('Каталог копии вне управляемого корня');}
    await mkdir(root,{recursive:true,mode:0o700});
    const check=async(filename:string):Promise<void>=>{const info=await lstat(filename);if(!info.isDirectory()||info.isSymbolicLink()){throw new Error('Нужен обычный каталог копий');}};
    await check(root);
    let current=root;
    for(const part of relative.split(path.sep).filter(Boolean)){
        current=path.join(current,part);await mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST'){throw error;}});await check(current);
    }
    return {root:await realpath(root),directory:await realpath(directory)};
}

/** Файловая блокировка действует между процессами; после аварии снимается оператором офлайн. */
export async function backupLock(root:string):Promise<()=>Promise<void>> {
    const directory=path.join(root,BACKUP_LOCK);const owner=randomUUID();
    try{await mkdir(directory,{mode:0o700});}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST'){throw backupFailure('BACKUP_BUSY','Уже выполняется резервное копирование. Дождитесь завершения и обновите список. Если сообщение остаётся после перезапуска, обратитесь к администратору.',409);}throw error;}
    try{await writeFile(path.join(directory,'owner'),owner,{flag:'wx',mode:0o600});}
    catch(error){await rm(directory,{recursive:true,force:true});throw error;}
    // Посторонняя замена lock не даёт удалить чужую блокировку.
    return async()=>{if(await readFile(path.join(directory,'owner'),'utf8')!==owner){throw new Error('Владелец блокировки копии изменён');}await rm(directory,{recursive:true});};
}

/** Считает также старые/неучтённые файлы и partial; квота не уменьшается из-за отсутствия строки БД. */
export async function backupUsage(root:string,signal?:AbortSignal):Promise<number> {
    let bytes=0;let entries=0;
    const walk=async(directory:string,depth:number):Promise<void>=>{
        if(depth>16){throw new Error('Слишком глубокий каталог копий');}
        const stream=await opendir(directory);
        for await(const entry of stream){
            signal?.throwIfAborted();
            if(directory===root&&entry.name===BACKUP_LOCK){continue;}
            if(++entries>100_000){throw new Error('Слишком много файлов копий');}
            const filename=path.join(directory,entry.name);const info=await lstat(filename);
            if(info.isSymbolicLink()||!info.isDirectory()&&(!info.isFile()||info.nlink!==1)){throw new Error('Ссылки и специальные файлы в каталоге копий запрещены');}
            if(info.isDirectory()){await walk(filename,depth+1);}else{bytes+=info.size;if(!Number.isSafeInteger(bytes)){throw new Error('Объём копий требует проверки');}}
        }
    };
    await walk(root,0);return bytes;
}

/** Проверка свободного места не заменяет квоту файловой системы при посторонних писателях. */
export async function backupFreeSpace(directory:string,minimum:number,nextBytes=0):Promise<void> {
    if(nextBytes>0&&process.env.CAPACITY_REQUIRED==='true'){const release=await reserveCapacity({resource:'backups',bytes:nextBytes,path:directory});release();}
    const disk=await statfs(directory,{bigint:true});
    if(disk.bavail*disk.bsize<BigInt(minimum)+BigInt(nextBytes)){
        throw backupFailure('BACKUP_DISK_FULL','Недостаточно свободного места с учётом резерва диска. Предыдущие копии сохранены. Попросите администратора освободить место.');
    }
}

export class BackupBudget {
    constructor(private readonly directory:string,private readonly policy:IBackupPolicy,private usedBytes:number) {
        if(usedBytes>=policy.maxTotalBytes){throw backupFailure('BACKUP_QUOTA_EXCEEDED','Хранилище копий заполнено. Предыдущие копии сохранены. Попросите администратора увеличить лимит или перенести старые копии.');}
    }
    async consume(bytes:number,fileBytes:number):Promise<void> {
        if(fileBytes>this.policy.maxFileBytes||this.usedBytes+bytes>this.policy.maxTotalBytes){
            throw backupFailure('BACKUP_QUOTA_EXCEEDED','Достигнут лимит размера файла или общего хранилища копий. Предыдущие копии сохранены. Попросите администратора увеличить лимит или перенести старые копии.');
        }
        await backupFreeSpace(this.directory,this.policy.minFreeBytes,bytes);this.usedBytes+=bytes;
    }
}

/** Синхронизирует имя после публикации; отказ не объявляется подтверждённой копией. */
export async function syncBackupDirectory(directory:string):Promise<void> {
    const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}
}
