import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
    tableInfo,
    enumerateFingerprints,
    type IChunkFingerprint,
} from '../lib/lancedb.js';
import { errMsg } from '../lib/stdio.js';
import { locateStore } from '../lib/store.js';

export const ragDbDiffInputSchema = z
    .object({
        root: z.string().optional().describe('Корень воркспейса (деф. CWD).'),
        dbPath: z.string().optional().describe('Явный путь к rag_db (LanceDB).'),
        projectKey: z
            .string()
            .optional()
            .describe('Ключ проекта (авторитетно — из каталога) для привязки дельты к серверной коллекции.'),
        limit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .default(50)
            .describe('Превью: сколько строк (sample) выдать.'),
        scanLimit: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe('0 = весь индекс; >0 = просканировать не более N строк (быстрый превью/тест).'),
        baselinePath: z
            .string()
            .optional()
            .describe('JSON-файл baseline {"<id>": "<sha256>"} (снимок сервера) → diff added/changed/removed.'),
    })
    .strict();

export type TRagDbDiffInput = z.infer<typeof ragDbDiffInputSchema>;

export interface IRagDbDiff {
    status: 'local' | 'local+baseline';
    storePath: string | null;
    projectKey: string | null;
    dimension: number | null;
    rowCountTotal: number | null;
    scanned: number;
    addedCount: number;
    changedCount: number;
    removedCount: number;
    sample: IChunkFingerprint[];
    byFileTop: { filePath: string; count: number }[];
    baseline: { source: string; idCount: number } | null;
    notes: string[];
}

export interface IRagDbDiffError {
    error: string;
    notes: string[];
}

/**
 * Дельта rag_db: локальный fingerprint-set `(id, sha256(content))` + diff против
 * baseline (снимка сервера), если передан. Read-only: никаких записей.
 *
 * @param input - параметры.
 * @param cwd - базовый каталог.
 */
export async function ragDbDiff(
    input: TRagDbDiffInput,
    cwd: string,
): Promise<IRagDbDiff | IRagDbDiffError> {
    const notes: string[] = [];
    if (!input.dbPath && !input.root) {
        notes.push('задайте dbPath или root');
    }
    const located = await locateStore(input.dbPath ?? input.root, cwd);
    if (!located.storePath) {
        return {
            error: 'не удалось локализовать rag_db',
            notes: [
                'задайте dbPath/root и/или убедитесь, что рядом .opencode/rag_db или задан vectorStore.path',
            ],
        };
    }
    const { storePath } = located;

    let info: { dimension: number | null; rowCount: number | null } = {
        dimension: null,
        rowCount: null,
    };
    try {
        const t = await tableInfo(storePath);
        info.dimension = t.dimension;
        info.rowCount = t.rowCount;
    } catch (e) {
        notes.push(`table info: ${errMsg(e)}`);
    }

    let baseline: Map<string, string> | null = null;
    let baselineMeta: IRagDbDiff['baseline'] = null;
    if (input.baselinePath) {
        try {
            const braw = await fs.readFile(path.resolve(cwd, input.baselinePath), 'utf8');
            const bm = JSON.parse(braw) as Record<string, string>;
            baseline = new Map(Object.entries(bm));
            baselineMeta = { source: input.baselinePath, idCount: baseline.size };
        } catch (e) {
            return {
                error: 'не удалось прочитать baselinePath',
                notes: [ errMsg(e) ],
            };
        }
    }

    const local = new Map<string, { hash: string; filePath: string }>();
    const byFile = new Map<string, number>();
    const sample: IChunkFingerprint[] = [];
    let scanned = 0;

    for await (const fp of enumerateFingerprints(
        storePath,
        input.scanLimit > 0 ? input.scanLimit : undefined,
    )) {
        local.set(fp.id, { hash: fp.hash, filePath: fp.filePath });
        byFile.set(fp.filePath, (byFile.get(fp.filePath) ?? 0) + 1);
        if (sample.length < input.limit) {
            sample.push(fp);
        }
        scanned += 1;
    }

    let addedCount = 0;
    let changedCount = 0;
    let removedCount = 0;
    if (baseline) {
        for (const [ id, v ] of local) {
            if (!baseline.has(id)) {
                addedCount += 1;
            } else if (baseline.get(id) !== v.hash) {
                changedCount += 1;
            }
        }
        for (const id of baseline.keys()) {
            if (!local.has(id)) {
                removedCount += 1;
            }
        }
    } else {
        addedCount = local.size;
    }

    if (input.scanLimit > 0) {
        notes.push(`частичное сканирование (scanLimit=${input.scanLimit}); для полной дельты scanLimit=0`);
    }

    const byFileTop = [ ...byFile.entries() ]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([ filePath, count ]) => ({ filePath, count }));

    return {
        status: baseline ? 'local+baseline' : 'local',
        storePath,
        projectKey: input.projectKey ?? null,
        dimension: info.dimension,
        rowCountTotal: info.rowCount,
        scanned,
        addedCount,
        changedCount,
        removedCount,
        sample,
        byFileTop,
        baseline: baselineMeta,
        notes,
    };
}
