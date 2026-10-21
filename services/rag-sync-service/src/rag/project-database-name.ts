import {createHash} from 'node:crypto';

/** Имя вычисляется из постоянного ID; пользовательская строка никогда не становится SQL identifier. */
export function projectDatabaseName(projectId:string):string{return `nc_rag_${createHash('sha256').update(projectId).digest('hex').slice(0,32)}`;}
