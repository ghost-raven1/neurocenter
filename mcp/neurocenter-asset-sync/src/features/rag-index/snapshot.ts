import fs from 'node:fs/promises';
import path from 'node:path';
import { connectStore, ROW_COLUMNS, mapRow } from '../../lib/lancedb.js';

type NativeHandle = { close(): void };

/** Both acquired handles are released; a table-close error has priority over connection cleanup. */
function closeHandles(db: NativeHandle, table?: NativeHandle): void {
    let failure: { error: unknown } | undefined;
    try { table?.close(); } catch (error) { failure = { error }; }
    try { db.close(); } catch (error) { failure ??= { error }; }
    if (failure) { throw failure.error; }
}

function failSnapshot(error: unknown, db: NativeHandle, table?: NativeHandle): never {
    try { closeHandles(db, table); } catch { /* The original native operation remains the primary error. */ }
    throw error;
}

/** Один checkout используется и для полного fingerprint, и для передаваемых строк. */
export async function openIndexSnapshot(storePath: string) {
    const identity = async () => {
        const stat = await fs.lstat(path.join(storePath, 'chunks.lance'), { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Таблица индекса должна быть обычным каталогом.'); }
        return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    };
    const physical = await identity();
    const db = await connectStore(storePath);
    const table = await db.openTable('chunks').catch(error => failSnapshot(error, db));
    let version: number, rowCount: number, dimension: number;
    try {
        version = await table.version();
        await table.checkout(version);
        rowCount = await table.countRows();
        const schema = await table.schema();
        dimension = (schema.fields.find(field => field.name === 'embedding')?.type as { listSize?: number })?.listSize ?? 0;
    } catch (error) { failSnapshot(error, db, table); }
    const assertCurrent = async () => {
        const currentDb = await connectStore(storePath);
        let current: Awaited<ReturnType<typeof currentDb.openTable>> | undefined;
        try {
            current = await currentDb.openTable('chunks');
            if (await identity() !== physical || await current.version() !== version) {
                throw new Error('Локальный индекс изменился во время передачи. Дождитесь индексации и повторите операцию.');
            }
        } catch (error) { failSnapshot(error, currentDb, current); }
        closeHandles(currentDb, current);
    };
    async function* rows(limit = Infinity) {
        let offset = 0;
        while (offset < Math.min(rowCount, limit)) {
            const page = await table.query().select(ROW_COLUMNS).limit(Math.min(500, limit - offset)).offset(offset).toArrow();
            const values = page.toArray();
            if (!values.length) { throw new Error('Снимок индекса прочитан не полностью.'); }
            for (const value of values) { yield mapRow(value as unknown as Record<string, unknown>); }
            offset += values.length;
        }
    }
    async function selected(ids: string[]) {
        if (!ids.length) { return []; }
        const clause = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
        const data = await table.query().select(ROW_COLUMNS).filter(`id IN (${clause})`).toArrow();
        const result = data.toArray().map(value => mapRow(value as unknown as Record<string, unknown>));
        const found = new Set(result.map(row => row.id));
        if (result.length !== ids.length || found.size !== ids.length || ids.some(id => !found.has(id))) {
            throw new Error('Не все выбранные фрагменты прочитаны. Серверная копия не очищена.');
        }
        return result;
    }
    return { rowCount, dimension, version, rows, selected, assertCurrent, close: () => closeHandles(db, table) };
}
