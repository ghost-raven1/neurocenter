import fs from 'node:fs/promises';
import path from 'node:path';
import { syncSkillDirectory } from './skill-versions';

export interface ISkillDirectoryChange {
    kind: 'directory';
    relative: string;
    before: null;
    after: 'directory';
    createdDirectories: string[];
}

export function isSkillDirectoryChange(change: unknown): change is ISkillDirectoryChange {
    return Boolean(change && typeof change === 'object' && (change as { kind?: unknown }).kind === 'directory');
}

export function safeSkillDirectoryPath(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 240 &&
        value.split('/').every((part) => /^[a-z0-9][a-z0-9_-]*$/.test(part))
    );
}

/** В журнале разрешён только непрерывный список отсутствовавших предков запрошенной папки. */
export function validateSkillDirectoryChange(change: ISkillDirectoryChange): void {
    if (
        Object.keys(change).sort().join(',') !== 'after,before,createdDirectories,kind,relative' ||
        !safeSkillDirectoryPath(change.relative) ||
        change.before !== null ||
        change.after !== 'directory' ||
        !Array.isArray(change.createdDirectories) ||
        !change.createdDirectories.length
    ) {
        throw new Error('Повреждён журнал создания папки скиллов.');
    }
    const parts = change.relative.split('/');
    const parents = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    const first = parents.indexOf(change.createdDirectories[0]);
    if (
        first < 0 ||
        change.createdDirectories.length !== parents.length - first ||
        change.createdDirectories.some((relative, index) => relative !== parents[first + index])
    ) {
        throw new Error('Повреждён список создаваемых папок скиллов.');
    }
}

export async function skillDirectoryState(absolute: string): Promise<'directory' | null> {
    try {
        const stat = await fs.lstat(absolute);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Путь папки скиллов занят другим типом файла.');
        }
        return 'directory';
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

/** Весь набор проверяется до первого rmdir; постороннее содержимое сохраняется вместе с журналом. */
export async function rollbackSkillDirectories(
    change: ISkillDirectoryChange,
    target: (relative: string) => Promise<string>,
    beforeRollback?: () => Promise<void>,
): Promise<void> {
    const planned = new Set(change.createdDirectories);
    for (const relative of change.createdDirectories) {
        const absolute = await target(relative);
        if ((await skillDirectoryState(absolute)) === null) {
            continue;
        }
        for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || !planned.has(relative + '/' + entry.name)) {
                throw new Error(
                    'После сбоя изменено содержимое папки ' +
                        relative +
                        '. Автоматический откат остановлен; журнал сохранён.',
                );
            }
        }
    }
    await beforeRollback?.();
    for (const relative of [...change.createdDirectories].reverse()) {
        const absolute = await target(relative);
        try {
            await fs.rmdir(absolute);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        await syncSkillDirectory(path.dirname(absolute));
    }
}
