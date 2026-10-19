import { createHash } from 'node:crypto';

import {chunkSchema} from './chunk-schema.js';

let native: Promise<typeof import('@lancedb/lancedb')> | undefined;
const loadNative = () => native ||= import('@lancedb/lancedb');

/** Отсутствие нативного модуля RAG не останавливает подключение и установку инструментов. */
export async function localRagStatus(): Promise<{ ragSupported: boolean; ragError?: string }> {
    try { await loadNative(); return { ragSupported: true }; }
    catch { return { ragSupported: false, ragError: 'Локальная LanceDB недоступна для этой ОС или архитектуры. Установка скиллов, MCP и плагинов остаётся доступной.' }; }
}
export async function connectStore(storePath: string) {
    let module: typeof import('@lancedb/lancedb');
    try { module = await loadNative(); }
    catch { throw new Error('Нативная LanceDB недоступна. Проверьте поддержку ОС и архитектуры в автономном пакете MCP.'); }
    return module.connect(storePath);
}

/**
 * Read-only доступ к таблице `chunks` в локальном LanceDB (rag_db).
 *
 * Схема (выпрямлённый metadata): id, content, description, embedding[2560],
 * filePath, startLine, endLine, language, kind, role, quirkType, tags.
 */
const TABLE = 'chunks';
const BATCH = 2000;

interface IArrowTypeLike {
    listSize?: number;
    toString(): string;
}

export interface ITableField {
    name: string;
    type: string;
    listSize: number | null;
}

export interface ITableInfo {
    dimension: number | null;
    rowCount: number;
    fields: ITableField[];
}

export interface IChunkFingerprint {
    id: string;
    hash: string;
    filePath: string;
}

/**
 * sha256 содержимого — ключ change-detection для дельты (эмбеддинги
 * детерминированы по content+model, поэтому менять content == менять embed).
 */
export function contentHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Метаданные таблицы `chunks`: размерность вектора, rowCount, список колонок.
 * Дёшево (чтение манифестов).
 */
export async function tableInfo(storePath: string): Promise<ITableInfo> {
    const db = await connectStore(storePath);
    const table = await db.openTable(TABLE);
    try {
        const schema = await table.schema();
        let dimension: number | null = null;
        const fields: ITableField[] = schema.fields.map((f) => {
            const t = f.type as IArrowTypeLike;
            const listSize = typeof t?.listSize === 'number' ? t.listSize : null;
            if (f.name === 'embedding' && listSize != null) {
                dimension = listSize;
            }
            return { name: f.name, type: t ? String(t) : 'unknown', listSize };
        });
        const rowCount = await table.countRows();
        return { dimension, rowCount, fields };
    } finally { table.close(); db.close(); }
}

/**
 * Потоковая эмитация фINGERPRINT'ов `(id, sha256(content), filePath)` батчами
 * (только нужные колонки, без эмбеддингов). `limit` — стоп после N строк.
 *
 * @param storePath - путь к store (LanceDB dir).
 * @param limit - 0/undefined = весь индекс.
 */
export async function* enumerateFingerprints(
    storePath: string,
    limit?: number,
): AsyncGenerator<IChunkFingerprint> {
    const db = await connectStore(storePath);
    const table = await db.openTable(TABLE);
    const cap = limit && limit > 0 ? limit : Infinity;
    let offset = 0;
    for (;;) {
        const at = await table
            .query()
            .select([ 'id', 'content', 'filePath' ])
            .limit(BATCH)
            .offset(offset)
            .toArrow();
        const rows = at.toArray() as { id: string; content: string; filePath: string }[];
        if (rows.length === 0) {
            return;
        }
        for (const r of rows) {
            yield {
                id: String(r.id),
                hash: contentHash(String(r.content ?? '')),
                filePath: String(r.filePath ?? ''),
            };
            offset += 1;
            if (offset >= cap) {
                return;
            }
        }
        if (rows.length < BATCH) {
            return;
        }
    }
}

export interface IChunkRow {
    id: string;
    content: string;
    description: string | null;
    filePath: string | null;
    startLine: number | null;
    endLine: number | null;
    language: string | null;
    kind: string | null;
    role: string | null;
    quirkType: string | null;
    tags: string | null;
    embedding: number[] | null;
}

