import { z } from 'zod';

import { tableInfo, enumerateFingerprints, readRowsByIds, contentHash } from '../lib/lancedb.js';
import { locateStore } from '../lib/store.js';
import { readRagProjectIdentity, unverifiedRagProject, verifiedRagProjectIdentity } from '../lib/rag-project-identity.js';
import { ragStoreBoundary } from '../lib/rag-store-boundary.js';

/** Базовый URL rag-сервиса (dev: local :4300). */
import {authorizedFetch} from '../bridge/state.js';
/** Дельта больше этого не применяется автоматически (превью + явный maxRows/limit). */
const AUTO_APPLY_LIMIT = 1000;
const UPSERT_BATCH = 100;
const DELETE_BATCH = 500;

export const syncRagDbInputSchema = z.object({
    project: z.string().optional(),
    projectKey: z.string().optional(),
    createIfMissing: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    scanLimit: z.number().int().positive().optional(),
    maxRows: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
});
export type TSyncRagDbInput = z.infer<typeof syncRagDbInputSchema>;

interface IRagChunk {
    id: string;
    content?: string;
    contentHash?: string;
    filePath?: string;
    description?: string;
    startLine?: number;
    endLine?: number;
    language?: string;
    kind?: string;
    role?: string;
    quirkType?: string;
    tags?: string;
    embedding?: number[];
}

interface ISyncResult {
    upserted: number;
    deleted: number;
}

async function postSync(projectKey: string, chunks: IRagChunk[], deletes: string[], assertIdentity: () => Promise<void>): Promise<ISyncResult> {
    await assertIdentity();
    const r = await authorizedFetch('/api/rag/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey, chunks, deletes }),
    });
    if (!r.ok) {
        let message='Сервер временно не принимает изменения. Повторите синхронизацию позже.';
        try{
            const body=await r.json() as {message?:unknown};
            if(typeof body?.message==='string'&&body.message.length>0&&body.message.length<=2048){message=body.message;}
        }catch{/* HTML прокси и внутренние детали сервера не показываются пользователю. */}
        throw new Error(`Синхронизация остановлена (HTTP ${r.status}). ${message}`);
    }
    return (await r.json()) as ISyncResult;
}

/**
 * Дельта-синхронизация локального rag_db (LanceDB) → develop-базовая копия (Postgres/pgvector).
 * Базовая копия = manifest на сервере (id → sha256); считается добавлено/изменено и удалено.
 *
 * Режимы:
 * - dryRun: только план (без записи, включая создание проекта).
 * - неполный scanLimit: только превью добавлений; удаления неизвестны, запись запрещена.
 * - limit=N: применить НЕ БОЛЕЕ N строк (слайс), вернуть remaining>0 → повторить вызов.
 *   Это делает каждый MCP-вызов коротким (< таймаут хоста) и резюмируемым — для bootstrap.
 * - без limit: если дельта > maxRows (по умолч. 1000) — превью, без применения;
 *   иначе применяет всю дельту.
 *
 * @param input - project, createIfMissing, dryRun, scanLimit, maxRows, limit.
 * @param cwd - базовая директория (opencode cwd).
 * @returns JSON-сводка синхронизации.
 */
