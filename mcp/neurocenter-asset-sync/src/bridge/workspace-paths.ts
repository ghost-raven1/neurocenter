import fs from 'node:fs/promises';
import path from 'node:path';
import type { PhysicalDirectory } from './workspace-instance.model.js';

/** Путь и inode проверяются вместе: новый каталог по прежнему адресу не получает старую идентичность. */
export async function workspaceDirectory(folder: string): Promise<{ realpath: string; physical: PhysicalDirectory }> {
    try {
        const realpath = await fs.realpath(folder);
        const stat = await fs.lstat(folder, { bigint: true });
        if (!stat.isDirectory() || realpath !== path.resolve(folder) || stat.ino <= 0n) {
            throw new Error('Папка проекта недоступна или заменена симлинком.');
        }
        return {
            realpath,
            physical: { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() },
        };
    } catch (error) {
        throw Object.assign(new Error('Папка проекта недоступна или заменена.'), {
            code: (error as NodeJS.ErrnoException).code,
        });
    }
}

/** Любой промежуточный симлинк отклоняется; проверка повторяется перед записью. */
export async function safeTarget(root: string, relative: string): Promise<string> {
    if (
        !relative ||
        relative.includes('\\') ||
        path.isAbsolute(relative) ||
        relative
            .split('/')
            .some((part) => !part || part === '.' || part === '..' || part.includes(':') || part.includes('\0'))
    ) {
        throw new Error('Недопустимый путь пакета.');
    }
    let current = await fs.realpath(root);
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) {
                throw new Error('Путь содержит симлинк: ' + relative);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }
    return current;
}
