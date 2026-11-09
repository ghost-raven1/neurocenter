import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_LOCK_TTL_MS } from '../backup-policy';
import {
    BACKUP_LOCK,
    BACKUP_LOCK_HEARTBEAT,
    BACKUP_LOCK_OWNER,
    backupLock,
    type IBackupLockStaleInfo,
} from '../backup-storage';

const now = () => Date.now();
const past = (ms: number) => new Date(now() - ms);

/** Ставит лок-каталог с заданными возрастами лока и heartbeat (имитация мёртвого/живого владельца). */
async function plantLock(
    root: string,
    ages: { lockAgeMs: number; heartbeatAgeMs: number; owner?: string },
): Promise<string> {
    const directory = path.join(root, BACKUP_LOCK);
    await mkdir(directory, { mode: 0o700 });
    const owner = ages.owner ?? 'dead-owner';
    await writeFile(path.join(directory, BACKUP_LOCK_OWNER), owner, { mode: 0o600 });
    const beatTime = past(ages.heartbeatAgeMs);
    await writeFile(path.join(directory, BACKUP_LOCK_HEARTBEAT), beatTime.toISOString(), { mode: 0o600 });
    await utimes(path.join(directory, BACKUP_LOCK_HEARTBEAT), beatTime, beatTime);
    // mtime каталога = возраст лока; ставится последним, чтобы не сбилось добавление файлов.
    const lockTime = past(ages.lockAgeMs);
    await utimes(directory, lockTime, lockTime);
    return directory;
}

async function exists(filename: string): Promise<boolean> {
    try {
        await stat(filename);
        return true;
    } catch {
        return false;
    }
}

/** Возвращает ошибку acquire, если он отклонён, иначе null. */
async function acquireError(root: string, options?: Parameters<typeof backupLock>[1]): Promise<unknown> {
    try {
        await backupLock(root, options);
        return null;
    } catch (error) {
        return error;
    }
}

function expectBusy(error: unknown): void {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({ statusCode: 409, code: 'BACKUP_BUSY' });
}

