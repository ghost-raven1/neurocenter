import path from 'node:path';
import { safeTarget } from '../../bridge/workspace-paths.js';
import { normalizeChunkRow, type ICanonicalRagRow } from './contract.js';

/** Виртуальные записи native RAG не являются путями файловой системы. */
function virtual(row: ICanonicalRagRow): boolean {
    return row.kind === 'quirk' && row.filePath === 'quirk:' + row.id;
}
function relativeFile(value: string): string {
    if (!value || value.includes('\\') || /[\u0000-\u001f]/.test(value) || path.posix.isAbsolute(value)
        || /^[a-z]:/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Индекс содержит небезопасный путь. Выполните индексацию из папки проекта.');
    }
    return value;
}
function rejectControlPath(value: unknown): void {
    if (typeof (value as { filePath?: unknown })?.filePath === 'string' && /[\u0000-\u001f]/.test((value as { filePath: string }).filePath)) {
        throw new Error('Индекс содержит небезопасный путь с управляющими символами.');
    }
}
/** Передаёт только переносимые пути внутри подтверждённого проекта. */
export async function exportRow(value: unknown, root: string): Promise<ICanonicalRagRow> {
    rejectControlPath(value);
    const row = normalizeChunkRow(value);
    if (virtual(row)) { return row; }
    const original = row.filePath;
    const relative = path.isAbsolute(original) ? path.relative(root, original).split(path.sep).join('/') : original;
    row.filePath = relativeFile(relative);
    await safeTarget(root, row.filePath);
    return row;
}
/** Абсолютные пути старых серверных копий никогда не угадываются и не перебазируются. */
export async function importRow(value: unknown, root: string): Promise<ICanonicalRagRow> {
    rejectControlPath(value);
    const row = normalizeChunkRow(value);
    if (virtual(row)) { return row; }
    row.filePath = await safeTarget(root, relativeFile(row.filePath));
    row.filePath = row.filePath.split(path.sep).join('/');
    return row;
}
