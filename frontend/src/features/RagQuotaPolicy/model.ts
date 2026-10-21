export interface IPlatformQuotaPolicy {defaultBytes:number;maximumBytes:number;revision:number;updatedAt:string;updatedBy:string;}
export const MIB=1024**2;

/** Converting an edited MiB value must preserve an exact positive integer number of bytes. */
export function quotaBytes(value:unknown):number {
    const bytes=typeof value==='number'?value*MIB:NaN;
    if(!Number.isSafeInteger(bytes)||bytes<=0)throw new Error('Укажите положительное значение с точностью до байта.');
    return bytes;
}
export function requirePlatformQuota(value:unknown):IPlatformQuotaPolicy {
    const v=value as IPlatformQuotaPolicy|null;
    if(!v||![v.defaultBytes,v.maximumBytes].every(n=>Number.isSafeInteger(n)&&n>0)||v.defaultBytes>v.maximumBytes
        ||!Number.isSafeInteger(v.revision)||v.revision<0||typeof v.updatedBy!=='string'||typeof v.updatedAt!=='string'||!Number.isFinite(Date.parse(v.updatedAt))) {
        throw new Error('Сервер не подтвердил настройки квот.');
    }
    return v;
}
