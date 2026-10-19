import { randomUUID } from 'node:crypto';
import { docker } from './compose-client.mjs';
import { stopOwnedSyncContainer } from './owned-sync-container.mjs';

export const modelBundleCli = '/tools/scripts/models/bundle-cli.mjs';

/** Большие веса готовятся до паузы; активация закреплённых файлов завершается до запуска runtime. */
export async function runModelBundleSync(client, { downloadOnly = false, timeout = 2 * 60 * 60 * 1000 } = {}, injected = {}) {
    const deps = { docker, uuid: randomUUID, ...injected };
    const token = deps.uuid(), name = 'neurocenter-model-bundle-' + token;
    try {
        const output = await client.run(['run', '--rm', '--no-deps', '-T', '--pull', 'never', '--name', name,
            '--label', 'neurocenter.model-bundle=' + token, 'model-volume-init',
            'node', modelBundleCli, '--directory', '/models', ...(downloadOnly ? ['--download-only'] : [])], { timeout });
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
