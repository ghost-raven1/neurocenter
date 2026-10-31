import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDir } from './state.js';
import { readBoundedUtf8 } from './read-bounded.js';
import { DISK_RESERVE_BYTES, LOCK_BYTES_LIMIT, RECOVERY_BYTES_LIMIT } from './installation-limits.js';
import type { FileChange } from './installation-journal.js';

/** Создаёт только настоящие каталоги: приватный журнал не может уйти через симлинк. */
export async function recoveryDirectory(directory: string, create = true): Promise<void> {
    let resolved = path.resolve(directory);
    // Системные алиасы macOS не являются пользовательской подменой приватной папки.
    const alias = process.platform === 'darwin' && /^\/(var|tmp|etc)(?=\/|$)/.exec(resolved)?.[0];
    if (alias && (await fs.realpath(alias)) === '/private' + alias) {
        resolved = '/private' + resolved;
    }
    let current = path.parse(resolved).root;
    for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        let stat;
        try {
            stat = await fs.lstat(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            if (!create) {
                throw error;
            }
            await fs.mkdir(current, { mode: 0o700 }).catch((reason) => {
                if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw reason;
                }
            });
            stat = await fs.lstat(current);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Папка локального журнала содержит симлинк или посторонний файл.');
        }
    }
}
async function existingDirectory(target: string): Promise<string> {
    let current = path.resolve(target);
    while (true) {
        try {
            const stat = await fs.lstat(current);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new Error('Недопустимая папка для проверки свободного места.');
            }
            return current;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                throw error;
            }
            current = parent;
        }
    }
}

/** При общей файловой системе складывает оба бюджета и сохраняет один резерв 128 МиБ. */
export async function assertInstallationSpace(
    root: string,
    encodedJournalBytes = 0,
    changes: FileChange[] = [],
): Promise<void> {
    const state = await existingDirectory(stateDir());
    const targets = [
        { path: state, required: BigInt(2 * encodedJournalBytes + 65536) },
        {
            path: root,
            required: changes.reduce(
                (sum, change) =>
                    sum +
                    BigInt(
                        [change.before, change.after].reduce(
                            (bytes: number, value) =>
                                bytes + (value === null ? 0 : Buffer.byteLength(value, change.encoding ?? 'utf8')),
                            8192 * change.relative.split('/').length,
                        ),
                    ),
                0n,
            ),
        },
    ];
    const filesystems = new Map<string, { path: string; required: bigint }>();
    for (const target of targets) {
        const stat = await fs.lstat(target.path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Недопустимая папка для локальной записи.');
        }
        const key = stat.dev.toString();
        const known = filesystems.get(key);
        if (known) {
            known.required += target.required;
        } else {
            filesystems.set(key, { ...target });
        }
    }
    for (const target of filesystems.values()) {
        const stat = await fs.statfs(target.path, { bigint: true });
        if (stat.bavail * stat.bsize < target.required + BigInt(DISK_RESERVE_BYTES)) {
            throw new Error(
                'Недостаточно свободного места для записи и отката. Освободите место; резерв 128 МиБ должен оставаться на дисках проекта и MCP.',
            );
        }
    }
}

async function recoveryBytes(): Promise<bigint> {
    const parent = path.join(stateDir(), 'file-changes');
    let bytes = 0n;
    const folders = await fs.opendir(parent);
    for await (const folder of folders) {
        if (!/^[a-f0-9]{64}$/.test(folder.name)) {
            continue;
        }
        if (!folder.isDirectory() || folder.isSymbolicLink()) {
            throw new Error('Повреждена папка локальных резервных копий.');
        }
        const directory = path.join(parent, folder.name);
        for (const name of ['pending.json', 'history']) {
            const target = path.join(directory, name);
            let stat;
            try {
                stat = await fs.lstat(target, { bigint: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
            if (stat.isSymbolicLink()) {
                throw new Error('Резервные копии не должны содержать симлинки.');
            }
            if (name === 'pending.json') {
                if (!stat.isFile()) {
                    throw new Error('Повреждён локальный журнал восстановления.');
                }
                bytes += stat.size;
            } else {
                if (!stat.isDirectory()) {
                    throw new Error('Повреждена папка истории восстановления.');
                }
                for await (const entry of await fs.opendir(target)) {
                    const stored = await fs.lstat(path.join(target, entry.name), { bigint: true });
                    if (!stored.isFile() || stored.isSymbolicLink()) {
                        throw new Error('История восстановления содержит посторонний тип файла.');
                    }
                    bytes += stored.size;
                    if (bytes > BigInt(RECOVERY_BYTES_LIMIT)) {
                        return bytes;
                    }
                }
            }
        }
    }
    return bytes;
}
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
};

/** Общий lock не позволяет двум проектам одновременно израсходовать один бюджет истории. */
async function budgetLock(): Promise<() => Promise<void>> {
    const parent = path.join(stateDir(), 'file-changes');
    await recoveryDirectory(parent);
    const file = path.join(parent, 'quota.lock');
    const value = JSON.stringify({ pid: process.pid, token: randomUUID() });
    const acquire = () => fs.writeFile(file, value, { flag: 'wx', mode: 0o600 });
    try {
        await acquire();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
        const previous = await readBoundedUtf8(file, LOCK_BYTES_LIMIT);
        let owner: { pid: number };
        try {
            owner = JSON.parse(previous) as typeof owner;
            if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) {
                throw new Error();
            }
        } catch {
            throw new Error('Повреждён lock бюджета восстановления. Проверьте локальный журнал вручную.');
        }
        if (alive(owner.pid)) {
            throw new Error('Бюджет резервных копий занят другой локальной операцией. Повторите после её завершения.');
        }
        const guard = path.join(parent, 'quota-recovery.lock');
        await fs.writeFile(guard, value, { flag: 'wx', mode: 0o600 }).catch(() => {
            throw new Error('Восстановление бюджета уже начато. Проверьте quota-recovery.lock.');
        });
        try {
            if ((await readBoundedUtf8(file, LOCK_BYTES_LIMIT)) !== previous) {
                throw new Error('Lock бюджета изменился во время восстановления.');
            }
            await fs.unlink(file);
            await acquire();
        } finally {
            if ((await readBoundedUtf8(guard, LOCK_BYTES_LIMIT)) === value) {
                await fs.unlink(guard);
            }
        }
    }
    return async () => {
        if ((await readBoundedUtf8(file, LOCK_BYTES_LIMIT)) === value) {
            await fs.unlink(file);
        }
    };
}

/** Старый pending уже резервирует место в квоте; его восстановление не удаляет другие копии. */
export async function withRecoveryBudget<T>(
    root: string,
    encodedJournalBytes: number,
    changes: FileChange[],
    creating: boolean,
    action: () => Promise<T>,
): Promise<T> {
    await assertInstallationSpace(root, encodedJournalBytes, changes);
    const release = await budgetLock();
    try {
        if (creating && (await recoveryBytes()) + BigInt(encodedJournalBytes) > BigInt(RECOVERY_BYTES_LIMIT)) {
            throw new Error(
                'Локальные резервные копии достигли лимита 1 ГиБ. Сверьте и перенесите историю вручную; автоматическое удаление запрещено.',
            );
        }
        await assertInstallationSpace(root, encodedJournalBytes, changes);
        return await action();
    } finally {
        await release();
    }
}
