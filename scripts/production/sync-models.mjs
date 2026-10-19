import { randomUUID } from 'node:crypto';
import { docker } from './compose-client.mjs';
import { stopOwnedSyncContainer } from './owned-sync-container.mjs';
import {repositoryRoot} from './compose-client.mjs';
import {assetEnvironment} from '../assets/environment.mjs';
import {assetDirectories} from '../assets/supply.mjs';
import {safeDirectory} from '../models/bundle-files.mjs';

export const modelBundleCli = '/tools/scripts/models/bundle-cli.mjs';

/** Host-кэш монтируется только для чтения; данные именованного production-тома остаются на месте. */
export async function prefetchedModelDirectory() {
    const directory=assetDirectories({root:repositoryRoot,environment:await assetEnvironment(repositoryRoot)}).models;
    try {await safeDirectory(directory);return directory;} catch(error) {if(error.code==='ENOENT')return null;throw error;}
}

/** Большие веса готовятся до паузы; активация закреплённых файлов завершается до запуска runtime. */
export async function runModelBundleSync(client, { downloadOnly = false, timeout = 2 * 60 * 60 * 1000 } = {}, injected = {}) {
    const deps = { docker, uuid: randomUUID, prefetchedModelDirectory, ...injected };
    const source=await deps.prefetchedModelDirectory();
    if(source&&(typeof source!=='string'||!source.startsWith('/')||source.includes(':')))throw new Error('Для предзагрузки моделей нужен абсолютный host-путь без двоеточия.');
    const token = deps.uuid(), name = 'neurocenter-model-bundle-' + token;
    try {
        const output = await client.run(['run', '--rm', '--no-deps', '-T', '--pull', 'never', '--name', name,
            '--label', 'neurocenter.model-bundle=' + token,...(source?['--volume',`${source}:/prefetch:ro`]:[]),'model-volume-init',
            'node', modelBundleCli, '--directory', '/models',...(source?['--source-directory','/prefetch']:[]), ...(downloadOnly ? ['--download-only'] : [])], { timeout });
        const result = JSON.parse(output);
        if (result?.ok !== true || result.downloadOnly !== downloadOnly || result.verifyOnly !== false
            || !Number.isSafeInteger(result.models) || result.models < 1 || !Number.isSafeInteger(result.files) || result.files < 1
            || !Number.isSafeInteger(result.bytes) || result.bytes < 1) {
            throw new Error('Подготовка комплекта моделей не подтвердила результат.');
        }
        return result;
    } catch (error) {
        try { await stopOwnedSyncContainer(name, 'neurocenter.model-bundle', token, deps.docker); }
        catch {
            const cleanupError = new Error('Не подтверждена остановка контейнера подготовки моделей. Блокировка обслуживания сохранена; проверьте контейнер ' + name + '.');
            cleanupError.retainMaintenanceLock = true;
            throw cleanupError;
        }
        throw error;
    }
}