describe('backupLock: TTL + auto-release по heartbeat (AD-D3)', () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'nc-backup-lock-'));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('живой лок (свежий heartbeat) → BACKUP_BUSY 409, лок не трогается', async () => {
        await plantLock(root, { lockAgeMs: 1000, heartbeatAgeMs: 1000, owner: 'live-owner' });
        const error = await acquireError(root);
        expectBusy(error);
        // Лок не удалён: owner и heartbeat на месте.
        expect(await readFile(path.join(root, BACKUP_LOCK, BACKUP_LOCK_OWNER), 'utf8')).toBe('live-owner');
        expect(await exists(path.join(root, BACKUP_LOCK, BACKUP_LOCK_HEARTBEAT))).toBe(true);
    });

    it('stale-лок (лока и heartbeat старше TTL) → снят, acquire успешен, событие записано', async () => {
        const stale: IBackupLockStaleInfo[] = [];
        await plantLock(root, {
            lockAgeMs: BACKUP_LOCK_TTL_MS + 60_000,
            heartbeatAgeMs: BACKUP_LOCK_TTL_MS + 60_000,
            owner: 'dead-owner',
        });
        const release = await backupLock(root, { onStaleRemoval: (info) => stale.push(info) });
        expect(stale).toHaveLength(1);
        expect(stale[0].owner).toBe('dead-owner');
        expect(stale[0].lockAgeMs).toBeGreaterThan(BACKUP_LOCK_TTL_MS);
        expect(stale[0].heartbeatAgeMs).toBeGreaterThan(BACKUP_LOCK_TTL_MS);
        // Лок теперь наш: owner не dead-owner, heartbeat создан.
        const owner = await readFile(path.join(root, BACKUP_LOCK, BACKUP_LOCK_OWNER), 'utf8');
        expect(owner).not.toBe('dead-owner');
        expect(await exists(path.join(root, BACKUP_LOCK, BACKUP_LOCK_HEARTBEAT))).toBe(true);
        // Release чистит лок (owner-check).
        await release();
        expect(await exists(path.join(root, BACKUP_LOCK))).toBe(false);
    });

    it('kill -9 (heartbeat есть, но не обновлялся) → следующий бэкап после TTL стартует без вмешательства', async () => {
        // Мёртвый владелец оставил owner + heartbeat давней меткой.
        await plantLock(root, {
            lockAgeMs: BACKUP_LOCK_TTL_MS + 120_000,
            heartbeatAgeMs: BACKUP_LOCK_TTL_MS + 120_000,
            owner: 'crashed-pid-4242',
        });
        const release = await backupLock(root);
        const owner = await readFile(path.join(root, BACKUP_LOCK, BACKUP_LOCK_OWNER), 'utf8');
        expect(owner).not.toBe('crashed-pid-4242');
        await release();
        expect(await exists(path.join(root, BACKUP_LOCK))).toBe(false);
    });

    it('долгий живой бэкап (лока старше TTL, heartbeat свежий) → не снимается, BACKUP_BUSY', async () => {
        await plantLock(root, {
            lockAgeMs: BACKUP_LOCK_TTL_MS + 60_000,
            heartbeatAgeMs: 1000,
            owner: 'long-live',
        });
        const error = await acquireError(root);
        expectBusy(error);
        // Лок живого владельца не удалён.
        expect(await readFile(path.join(root, BACKUP_LOCK, BACKUP_LOCK_OWNER), 'utf8')).toBe('long-live');
    });

    it('только одно условие (свежая лока, старый heartbeat) → не stale, BACKUP_BUSY', async () => {
        await plantLock(root, {
            lockAgeMs: 1000,
            heartbeatAgeMs: BACKUP_LOCK_TTL_MS + 60_000,
            owner: 'x',
        });
        const error = await acquireError(root);
        expectBusy(error);
        expect(await readFile(path.join(root, BACKUP_LOCK, BACKUP_LOCK_OWNER), 'utf8')).toBe('x');
    });

    it('нормальный бэкап: acquire → heartbeat пишется → release чист (owner-check)', async () => {
        const release = await backupLock(root);
        const heartbeatFile = path.join(root, BACKUP_LOCK, BACKUP_LOCK_HEARTBEAT);
        expect(await exists(heartbeatFile)).toBe(true);
        const stamp = Date.parse((await readFile(heartbeatFile, 'utf8')).trim());
        expect(Number.isFinite(stamp)).toBe(true);
        expect(now() - stamp).toBeLessThan(BACKUP_LOCK_TTL_MS);
        await release();
        expect(await exists(path.join(root, BACKUP_LOCK))).toBe(false);
        // После release следующий acquire проходит.
        const release2 = await backupLock(root);
        await release2();
        expect(await exists(path.join(root, BACKUP_LOCK))).toBe(false);
    });

    it('гонка: два acquire на stale-локе → ровно один успех, другой BACKUP_BUSY', async () => {
        await plantLock(root, {
            lockAgeMs: BACKUP_LOCK_TTL_MS + 60_000,
            heartbeatAgeMs: BACKUP_LOCK_TTL_MS + 60_000,
            owner: 'dead',
        });
        const results = await Promise.allSettled([backupLock(root), backupLock(root)]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expectBusy((rejected[0] as PromiseRejectedResult).reason);
        // Побеждающий владеет локом; чистим.
        await (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>).value();
        expect(await exists(path.join(root, BACKUP_LOCK))).toBe(false);
    });

    it('stale-лок без callback снимается через лог сервиса (по умолчанию) без ошибки', async () => {
        await plantLock(root, {
            lockAgeMs: BACKUP_LOCK_TTL_MS + 60_000,
            heartbeatAgeMs: BACKUP_LOCK_TTL_MS + 60_000,
            owner: 'dead-no-callback',
        });
        const release = await backupLock(root);
        expect(await exists(path.join(root, BACKUP_LOCK))).toBe(true);
        await release();
        expect(await exists(path.join(root, BACKUP_LOCK))).toBe(false);
    });

    it('release не удаляет чужой лок (owner-check сохраняется)', async () => {
        const release = await backupLock(root);
        // Имитируем подмену владельца посторонним процессом.
        await writeFile(path.join(root, BACKUP_LOCK, BACKUP_LOCK_OWNER), 'intruder', { mode: 0o600 });
        await expect(release()).rejects.toThrow('Владелец блокировки копии изменён');
        // Лок не удалён после отказа release.
        expect(await exists(path.join(root, BACKUP_LOCK))).toBe(true);
        // Ручная очистка для afterEach.
        await rm(path.join(root, BACKUP_LOCK), { recursive: true, force: true });
    });
});