export const ROW_COLUMNS = [
    'id',
    'content',
    'description',
    'filePath',
    'startLine',
    'endLine',
    'language',
    'kind',
    'role',
    'quirkType',
    'tags',
    'embedding',
];

/**
 * Конвертация колонки `embedding` (Arrow FixedSizeList<Float32> / Vector) в
 * плоский `number[]` для JSON-платформы sync. `.toArray()` (Arrow) не даёт
 * plain Array, поэтому надёжный путь — JSON round-trip (верифицирован).
 */
function toVectorArray(v: unknown): number[] | null {
    if (v == null) {
        return null;
    }
    if (Array.isArray(v)) {
        return v as number[];
    }
    try {
        const parsed = JSON.parse(JSON.stringify(v)) as unknown;
        if (Array.isArray(parsed)) {
            return parsed as number[];
        }
    } catch {
    // не сериализуется → null.
    }
    return null;
}

/**
 * Потоковая эмитация ПОЛНЫХ строк `chunks` батчами (включая `embedding`).
 * Нужна для apply-пути синхронизации (push добавленных/изменённых в PG).
 *
 * @param storePath - путь к store (LanceDB dir).
 * @param limit - 0/undefined = весь индекс.
 */
export async function* enumerateRows(
    storePath: string,
    limit?: number,
): AsyncGenerator<IChunkRow> {
    const db = await connectStore(storePath);
    const table = await db.openTable(TABLE);
    const cap = limit && limit > 0 ? limit : Infinity;
    let offset = 0;
    for (;;) {
        const at = await table
            .query()
            .select(ROW_COLUMNS)
            .limit(BATCH)
            .offset(offset)
            .toArrow();
        const rows = at.toArray() as Record<string, unknown>[];
        if (rows.length === 0) {
            return;
        }
        for (const r of rows) {
            yield mapRow(r);
            offset += 1;
            if (offset >= cap) {
                return;
            }
        }
        if (rows.length < BATCH) {
            return;
        }
    }
}

/** Маппит сырой строки Arrow в IChunkRow (общий для enumerateRows/readRowsByIds). */
export function mapRow(r: Record<string, unknown>): IChunkRow {
    return {
        id: String(r.id),
        content: String(r.content ?? ''),
        description: r.description == null ? null : String(r.description),
        filePath: r.filePath == null ? null : String(r.filePath),
        startLine: r.startLine == null ? null : Number(r.startLine),
        endLine: r.endLine == null ? null : Number(r.endLine),
        language: r.language == null ? null : String(r.language),
        kind: r.kind == null ? null : String(r.kind),
        role: r.role == null ? null : String(r.role),
        quirkType: r.quirkType == null ? null : String(r.quirkType),
        tags: r.tags == null ? null : String(r.tags),
        embedding: toVectorArray(r.embedding),
    };
}

export interface IWriteResult {
    written: number;
    deleted: number;
    created: boolean;
}

/**
 * Обратная синхронизация: запись ВСЕХ строк (как правило загруженных из
 * postgres/pgvector) в локальную таблицу `chunks` LanceDB.
 *
 * Если таблицы ещё нет — создаёт её из данных (createTable). Иначе делает
 * полный merge-insert по `id`: обновляет совпавшие, вставляет новые и удаляет
 * те, которых нет в источнике (когдаNotMatchedBySourceDelete). Это делает
 * локальную базу «слепком» серверного develop-индекса.
 *
 * @param storePath - путь к store (LanceDB dir).
 * @param rows - полные строки (идентично IChunkRow, `embedding` — number[]).
 * @returns сводка записи.
 */
export async function writeRows(
    storePath: string,
    rows: Record<string, unknown>[],
    deleteNotMatched = true,
    dimension?:number,
): Promise<IWriteResult> {
    const db = await connectStore(storePath);
    let opened: import('@lancedb/lancedb').Table | undefined;
    try {
        if (rows.length === 0) {
            return { written: 0, deleted: 0, created: false };
        }

        if (!(await db.tableNames()).includes(TABLE)) {
            const vector=rows.find(row=>Array.isArray(row.embedding)&&row.embedding.length)?.embedding as number[]|undefined;
            opened = await db.createTable(TABLE, rows,{schema:chunkSchema(dimension||vector?.length||0)});
            return { written: rows.length, deleted: 0, created: true };
        }

        const table = await db.openTable(TABLE);
        opened = table;
        const actualDimension = ((await table.schema()).fields.find(field => field.name === 'embedding')?.type as IArrowTypeLike)?.listSize;
        if (dimension && actualDimension !== dimension) { throw new Error('Размерность записываемого индекса отличается от локальной таблицы.'); }
        let builder = table
            .mergeInsert('id')
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll();
        if (deleteNotMatched) {
            builder = builder.whenNotMatchedBySourceDelete();
        }
        const res = await builder.execute(rows);

        const n = res?.numInsertedRows ?? 0;
        const u = res?.numUpdatedRows ?? 0;
        const d = res?.numDeletedRows ?? 0;
        return { written: n + u, deleted: d, created: false };
    } finally { opened?.close(); db.close(); }
}

