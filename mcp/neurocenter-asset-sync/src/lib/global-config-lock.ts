import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readBoundedSnapshot } from '../bridge/read-bounded.js';

export const globalConfigLockPath = (destination: string): string =>
    path.join(
        path.dirname(destination),
        '.neurocenter-config-' + createHash('sha256').update(destination).digest('hex').slice(0, 24) + '.lock',
    );
const occupied = (lock: string) =>
    new Error('Конфигурацию OpenCode уже регистрирует другой установщик. Повторите попытку; блокировка: ' + lock);
const collision = (error: unknown) =>
    ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
const sameDirectory = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
    a.dev === b.dev && a.ino === b.ino;

async function removeEmpty(lock: string): Promise<void> {
    try {
        await fs.rmdir(lock);
    } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
}

/** Удаляется только уникальная запись доказанно умершего владельца; новый непустой lock переживает rmdir. */
async function reclaim(lock: string): Promise<void> {
    const before = await fs.lstat(lock).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    });
    if (!before) return;
    if (!before.isDirectory() || before.isSymbolicLink()) throw occupied(lock);
    const files = await fs.readdir(lock);
    if (!files.length) {
        await removeEmpty(lock);
        return;
    }
    if (files.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(files[0]!)) throw occupied(lock);
    const ownerPath = path.join(lock, files[0]!);
    const original = await readBoundedSnapshot(ownerPath, 4096);
    let owner: { host?: unknown; pid?: unknown; token?: unknown };
    try {
        owner = JSON.parse(original.bytes.toString('utf8'));
    } catch {
        throw occupied(lock);
    }
    if (
        !owner ||
        owner.host !== os.hostname() ||
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) < 1 ||
        typeof owner.token !== 'string' ||
        files[0] !== `owner-${owner.token}.json`
    )
        throw occupied(lock);
    try {
        process.kill(Number(owner.pid), 0);
        throw occupied(lock);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw occupied(lock);
    }
    const current = await readBoundedSnapshot(ownerPath, 4096).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    });
    if (!current) return;
    const located = await fs.lstat(lock);
    if (
        !located.isDirectory() ||
        located.isSymbolicLink() ||
        !sameDirectory(before, located) ||
        current.fingerprint !== original.fingerprint ||
        !current.bytes.equals(original.bytes)
    )
        throw occupied(lock);
    await fs.unlink(ownerPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await removeEmpty(lock);
}

/** Непустая directory публикуется целиком; SIGKILL не оставляет вечную вторую recovery-блокировку. */
export async function withGlobalConfigLock<T>(destination: string, action: () => Promise<T>): Promise<T> {
    const lock = globalConfigLockPath(destination),
        token = randomUUID(),
        name = `owner-${token}.json`;
    const candidate = lock + '.' + token + '.candidate';
    let acquired = false;
    await fs.mkdir(candidate, { mode: 0o700 });
    try {
        await fs.writeFile(
            path.join(candidate, name),
            JSON.stringify({ host: os.hostname(), pid: process.pid, token }),
            { flag: 'wx', mode: 0o600 },
        );
        try {
            await fs.rename(candidate, lock);
            acquired = true;
        } catch (error) {
            if (!collision(error)) throw error;
            await reclaim(lock);
            try {
                await fs.rename(candidate, lock);
                acquired = true;
            } catch (retry) {
                if (collision(retry)) throw occupied(lock);
                throw retry;
            }
        }
        return await action();
    } finally {
        if (acquired) {
            await fs.unlink(path.join(lock, name)).catch((error) => {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            });
            await removeEmpty(lock);
        }
        await fs.rm(candidate, { recursive: true, force: true });
    }
}
