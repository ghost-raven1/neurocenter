import fs from 'node:fs/promises';
import path from 'node:path';
import { connectStore, ROW_COLUMNS, mapRow } from '../../lib/lancedb.js';

/** Один checkout используется и для полного fingerprint, и для передаваемых строк. */
export async function openIndexSnapshot(storePath: string) {
    const identity = async () => {
        const stat = await fs.lstat(path.join(storePath, 'chunks.lance'), { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Таблица индекса должна быть обычным каталогом.'); }
        return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    };
    const physical = await identity();
    const db = await connectStore(storePath);
    const table = await db.openTable('chunks');
    const version = await table.version();
    await table.checkout(version);
    const rowCount = await table.countRows();
    const schema = await table.schema();
    const dimension = (schema.fields.find(field => field.name === 'embedding')?.type as { listSize?: number })?.listSize ?? 0;
    const assertCurrent = async () => {
        const currentDb = await connectStore(storePath);
        const current = await currentDb.openTable('chunks');
        try {
            if (await identity() !== physical || await current.version() !== version) {
                throw new Error('Локальный индекс изменился во время передачи. Дождитесь индексации и повторите операцию.');
            }
        } finally { current.close(); currentDb.close(); }
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
    return { rowCount, dimension, version, rows, selected, assertCurrent, close: () => { table.close(); db.close(); } };
}
