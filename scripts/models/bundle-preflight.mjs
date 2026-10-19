import {constants} from 'node:fs';
import {open,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {safeDirectory} from './bundle-files.mjs';

/** Проба создаётся исключительно в нужном каталоге и удаляется, готовые файлы не меняются. */
export async function preflightModelDirectories(directory,parents) {
    for(const relative of new Set(parents)) {
        const parent=await safeDirectory(directory,relative,true);
        const probe=path.join(parent,`.neurocenter-write-${randomUUID()}`);
        const handle=await open(probe,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try {await handle.close();}
        finally {await unlink(probe);}
    }
}

/** До загрузки проверяет запись в родители отсутствующих файлов проверенной описи. */
export const preflightModelTargets=(directory,files)=>preflightModelDirectories(directory,files.map(file=>path.posix.dirname(file.path)));
