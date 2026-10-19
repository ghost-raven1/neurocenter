#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { composeClient, composeConfiguration, docker, maintenanceLock, repositoryRoot, saveDiagnostic } from './compose-client.mjs';

export const bundledCatalogManifest = '/tools/scripts/catalog-plugins/catalog-release.json';

export function parseCatalogSyncArguments(args) {
    const options = { directory: path.join(repositoryRoot, 'deploy/production/local'), projectName: 'neurocenter-production', dryRun: false };
    const fields = { '--directory': 'directory', '--project-name': 'projectName' }, seen = new Set();
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (seen.has(argument)) { throw new Error('Параметр повторён.'); }
        seen.add(argument);
        if (argument === '--dry-run') { options.dryRun = true; continue; }
        const field = fields[argument];
        if (!field || !args[index + 1] || args[index + 1].startsWith('--')) { throw new Error('Параметры: --directory <production-конфиг> --project-name <стек> [--dry-run].'); }
        options[field] = args[++index];
    }
    return options;
}

/** После таймаута Docker CLI сам контейнер ещё может работать: удаляем только свой ID с меткой. */
async function stopCatalogSync(name, token, runDocker) {
    const owned = async () => {
        const output = await runDocker(['ps', '--all', '--no-trunc', '--filter', `name=^/${name}$`,
            '--filter', `label=neurocenter.catalog-sync=${token}`, '--format', '{{.ID}}'], { timeout: 60000 });
        if (!output.trim()) { return ''; }
        if (!/^[a-f0-9]{64}$/.test(output.trim())) { throw new Error('Не подтверждён контейнер синхронизации.'); }
        return output.trim();
    };
    const id = await owned();
    if (!id) { return; }
    try { await runDocker(['rm', '--force', id], { timeout: 60000 }); }
    catch (error) { if (await owned()) { throw error; } }
    if (await owned()) { throw new Error('Контейнер синхронизации продолжает работать.'); }
}

/** В setup/update блокировку уже держит вызывающий сценарий; вложенная блокировка не нужна. */
export async function runCatalogSync(client, { dryRun = false, downloadOnly = false, timeout } = {}, injected = {}) {
    if (dryRun && downloadOnly) { throw new Error('Проверка манифеста не совмещается с загрузкой архивов.'); }
    const deps = { docker, uuid: randomUUID, ...injected };
    const token = deps.uuid(), name = 'neurocenter-catalog-sync-' + token;
    try {
        const output = await client.run(['run', '--rm', '--no-deps', '-T', '--pull', 'never', '--name', name,
            '--label', 'neurocenter.catalog-sync=' + token, 'catalog-service',
            'node', 'dist/builtin-catalog/sync.cli.js', bundledCatalogManifest,
            ...(dryRun ? ['--dry-run'] : downloadOnly ? ['--download-only'] : [])],
        { ...(timeout === undefined ? {} : { timeout }) });
        const result = JSON.parse(output);
        if (result?.ok !== true || result.dryRun !== dryRun || (downloadOnly
            ? result.downloadOnly !== true || !Number.isSafeInteger(result.artifacts) || result.artifacts < 0
            : !Array.isArray(result.tools))) { throw new Error('Синхронизация каталога не подтвердила результат.'); }
        return result;
    } catch (error) {
        try { await stopCatalogSync(name, token, deps.docker); }
        catch {
            const cleanupError = new Error('Не подтверждена остановка контейнера синхронизации. Блокировка обслуживания сохранена; проверьте контейнер ' + name + '.');
            cleanupError.retainMaintenanceLock = true;
            throw cleanupError;
        }
        throw error;
    }
}

/** Синхронизирует каталог выбранного стека под общей с backup/update блокировкой. */
export async function syncProductionCatalog(options, injected = {}) {
    const deps = { composeClient, composeConfiguration, maintenanceLock, saveDiagnostic, docker, ...injected };
    const directory = path.resolve(options.directory);
    const client = deps.composeClient({ directory, projectName: options.projectName });
    const config = await deps.composeConfiguration(client);
    try { return await deps.maintenanceLock(client, config.services['catalog-service'].image, 'catalog-sync',
        () => runCatalogSync(client, { dryRun: options.dryRun }, deps)); }
    catch (error) { await deps.saveDiagnostic(error, directory); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.umask(0o077);
    Promise.resolve().then(() => syncProductionCatalog(parseCatalogSyncArguments(process.argv.slice(2))))
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error(error instanceof Error ? error.message : 'Каталог не синхронизирован.'); process.exitCode = 1; });
}
