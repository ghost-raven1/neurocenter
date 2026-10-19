#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeRuntime, npmCli } from '../workspace/node-runtime.mjs';
import { parseCatalogSyncArguments } from '../production/sync-catalog.mjs';
import { catalogSyncEnvironment } from './sync-environment.mjs';

export { catalogSyncEnvironment } from './sync-environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = path.join(root, 'services/catalog-service');
export const catalogReleaseManifest = path.join(root, 'scripts/catalog-plugins/catalog-release.json');

/** Production явно выбирает существующий Compose-стек; обычный запуск остаётся локальным. */
export function parseSyncArguments(args) {
    if (args.includes('--production')) {
        if (args.filter(argument => argument === '--production').length !== 1) { throw new Error('Параметр --production повторён.'); }
        return { production: true, ...parseCatalogSyncArguments(args.filter(argument => argument !== '--production')) };
    }
    if (args.length > 1 || args.length === 1 && args[0] !== '--dry-run') {
        throw new Error('Параметры: npm run tools:sync [-- --dry-run] или npm run tools:sync -- --production [--directory <конфиг>] [--project-name <стек>] [--dry-run].');
    }
    return { dryRun: args[0] === '--dry-run' };
}

function run(command, args, { label = 'Синхронизация каталога', ...options }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, stdio: 'inherit' });
        child.once('error', () => reject(new Error(`${label}: не удалось запустить команду.`)));
        child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(
            signal ? `${label}: команда остановлена (${signal}).` : `${label}: команда завершилась с кодом ${code}.`)));
    });
}

/** Локально собирает свежий CLI; в production использует образ и хранилище выбранного стека. */
export async function syncCatalog(options, injected = {}) {
    const deps = { environment: catalogSyncEnvironment, runtime: nodeRuntime, npm: npmCli, run, ...injected };
    if (options.production) {
        const runtime = deps.runtime(process.env);
        return deps.run(runtime.node, [path.join(root, 'scripts/production/sync-catalog.mjs'),
            '--directory', options.directory, '--project-name', options.projectName, ...(options.dryRun ? ['--dry-run'] : [])],
        { cwd: root, env: runtime.env, label: 'Синхронизация production-каталога' });
    }
    const runtime = deps.runtime(await deps.environment());
    await deps.run(runtime.node, [deps.npm(runtime.env), 'run', 'build'], { cwd: catalog, env: runtime.env, label: 'Сборка catalog-service' });
    await deps.run(runtime.node, [path.join(catalog, 'dist/builtin-catalog/sync.cli.js'), catalogReleaseManifest,
        ...(options.dryRun ? ['--dry-run'] : [])], { cwd: catalog, env: runtime.env, label: 'Импорт встроенного каталога' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    Promise.resolve().then(async () => {
        const args = process.argv.slice(2), options = parseSyncArguments(args), runtime = nodeRuntime();
        // Старый системный Node должен передать запуск до чтения .env через util.parseEnv.
        if (runtime.node !== process.execPath) {
            return run(runtime.node, [fileURLToPath(import.meta.url), ...args], {
                cwd: root, env: { ...process.env, PATH: runtime.env.PATH }, label: 'Запуск Node.js 24+',
            });
        }
        return syncCatalog(options);
    })
        .catch(error => { console.error(error instanceof Error ? error.message : 'Каталог не синхронизирован.'); process.exitCode = 1; });
}
