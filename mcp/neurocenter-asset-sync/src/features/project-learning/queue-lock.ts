import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const LEARNING_QUEUE_MUTEX = '.queue-mutex.sqlite';
export const learningQueueLockFile = (name: string) =>
    [
        LEARNING_QUEUE_MUTEX,
        LEARNING_QUEUE_MUTEX + '-journal',
        LEARNING_QUEUE_MUTEX + '-wal',
        LEARNING_QUEUE_MUTEX + '-shm',
    ].includes(name);
interface MutexDatabase {
    exec(sql: string): unknown;
    close(): void;
}
type MutexConstructor = new (file: string, options?: { create: boolean }) => MutexDatabase;
let constructor: Promise<MutexConstructor> | undefined;
const prepared = new Map<string, Promise<{ ino: number; dev: number }>>();
const damaged = () => new Error('Блокировка приватной очереди наблюдений недоступна.');
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
const busy = (error: unknown) => {
    const value = error as { code?: string; errcode?: number };
    return value.code === 'SQLITE_BUSY' || value.code === 'SQLITE_LOCKED' || value.errcode === 5 || value.errcode === 6;
};

/** Node and the pinned OpenCode/Bun use their own builtin SQLite against the same kernel lock. */
async function openDatabase(file: string): Promise<MutexDatabase> {
    constructor ??= (async () => {
        const bun = !!(process.versions as Record<string, string | undefined>).bun;
        const moduleName = bun ? 'bun:sqlite' : 'node:sqlite';
        const sqlite = (await import(moduleName)) as { Database?: MutexConstructor; DatabaseSync?: MutexConstructor };
        const selected = bun ? sqlite.Database : sqlite.DatabaseSync;
        if (!selected) throw damaged();
        return selected;
    })();
    const Database = await constructor;
    return new Database(file, { create: true });
}

async function privateDatabase(file: string): Promise<void> {
    let initialization = prepared.get(file);
    if (!initialization) {
        initialization = (async () => {
            try {
                const handle = await fs.open(
                    file,
                    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
                    0o600,
                );
                await handle.close();
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            const stat = await fs.lstat(file);
            return { ino: stat.ino, dev: stat.dev };
        })().catch((error) => {
            prepared.delete(file);
            throw error;
        });
        prepared.set(file, initialization);
    }
    const expected = await initialization,
        located = await fs.lstat(file);
    // Do not open/close an extra descriptor for an existing SQLite inode: POSIX would release this process's locks.
    if (
        !located.isFile() ||
        located.isSymbolicLink() ||
        located.ino !== expected.ino ||
        located.dev !== expected.dev ||
        located.size > 128 * 1024 ||
        (process.platform !== 'win32' &&
            ((located.mode & 0o077) !== 0 ||
                (typeof process.getuid === 'function' && located.uid !== process.getuid())))
    )
        throw damaged();
}

/** BEGIN IMMEDIATE is mutually exclusive across Node/Bun processes; the kernel releases it on crash or PID reuse.
 * The persistent database is never unlinked for recovery. Busy attempts close before asynchronously waiting,
 * so a second caller cannot block the event loop of an owner awaiting a filesystem operation. */
export async function withLearningQueueLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
    const file = path.join(directory, LEARNING_QUEUE_MUTEX);
    await privateDatabase(file);
    const deadline = Date.now() + 5000;
    while (true) {
        const db = await openDatabase(file);
        let acquired = false;
        try {
            db.exec('PRAGMA busy_timeout=0');
            try {
                db.exec('BEGIN IMMEDIATE');
                acquired = true;
            } catch (error) {
                if (!busy(error)) throw error;
            }
            if (acquired) {
                try {
                    const result = await action();
                    // A BUSY COMMIT retains the transaction: retry it, never the filesystem action.
                    while (true) {
                        try {
                            db.exec('COMMIT');
                            acquired = false;
                            return result;
                        } catch (error) {
                            if (!busy(error) || Date.now() >= deadline) throw error;
                            await pause();
                        }
                    }
                } finally {
                    if (acquired) {
                        try {
                            db.exec('ROLLBACK');
                        } catch {
                            /* Closing releases the lock without hiding the primary failure. */
                        }
                    }
                }
            }
        } finally {
            db.close();
        }
        if (Date.now() >= deadline) throw damaged();
        await pause();
    }
}
