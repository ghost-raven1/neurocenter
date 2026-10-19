import { z } from 'zod';

import { writeRows, enumerateIds, deleteIds } from '../lib/lancedb.js';
import { locateStore } from '../lib/store.js';
import { readRagProjectIdentity, unverifiedRagProject, verifiedRagProjectIdentity } from '../lib/rag-project-identity.js';
import { ragStoreBoundary } from '../lib/rag-store-boundary.js';
import { withWorkspaceIdentityLock } from '../bridge/workspace-identity-state.js';

/** Базовый URL rag-сервиса (dev: local :4300). */
import {authorizedFetch} from '../bridge/state.js';
/** Размер страницы при скачивании develop-индекса (OOM-защита). */
const PAGE_LIMIT = 1000;

export const restoreRagDbInputSchema = z.object({
    projectKey: z.string().min(1),
    project: z.string().optional(),
});
export type TRestoreRagDbInput = z.infer<typeof restoreRagDbInputSchema>;

interface IRagChunkRow {
    id: string;
    content: string;
    description?: string | null;
    filePath?: string | null;
    startLine?: number | null;
    endLine?: number | null;
    language?: string | null;
    kind?: string | null;
    role?: string | null;
    quirkType?: string | null;
    tags?: string | null;
    embedding?: number[] | null;
}

interface IChunksPage {
    projectKey: string;
    count: number;
    dimension: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    chunks: IRagChunkRow[];
}

/**
 * Обратная синхронизация: скачивает develop-индекс из postgres/pgvector
 * СТРАНИЦАМИ (`GET /api/rag/chunks?limit=&offset=`) и записывает в локальную
 * LanceDB-базу проекта (store из `locateStore`).
 *
 * Алгоритм (память ≤ 1 страница за раз):
 * 1. каждую страницу merge-insert без удаления (update совпавших + вставка новых);
 * 2. параллельно собирает Set всех серверных id (лёгкие строки, не векторы);
 * 3. один финальный проход: удаляет локальные id, отсутствующие на сервере
 *    → локальная база становится точным «слепком» серверного индекса.
 *
 * Если скачивание прервано ошибкой — до записи доходят только завершённые
 * страницы, удаление не выполняется (база не теряет данные).
 *
 * @param input - projectKey (обязателен), project (путь к корню/стану).
 * @param cwd - базовая директория.
 * @returns JSON-сводка восстановления.
 */
export async function restoreRagDb(input: TRestoreRagDbInput, cwd: string): Promise<string> {
    const projectKey = input.projectKey.trim();
    if (!projectKey) {
        return JSON.stringify({ ok: false, error: 'projectKey required' });
    }
    const initial = await readRagProjectIdentity({ project: input.project }, cwd);
    if (!verifiedRagProjectIdentity(initial.value, projectKey)) { return unverifiedRagProject(); }

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
    const assertIdentity = async (): Promise<void> => {
        const current = await readRagProjectIdentity({ project: input.project }, cwd);
        if (!verifiedRagProjectIdentity(current.value, projectKey, initial.value)) {
            throw new Error('Привязка локального экземпляра изменилась. Скачивание остановлено до следующей записи или удаления.');
        }
        await assertStore();
    };

    const serverIds = new Set<string>();
    let offset = 0;
    let written = 0;
    let created = false;
    let dimension = 0;
    let sawPage = false;
    // Источник оборвался на пустой странице с hasMore=true (гонка с concurrent-записью)
    // → зеркалирование недопустимо (partial set удалит лишнее).
    let incomplete = false;

    for (;;) {
        await assertIdentity();
        const r = await authorizedFetch(
            `/api/rag/chunks?projectKey=${encodeURIComponent(projectKey)}&limit=${PAGE_LIMIT}&offset=${offset}`,
        );
        if (!r.ok) {
            return JSON.stringify({
                ok: false,
                error: `chunks ${r.status}`,
                projectKey,
                written,
                message: `Скачивание остановлено (HTTP ${r.status}). Ранее записано фрагментов: ${written}. Подтверждённые страницы сохранены; повторите скачивание после восстановления доступа.`,
            });
        }
        const body = (await r.json()) as IChunksPage;
        if (body.projectKey !== projectKey) { throw new Error('Сервер вернул базу знаний другого проекта. Скачивание остановлено.'); }
        const chunks = body.chunks ?? [];
        if (chunks.length > 0) {
            sawPage = true;
            dimension = body.dimension || dimension;
            const rows: Record<string, unknown>[] = chunks.map(c => ({
                id: c.id,
                content: c.content ?? '',
                description: c.description ?? null,
                filePath: c.filePath ?? null,
                startLine: c.startLine ?? null,
                endLine: c.endLine ?? null,
                language: c.language ?? null,
                kind: c.kind ?? null,
                role: c.role ?? null,
                quirkType: c.quirkType ?? null,
                tags: c.tags ?? null,
                embedding: c.embedding ?? null,
            }));
            for (const c of chunks) {serverIds.add(c.id);}
            const res = await withWorkspaceIdentityLock(async () => {
                await assertIdentity();
                return writeRows(storePath, rows, false,dimension);
            });
            written += res.written;
            created = created || res.created;
        }
        offset += PAGE_LIMIT;
        if (body.hasMore && chunks.length === 0) {
            incomplete = true;
            break;
        }
        if (!body.hasMore || chunks.length === 0) {break;}
    }

    // Mirror-delete — только при полностью скачанном непустом источнике.
    // Пустой/неполный источник → без удаления (локальная база не теряется).
    if (incomplete) {
        return JSON.stringify({
            ok: false,
            error: 'incomplete-source',
            projectKey,
            written,
            note: 'источник оборван (hasMore + пустая страница); зеркальный cleanup пропущен, повтори restore',
        });
    }
    if (!sawPage) {
        return JSON.stringify({
            ok: false,
            error: 'empty-source',
            projectKey,
            note: 'develop-индекс пуст; локальная база НЕ очищена (защита от случайного стирания)',
        });
    }

    // Финальный зеркальный cleanup: удаляем локальные id, которых нет на сервере.
    let deleted = 0;
    const toDelete: string[] = [];
    await assertIdentity();
    for await (const id of enumerateIds(storePath)) {
        if (!serverIds.has(id)) {toDelete.push(id);}
    }
    if (toDelete.length > 0) {
        deleted = await withWorkspaceIdentityLock(async () => {
            await assertIdentity();
            return deleteIds(storePath, toDelete);
        });
    }
    await assertIdentity();

    return JSON.stringify({
        ok: true,
        projectKey,
        storePath,
        sourceCount: serverIds.size,
        written,
        deleted,
        created,
        dimension,
        note: 'локальная LanceDB восстановлена из develop-индекса (pgvector), зеркально',
    });
}