export async function syncRagDb(input: TSyncRagDbInput, cwd: string): Promise<string> {
    let projectKey: string | undefined = input.projectKey?.trim() || undefined;
    const resolveIdentity = async () => {
        return readRagProjectIdentity(
            { project: input.project, createIfMissing: input.dryRun || input.scanLimit ? false : input.createIfMissing },
            cwd,
        );
    };
    const initial = await resolveIdentity();
    if (!projectKey) {
        if (!initial.value.ok || !initial.value.projectKey) {return initial.raw;}
        projectKey = initial.value.projectKey;
    }
    if (!input.dryRun && !verifiedRagProjectIdentity(initial.value, projectKey)) {
        return unverifiedRagProject();
    }
    const located = await locateStore(input.project, cwd);
    if (!located.storePath) {
        return JSON.stringify({
            ok: false,
            error: 'store-not-found',
            message: `rag_db не найден от (${cwd}). Укажи project=путь к корню с opencode-rag.json.`,
        });
    }
    const { storePath } = located;
    const assertStore = ragStoreBoundary(input.project, cwd, storePath);
    await assertStore();
    const assertIdentity = async () => {
        const current = (await resolveIdentity()).value;
        if (!verifiedRagProjectIdentity(current, projectKey!, initial.value)) {
            throw new Error('Привязка локального экземпляра изменилась. Синхронизация остановлена до отправки изменений.');
        }
        await assertStore();
    };

    const ti = await tableInfo(storePath);
    const localIds = new Map<string, string>();
    for await (const fp of enumerateFingerprints(storePath, input.scanLimit ?? 0)) {
        localIds.set(fp.id, fp.hash);
    }

    // Ошибка сервера не означает пустую базу: без достоверного manifest запись запрещена.
    const response = await authorizedFetch(`/api/rag/manifest?projectKey=${encodeURIComponent(projectKey)}`);
    if (!response.ok) {throw new Error(`manifest ${response.status}: ${(await response.text()).slice(0, 200)}`);}
    const manifest = z.object({ ids: z.record(z.string()) }).safeParse(await response.json());
    if (!manifest.success) {throw new Error('invalid-manifest: expected ids record');}
    const baseline = manifest.data.ids;
    const scanComplete = input.scanLimit == null || input.scanLimit >= ti.rowCount;
    const baselineIdList = Object.keys(baseline);

    const added: string[] = [];
    const removed: string[] = [];
    for (const [ id, sha ] of localIds) {if (!baseline[id] || baseline[id] !== sha) {added.push(id);}}
    if (scanComplete) {
        for (const id of baselineIdList) {if (!localIds.has(id)) {removed.push(id);}}
    }
    const total = added.length + removed.length;
    const cap = input.maxRows ?? AUTO_APPLY_LIMIT;
    const dryRun = input.dryRun === true;
    const limit = input.limit ?? null;

    if (!scanComplete || dryRun || (limit == null && total > cap)) {
        const preview = {
            ok: false,
            dryRun,
            scanComplete,
            projectKey,
            local: localIds.size,
            baseline: baselineIdList.length,
            addedCount: added.length,
            added: added.slice(0, 50),
            removedCount: scanComplete ? removed.length : null,
            removed: removed.slice(0, 50),
            applied: false,
            note: !scanComplete
                ? 'partial scan; deletions are unknown; repeat without scanLimit to apply'
                : dryRun
                ? 'dry-run; set dryRun=false (and raise maxRows, or pass limit) to apply'
                : `total changes (${total}) exceed maxRows cap (${cap}); preview only — raise maxRows, or use limit for a bounded slice`,
        };
        return JSON.stringify(preview, null, 2);
    }

    await assertIdentity();
    const toAdd = limit == null ? added : added.slice(0, limit);
    const toRemove = limit == null ? removed : removed.slice(0, limit - toAdd.length);

    let upserted = 0;
    let buffer: IRagChunk[] = [];
    const flush = async (): Promise<void> => {
        if (buffer.length === 0) {return;}
        let res:ISyncResult;
        try{res=await postSync(projectKey, buffer, [], assertIdentity);}
        catch(error){
            if(upserted>0){throw new Error(`${error instanceof Error?error.message:'Не удалось отправить пакет.'} Ранее подтверждено фрагментов: ${upserted}. Повторная синхронизация продолжит с оставшихся изменений.`,{cause:error});}
            throw error;
        }
        upserted += res.upserted ?? 0;
        buffer = [];
    };
    for await (const row of readRowsByIds(storePath, toAdd)) {
        buffer.push({
            id: row.id,
            content: row.content,
            contentHash: contentHash(row.content ?? ''),
            filePath: row.filePath ?? undefined,
            description: row.description ?? undefined,
            startLine: row.startLine ?? undefined,
            endLine: row.endLine ?? undefined,
            language: row.language ?? undefined,
            kind: row.kind ?? undefined,
            role: row.role ?? undefined,
            quirkType: row.quirkType ?? undefined,
            tags: row.tags ?? undefined,
            embedding: row.embedding ?? undefined,
        });
        if (buffer.length >= UPSERT_BATCH) {await flush();}
    }
    await flush();

    // Удаляем только после успешной отправки всех новых строк текущей порции.
    let deleted = 0;
    for (let i = 0; i < toRemove.length; i += DELETE_BATCH) {
        const res = await postSync(projectKey, [], toRemove.slice(i, i + DELETE_BATCH), assertIdentity);
        deleted += res.deleted ?? 0;
    }

    await assertIdentity();
    const remaining = (added.length - toAdd.length) + (removed.length - toRemove.length);
    return JSON.stringify({
        ok: true,
        dryRun: false,
        scanComplete,
        projectKey,
        upserted,
        deleted,
        added: added.length,
        removed: removed.length,
        applied: true,
        appliedNow: upserted + deleted,
        remaining,
        dimension: ti.dimension,
        note: remaining > 0 ? `applied ${limit}-slice; call again with limit until remaining=0` : 'sync complete',
    });
}
