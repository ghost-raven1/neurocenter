#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { nodeRuntime, npmCli } from '../workspace/node-runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = path.join(root, 'services/catalog-service');
export const catalogReleaseManifest = path.join(root, 'scripts/catalog-plugins/catalog-release.json');

export function parseSyncArguments(args) {
    if (args.length > 1 || args.length === 1 && args[0] !== '--dry-run') { throw new Error('Параметры: npm run tools:sync [-- --dry-run].'); }
    return { dryRun: args[0] === '--dry-run' };
}

/** Локальные настройки имеют приоритет над .env, переменные процесса — над обоими файлами. */
export async function catalogSyncEnvironment(environment = process.env) {
    const files = {};
    for (const filename of ['.env', '.env.local']) {
        try { Object.assign(files, parseEnv(await readFile(path.join(root, filename), 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    }
    const env = { ...files, ...environment };
    return { ...env, CATALOG_PG_URL: env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',
        RUNTIME_ARTIFACT_DIR: path.resolve(root, env.RUNTIME_ARTIFACT_DIR || 'data/runtime-artifacts') };
}

function run(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, stdio: 'inherit' });
        child.once('error', () => reject(new Error('Не удалось запустить синхронизацию каталога.')));
        child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(
            signal ? `Синхронизация каталога остановлена: ${signal}.` : `Синхронизация каталога завершилась с кодом ${code}.`)));
    });
}

/** Перед синхронизацией собирает текущий CLI; устаревший dist после git pull не используется. */
export async function syncCatalog(options, injected = {}) {
    const deps = { environment: catalogSyncEnvironment, runtime: nodeRuntime, npm: npmCli, run, ...injected };
    const runtime = deps.runtime(await deps.environment());
    await deps.run(runtime.node, [deps.npm(runtime.env), 'run', 'build'], { cwd: catalog, env: runtime.env });
    await deps.run(runtime.node, [path.join(catalog, 'dist/builtin-catalog/sync.cli.js'), catalogReleaseManifest,
        ...(options.dryRun ? ['--dry-run'] : [])], { cwd: catalog, env: runtime.env });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    Promise.resolve().then(() => syncCatalog(parseSyncArguments(process.argv.slice(2))))
        .catch(error => { console.error(error instanceof Error ? error.message : 'Каталог не синхронизирован.'); process.exitCode = 1; });
}
