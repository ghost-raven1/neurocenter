import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { tableInfo, type ITableInfo } from '../lib/lancedb.js';
import { errMsg } from '../lib/stdio.js';
import { locateStore } from '../lib/store.js';

export const ragDbInspectInputSchema = z
    .object({
        dbPath: z.string().optional().describe('Явный путь к rag_db (LanceDB).'),
        root: z.string().optional().describe('Корень со .opencode/rag_db / opencode-rag.json.'),
    })
    .strict();

export type TRagDbInspectInput = z.infer<typeof ragDbInspectInputSchema>;

export interface IRagDbFootprint {
    storePath: string | null;
    exists: boolean;
    tableDirs: string[];
    auxFiles: string[];
    dataFilesCount: number | null;
    totalDataBytes: number | null;
    versionCount: number | null;
}

export interface IRagDbInspect {
    exists: boolean;
    footprint: IRagDbFootprint;
    table: ITableInfo | null;
    config: {
        embedding: { provider: string; model: string; baseUrl: string | null } | null;
        retrieval: { topK: number; minScore: number } | null;
    } | null;
    configPath: string | null;
    errors: string[];
}

async function namesOr(dir: string): Promise<string[] | null> {
    try {
        return await fs.readdir(dir);
    } catch {
        return null;
    }
}

async function sumFiles(
    dir: string,
): Promise<{ count: number; bytes: number } | null> {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    let count = 0;
    let bytes = 0;
    for (const e of entries) {
        if (e.isFile()) {
            count += 1;
            try {
                const s = await fs.stat(path.join(dir, e.name));
                bytes += s.size;
            } catch {
                // файл не читается — пропускаем вес.
            }
        }
    }
    return { count, bytes };
}

/**
 * Инспекция rag_db без чтения бинарных таблиц: локализация store, footprint
 * (каталоги таблиц, aux-файлы, размер data, версии) + метаданные из конфига.
 *
 * @param input - dbPath/root.
 * @param cwd - базовый каталог.
 */
export async function ragDbInspect(
    input: TRagDbInspectInput,
    cwd: string,
): Promise<IRagDbInspect> {
    const errors: string[] = [];
    if (!input.dbPath && !input.root) {
        errors.push('задайте dbPath или root');
    }

    const located = await locateStore(input.dbPath ?? input.root, cwd);

    if (!located.storePath) {
        errors.push(
            'не удалось локализовать rag_db: задайте dbPath/root и/или убедитесь, что рядом .opencode/rag_db или задан vectorStore.path',
        );
        const footprint: IRagDbFootprint = {
            storePath: null,
            exists: false,
            tableDirs: [],
            auxFiles: [],
            dataFilesCount: null,
            totalDataBytes: null,
            versionCount: null,
        };
        return { exists: false, footprint, table: null, config: null, configPath: located.configPath, errors };
    }

    const { storePath } = located;
    let exists = false;
    try {
        await fs.access(storePath);
        exists = true;
    } catch {
    // store отсутствует.
    }

    const tableDir = path.join(storePath, 'chunks.lance');
    const top = (await namesOr(storePath)) ?? [];
    const tableDirs = top.filter(n => n.endsWith('.lance'));
    const auxFiles = top.filter(n => !n.endsWith('.lance') && !n.startsWith('__'));
    const data = await sumFiles(path.join(tableDir, 'data'));
    const versions = (await namesOr(path.join(tableDir, '_versions'))) ?? [];

    const footprint: IRagDbFootprint = {
        storePath,
        exists,
        tableDirs,
        auxFiles,
        dataFilesCount: data ? data.count : null,
        totalDataBytes: data ? data.bytes : null,
        versionCount: versions.length,
    };

    let table: ITableInfo | null = null;
    if (exists) {
        try {
            table = await tableInfo(storePath);
        } catch (e) {
            errors.push(`table: ${errMsg(e)}`);
        }
    }

    return {
        exists,
        footprint,
        table,
        config: {
            embedding: located.config?.embedding ?? null,
            retrieval: located.config?.retrieval ?? null,
        },
        configPath: located.configPath,
        errors,
    };
}
