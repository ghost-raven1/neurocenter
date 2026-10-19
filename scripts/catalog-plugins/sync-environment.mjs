import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const connectionKeys = ['CATALOG_PG_URL', 'CATALOG_PG_URL_FILE'];

/** Новый источник подключения заменяет также альтернативу из менее приоритетного слоя. */
function mergeEnvironment(target, source) {
    Object.assign(target, source);
    if (source.CATALOG_PG_URL || source.CATALOG_PG_URL_FILE) {
        for (const key of connectionKeys) { if (!source[key]) { delete target[key]; } }
    }
}

/** .env → .env.local → процесс; путь к секрету закрепляется до смены рабочего каталога. */
export async function catalogSyncEnvironment(environment = process.env, { directory = repoRoot } = {}) {
    if (typeof util.parseEnv !== 'function') { throw new Error('Для синхронизации каталога нужен Node.js 24 или новее.'); }
    const root = path.resolve(directory), env = {};
    for (const filename of ['.env', '.env.local']) {
        try { mergeEnvironment(env, util.parseEnv(await readFile(path.join(root, filename), 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    }
    mergeEnvironment(env, environment);
    if (!env.CATALOG_PG_URL && !env.CATALOG_PG_URL_FILE) {
        if (env.NODE_ENV === 'production') { throw new Error('Для production укажите CATALOG_PG_URL или CATALOG_PG_URL_FILE.'); }
        env.CATALOG_PG_URL = 'postgresql://rag:rag@localhost:5432/catalog';
    }
    if (env.CATALOG_PG_URL_FILE) { env.CATALOG_PG_URL_FILE = path.resolve(root, env.CATALOG_PG_URL_FILE); }
    env.RUNTIME_ARTIFACT_DIR = path.resolve(root, env.RUNTIME_ARTIFACT_DIR || 'data/runtime-artifacts');
    return env;
}
