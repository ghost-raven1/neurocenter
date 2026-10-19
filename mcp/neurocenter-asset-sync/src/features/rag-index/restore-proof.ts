import fs from 'node:fs/promises';
import path from 'node:path';
import { fileFingerprint, readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { syncDirectory } from '../../bridge/atomic-file.js';

export interface RestoreDirectoryProof { physical: string; entries: Record<string, string> }

/** Inode и снимок всех служебных файлов обнаруживают подмену и правки после проверки LanceDB. */
export async function restoreDirectoryProof(directory: string, lock: string, sync = false): Promise<RestoreDirectoryProof | undefined> {
    const root = await fs.lstat(directory, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') { return undefined; } throw error;
    });
    if (!root) { return undefined; }
    if (!root.isDirectory() || root.isSymbolicLink()) { throw new Error('Папка восстановления индекса заменена или содержит симлинк.'); }
    const entries: Record<string, string> = Object.create(null) as Record<string, string>;
    const walk = async (folder: string, prefix = ''): Promise<void> => {
        for (const name of (await fs.readdir(folder)).sort()) {
            const relative = prefix + name, file = path.join(folder, name);
            const stat = await fs.lstat(file, { bigint: true });
            if (!stat.isFile() && !stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Индекс содержит симлинк или посторонний тип файла.'); }
            if (relative === 'index.lock') {
                if (await readBoundedUtf8(file, 1024) !== lock) { throw new Error('Блокировка индекса изменилась. Восстановление остановлено.'); }
                continue;
            }
            entries[relative] = stat.isDirectory() ? `d:${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : 'f:' + fileFingerprint(stat);
            if (stat.isDirectory()) { await walk(file, relative + '/'); }
            else if (sync) { const handle = await fs.open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
            const after = await fs.lstat(file, { bigint: true });
            if (fileFingerprint(after) !== fileFingerprint(stat)) { throw new Error('Индекс изменился во время подготовки восстановления.'); }
        }
        if (sync) { await syncDirectory(folder); }
    };
    await walk(directory);
    const current = await fs.lstat(directory, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino || current.birthtimeNs !== root.birthtimeNs) {
        throw new Error('Папка индекса изменилась во время проверки.');
    }
    return { physical: `${root.dev}:${root.ino}:${root.birthtimeNs}`, entries };
}

/** Частичная очистка допускает только оставшееся неизменённое подмножество собственного дерева. */
export function matchesRestoreProof(current: RestoreDirectoryProof | undefined, expected: RestoreDirectoryProof, partial = false): boolean {
    return !!current && current.physical === expected.physical
        && (partial || Object.keys(current.entries).length === Object.keys(expected.entries).length)
        && Object.entries(current.entries).every(([key, value]) => expected.entries[key] === value);
}
