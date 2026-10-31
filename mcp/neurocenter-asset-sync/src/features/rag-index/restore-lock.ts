import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { safeTarget } from '../../bridge/workspace-paths.js';

const dead = (pid: unknown) => {
    if (!Number.isSafeInteger(pid) || Number(pid) < 1) {
        return false;
    }
    try {
        process.kill(Number(pid), 0);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
};
/** Только собственный аварийный restore-lock восстанавливается под тем же recovery guard, что и у native. */
async function recoverOwn(file: string): Promise<void> {
    const recovery = file + '.recovery';
    try {
        await fs.mkdir(recovery);
    } catch {
        throw new Error('Блокировку индекса уже восстанавливает другой процесс. Повторите позже.');
    }
    try {
        const stat = await fs.lstat(file);
        const bytes = await readBoundedUtf8(file, 1024);
        const value = JSON.parse(bytes) as { pid?: unknown; neurocenterRestore?: unknown; startedAt?: unknown };
        if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            !dead(value.pid) ||
            typeof value.neurocenterRestore !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(value.neurocenterRestore)
        ) {
            return;
        }
        const current = await fs.lstat(file);
        if (current.ino === stat.ino && current.dev === stat.dev && (await readBoundedUtf8(file, 1024)) === bytes) {
            await fs.unlink(file);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
            throw error;
        }
    } finally {
        await fs.rmdir(recovery);
    }
}
/** Резервирует native index.lock; чужую, даже устаревшую блокировку не удаляет. */
export async function reserveRestoreIndex(root: string, storePath: string) {
    await safeTarget(root, path.relative(root, storePath).split(path.sep).join('/'));
    await fs.mkdir(storePath, { recursive: true });
    const raw = JSON.stringify({ pid: process.pid, startedAt: Date.now(), neurocenterRestore: randomUUID() });
    const locations = new Set([storePath]);
    const place = async (directory: string) => {
        const file = path.join(directory, 'index.lock');
        const claim = () => fs.writeFile(file, raw, { flag: 'wx', mode: 0o600 });
        try {
            await claim();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            await recoverOwn(file);
            try {
                await claim();
            } catch {
                throw new Error('Индекс уже заблокирован. Закройте OpenCode и дождитесь завершения другой операции.');
            }
        }
        locations.add(directory);
    };
    await place(storePath);
    const assert = async (directory = storePath) => {
        if ((await readBoundedUtf8(path.join(directory, 'index.lock'), 1024)) !== raw) {
            throw new Error('Блокировка индекса изменилась. Восстановление остановлено.');
        }
    };
    const release = async () => {
        for (const directory of locations) {
            try {
                if ((await readBoundedUtf8(path.join(directory, 'index.lock'), 1024)) === raw) {
                    await fs.unlink(path.join(directory, 'index.lock'));
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }
    };
    return {
        raw,
        place,
        assert,
        release,
        track: (directory: string) => {
            locations.add(directory);
        },
    };
}