/**
 * Потоковый вывод только id строк `chunks` без контента/эмбеддингов
 * (быстрый лёгкий проход — для зеркального cleanup после restore).
 *
 * @param storePath - путь к store.
 */
export async function* enumerateIds(
    storePath: string,
): AsyncGenerator<string> {
    const db = await connectStore(storePath);
    if (!(await db.tableNames()).includes(TABLE)) {return;}
    const table = await db.openTable(TABLE);
    let offset = 0;
    for (;;) {
        const at = await table
            .query()
            .select([ 'id' ])
            .limit(BATCH)
            .offset(offset)
            .toArrow();
        const rows = at.toArray() as { id: string }[];
        if (rows.length === 0) {return;}
        for (const r of rows) {
            yield String(r.id);
            offset += 1;
        }
        if (rows.length < BATCH) {return;}
    }
}

/**
 * Удаляет строки по списку id (батчами по IN-фильтру, ≤500 id за запрос).
 *
 * @param storePath - путь к store.
 * @param ids - id для удаления.
 * @returns количество удалённых (размер списка; LanceDB delete не возвращает счёт).
 */
export async function deleteIds(
    storePath: string,
    ids: string[],
): Promise<number> {
    if (ids.length === 0) {return 0;}
    const db = await connectStore(storePath);
    if (!(await db.tableNames()).includes(TABLE)) {return 0;}
    const table = await db.openTable(TABLE);
    const idBatch = 500;
    for (let i = 0; i < ids.length; i += idBatch) {
        const chunk = ids.slice(i, i + idBatch);
        const clause = chunk.map(id => `'${String(id).replace(/'/g, '\'\'')}'`).join(', ');
        await table.delete(`id IN (${clause})`);
    }
    return ids.length;
}

/**
 * Читает полные строки ТОЛЬКО для заданных id (O(delta), через `id IN (...)`).
 * Нужен для apply: push только добавленных/изменённых, не весь индекс.
 * Если `.filter()` не поддерживается/ошибается — fallback на полный прогон + отбор.
 *
 * @param storePath - путь к store.
 * @param ids - список id для выборки (батчится по 200).
 */
export async function* readRowsByIds(
    storePath: string,
    ids: string[],
): AsyncGenerator<IChunkRow> {
    if (ids.length === 0) {
        return;
    }
    const db = await connectStore(storePath);
    const table = await db.openTable(TABLE);
    const idBatch = 200;
    let usedFilter = false;
    for (let i = 0; i < ids.length; i += idBatch) {
        const chunk = ids.slice(i, i + idBatch);
        const clause = chunk.map(id => `'${String(id).replace(/'/g, '\'\'')}'`).join(', ');
        try {
            const at = await table
                .query()
                .select(ROW_COLUMNS)
                .filter(`id IN (${clause})`)
                .toArrow();
            const rows = at.toArray() as Record<string, unknown>[];
            for (const r of rows) {yield mapRow(r);}
            usedFilter = true;
        } catch {
            if (usedFilter) {
                throw new Error('readRowsByIds: filter broke mid-scan');
            }
            // fallback: полный прогон + отбор (без filter).
            const wanted = new Set(chunk);
            let offset = 0;
            for (;;) {
                const at = await table
                    .query()
                    .select(ROW_COLUMNS)
                    .limit(BATCH)
                    .offset(offset)
                    .toArrow();
                const rows = at.toArray() as Record<string, unknown>[];
                if (rows.length === 0) {return;}
                for (const r of rows) {if (wanted.has(String(r.id))) {yield mapRow(r);}}
                offset += rows.length;
                if (rows.length < BATCH) {return;}
            }
            return;
        }
    }
}
