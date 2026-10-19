import {statfs} from 'node:fs/promises';

export const MIN_BUILD_FREE_BYTES=6n*1024n**3n;

/** Проверяет доступные процессу блоки; зарезервированное место не считается свободным для сборки. */
export function assertBuildSpace(stat) {
    const available=BigInt(stat.bavail)*BigInt(stat.bsize);
    if(available<MIN_BUILD_FREE_BYTES){
        throw new Error(`Для Docker-сборки нужно не менее 6 ГиБ свободного диска; доступно ${(Number(available)/1024**3).toFixed(2)} ГиБ. Освободите место до повторного запуска.`);
    }
}

/** Это предварительный запас на host-файловой системе, а не резервирование диска Docker VM. */
export async function assertBuildDiskSpace(directory) { assertBuildSpace(await statfs(directory,{bigint:true})); }
