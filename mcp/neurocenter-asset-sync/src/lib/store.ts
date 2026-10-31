import fs from 'node:fs/promises';
import path from 'node:path';

import { loadRagConfig, type IRagConfigCore } from './config.js';
import { safeTarget } from '../bridge/workspace-paths.js';
import { recoverRagRestore } from '../features/rag-index/restore-recovery.js';

export interface IStoreLocateResult {
    root: string;
    configPath: string | null;
    config: IRagConfigCore | null;
    storePath: string | null;
}

export const RAG_CONFIG_PATHS = ['opencode-rag.json', '.opencode/opencode-rag.json', '.opencode/rag.json'];
const DEFAULT_STORE_SUBPATH = path.join('.opencode', 'rag_db');

async function statSafe(p: string): Promise<{ file: boolean; dir: boolean } | null> {
    try {
        const st = await fs.stat(p);
        return { file: st.isFile(), dir: st.isDirectory() };
    } catch {
        return null;
    }
}

/**
 * Локализует `opencode-rag.json` и путь к векторному хранилищу ТОЛЬКО в точке
 * входа (прямая проверка, без «подъёма» по дереву вверх — защита от того, что
 * restore направят на чужой каталог выше по иерархии).
 *
 * @param hint - явный путь к store/конфигу/корню (или CWD, если не задан).
 * @param cwd - базовая директория по умолчанию.
 * @returns локализация конфига и хранилища.
 */
export async function locateStore(
    hint: string | undefined,
    cwd: string,
    allowMissing = false,
): Promise<IStoreLocateResult> {
    const entry = typeof hint === 'string' && hint.trim() !== '' ? path.resolve(cwd, hint) : cwd;

    let baseDir = entry;
    const entryStat = await statSafe(entry);
    if (entryStat) {
        baseDir = entryStat.dir ? entry : path.dirname(entry);
    }
    await recoverRagRestore(baseDir);

    // Приоритет совпадает с native OpenCodeRAG; вверх по дереву не поднимаемся.
    let configPath: string | null = null;
    for (const relative of RAG_CONFIG_PATHS) {
        const candidate = path.join(baseDir, relative);
        if ((await statSafe(candidate))?.file) {
            configPath = await safeTarget(baseDir, relative);
            break;
        }
    }
    const config = configPath ? await loadRagConfig(configPath, baseDir) : null;
    if (configPath && !config) {
        throw new Error('Конфигурация OpenCodeRAG повреждена. Исправьте её перед передачей индекса.');
    }

    // Store: сначала из конфига, затем дефолтный .opencode/rag_db в корне,
    // либо сама точка входа (если указали каталог store напрямую).
    let storePath: string | null = config?.vectorStorePath ?? null;
    if (!storePath) {
        const defaultCandidate = path.join(baseDir, DEFAULT_STORE_SUBPATH);
        const defaultStat = await statSafe(defaultCandidate);
        if (defaultStat?.dir || allowMissing) {
            storePath = defaultCandidate;
        } else if (entryStat?.dir && baseDir === entry && path.basename(baseDir) === 'rag_db') {
            storePath = baseDir;
        }
    }

    const root = baseDir;

    return { root, configPath, config, storePath };
}
