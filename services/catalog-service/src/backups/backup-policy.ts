import {HttpException} from '@nestjs/common';
import path from 'node:path';
import {CapacityError} from '../../../shared/capacity.cjs';

export interface IBackupPolicy {maxTotalBytes:number;maxFileBytes:number;minFreeBytes:number;}
export const BACKUP_OPERATION_MS=20_000;

/** Ноль не отключает ограничения; весь каталог копий использует один бюджет. */
export function backupPolicy(env:NodeJS.ProcessEnv=process.env):IBackupPolicy {
    const read=(key:string,fallback:number):number=>{
        const raw=env[key];const value=raw===undefined?fallback:Number(raw);
        if(raw!==undefined&&!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(value)||value<=0){throw new Error('Некорректный '+key);}
        return value;
    };
    const policy={maxTotalBytes:read('BACKUP_MAX_TOTAL_BYTES',64*1024**3),maxFileBytes:read('BACKUP_MAX_FILE_BYTES',16*1024**3),minFreeBytes:read('BACKUP_MIN_FREE_BYTES',1024**3)};
    if(policy.maxFileBytes>policy.maxTotalBytes){throw new Error('BACKUP_MAX_FILE_BYTES превышает BACKUP_MAX_TOTAL_BYTES');}
    return policy;
}

export const backupDirectory=():string=>path.resolve(process.env.BACKUP_DIR||'data/backups');

export function backupFailure(code:string,message:string,status=507):HttpException {
    return new HttpException({statusCode:status,code,message},status);
}

/** Не раскрывает пользователю stderr PostgreSQL, пути и реквизиты подключения. */
export function backupError(error:unknown):unknown {
    if(error instanceof HttpException){return error;}
    if(error instanceof CapacityError){return backupFailure(error.code,error.message,error.statusCode);}
    const code=(error as NodeJS.ErrnoException)?.code;
    if(code==='ENOSPC'||code==='EDQUOT'){
        return backupFailure('BACKUP_DISK_FULL','На диске для копий недостаточно места. Предыдущие копии сохранены. Попросите администратора освободить место.');
    }
    return backupFailure('BACKUP_FAILED','Не удалось завершить резервное копирование. Предыдущие копии сохранены. Обновите список перед повтором.',503);
}
