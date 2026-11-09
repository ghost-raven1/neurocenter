import { lstat, mkdir, opendir, open, readFile, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { BACKUP_LOCK_HEARTBEAT_MS, BACKUP_LOCK_TTL_MS, backupFailure, type IBackupPolicy } from './backup-policy';
import { reserveCapacity } from '../../../shared/capacity.cjs';

export const BACKUP_LOCK = '.neurocenter-backup.lock';
export const BACKUP_LOCK_OWNER = 'owner';
export const BACKUP_LOCK_HEARTBEAT = 'heartbeat';
const backupLockLogger = new Logger('BackupLock');

/** Проверяет каждый подкаталог, не переходя по ссылкам внутри управляемого корня. */
export async function backupDirectories(root: string, directory: string): Promise<{ root: string; directory: string }> {
    root = path.resolve(root);
    directory = path.resolve(directory);
    const relative = path.relative(root, directory);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Каталог копии вне управляемого корня');
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const check = async (filename: string): Promise<void> => {
        const info = await lstat(filename);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error('Нужен обычный каталог копий');
        }
    };
    await check(root);
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        await mkdir(current, { mode: 0o700 }).catch((error) => {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        });
        await check(current);
    }
    return { root: await realpath(root), directory: await realpath(directory) };
}

/** Данные stale-события: владелец и возраст лока/heartbeat в момент снятия. */
export interface IBackupLockStaleInfo {
    owner: string;
    lockAgeMs: number;
    heartbeatAgeMs: number;
}
export interface IBackupLockOptions {
    /** Канал наблюдаемости снятия stale-лока; по умолчанию пишется в лог сервиса. */
    onStaleRemoval?: (info: IBackupLockStaleInfo) => void | Promise<void>;
}

const backupBusy = () =>
    backupFailure(
        'BACKUP_BUSY',
        'Уже выполняется резервное копирование. Дождитесь завершения и обновите список. Если сообщение остаётся после перезапуска, обратитесь к администратору.',
        409,
    );

/** Возраст heartbeat: время с последнего обновления. Отсутствует файл → Infinity (владелец не жил). */
async function backupLockHeartbeatAge(directory: string): Promise<number> {
    const filename = path.join(directory, BACKUP_LOCK_HEARTBEAT);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(filename);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return Infinity;
        }
        throw error;
    }
    // Содержимое — ISO-mетка владельца; по mtime не зависим от повреждённого файла.
    try {
        const parsed = Date.parse((await readFile(filename, 'utf8')).trim());
        if (Number.isFinite(parsed)) {
            return Math.max(0, Date.now() - parsed);
        }
    } catch {
        /* повреждённое содержимое — возраст по mtime ниже */
    }
    return Math.max(0, Date.now() - info.mtimeMs);
}

/**
 * Снимает stale-лок: только если лока И heartbeat старше TTL (живой владелец
 * обновляет heartbeat, долгий бэкап не снимается). Снятый каталог сначала
 * атомарно переименовывают, поэтому свежий чужой лок не удалится.
 * true — путь свободен (лок снят или уже отсутствовал), false — лок жив.
 */
async function backupLockRemoveStale(directory: string, options: IBackupLockOptions): Promise<boolean> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return true;
        }
        throw error;
    }
    const lockAgeMs = Math.max(0, Date.now() - info.mtimeMs);
    const heartbeatAgeMs = await backupLockHeartbeatAge(directory);
    if (lockAgeMs <= BACKUP_LOCK_TTL_MS || heartbeatAgeMs <= BACKUP_LOCK_TTL_MS) {
        return false;
    }
    let owner = '<неизвестно>';
    try {
        owner = (await readFile(path.join(directory, BACKUP_LOCK_OWNER), 'utf8')).trim() || '<пусто>';
    } catch {
        /* owner-файла нет — удаление всё равно оправдано условиями выше */
    }
    const tomb = `${directory}.stale-${randomUUID()}`;
    try {
        await rename(directory, tomb);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return true;
        }
        throw error;
    }
    await rm(tomb, { recursive: true, force: true });
    const stale: IBackupLockStaleInfo = { owner, lockAgeMs, heartbeatAgeMs };
    backupLockLogger.warn(
        `Снята протухшая блокировка копий: owner=${owner} lockAgeMs=${lockAgeMs} heartbeatAgeMs=${heartbeatAgeMs}`,
    );
    if (options.onStaleRemoval) {
        await options.onStaleRemoval(stale);
    }
    return true;
}

/**
 * Файловая блокировка между процессами с лизой: владелец пишет heartbeat
 * каждые BACKUP_LOCK_HEARTBEAT_MS, после крэша протухший лок снимается
 * автоматически (TTL). Release — с проверкой владельца.
 */
export async function backupLock(root: string, options: IBackupLockOptions = {}): Promise<() => Promise<void>> {
    const directory = path.join(root, BACKUP_LOCK);
    const owner = randomUUID();
    const beat = (): Promise<void> =>
        writeFile(path.join(directory, BACKUP_LOCK_HEARTBEAT), new Date().toISOString(), { mode: 0o600 });
    try {
        await mkdir(directory, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
        // EEXIST: лок либо жив (BACKUP_BUSY), либо протух после крэша (одна попытка).
        if (!(await backupLockRemoveStale(directory, options))) {
            throw backupBusy();
        }
        try {
            await mkdir(directory, { mode: 0o700 });
        } catch (retry) {
            if ((retry as NodeJS.ErrnoException).code === 'EEXIST') {
                throw backupBusy();
            }
            throw retry;
        }
    }
    let heartbeat: NodeJS.Timeout | undefined;
    try {
        await writeFile(path.join(directory, BACKUP_LOCK_OWNER), owner, { flag: 'wx', mode: 0o600 });
        await beat();
        heartbeat = setInterval(() => void beat().catch(() => undefined), BACKUP_LOCK_HEARTBEAT_MS);
        heartbeat.unref();
    } catch (error) {
        if (heartbeat) {
            clearInterval(heartbeat);
        }
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    // Посторонняя замена lock не даёт удалить чужую блокировку.
    let released = false;
    return async () => {
        if (released) {
            return;
        }
        released = true;
        clearInterval(heartbeat);
        if ((await readFile(path.join(directory, BACKUP_LOCK_OWNER), 'utf8')) !== owner) {
            throw new Error('Владелец блокировки копии изменён');
        }
        await rm(directory, { recursive: true });
    };
}

/** Считает также старые/неучтённые файлы и partial; квота не уменьшается из-за отсутствия строки БД. */
export async function backupUsage(root: string, signal?: AbortSignal): Promise<number> {
    let bytes = 0;
    let entries = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > 16) {
            throw new Error('Слишком глубокий каталог копий');
        }
        const stream = await opendir(directory);
        for await (const entry of stream) {
            signal?.throwIfAborted();
            if (directory === root && entry.name === BACKUP_LOCK) {
                continue;
            }
            if (++entries > 100_000) {
                throw new Error('Слишком много файлов копий');
            }
            const filename = path.join(directory, entry.name);
            const info = await lstat(filename);
            if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
                throw new Error('Ссылки и специальные файлы в каталоге копий запрещены');
            }
            if (info.isDirectory()) {
                await walk(filename, depth + 1);
            } else {
                bytes += info.size;
                if (!Number.isSafeInteger(bytes)) {
                    throw new Error('Объём копий требует проверки');
                }
            }
        }
    };
    await walk(root, 0);
    return bytes;
}

/** Проверка свободного места не заменяет квоту файловой системы при посторонних писателях. */
export async function backupFreeSpace(directory: string, minimum: number, nextBytes = 0): Promise<void> {
    if (nextBytes > 0 && process.env.CAPACITY_REQUIRED === 'true') {
        const release = await reserveCapacity({ resource: 'backups', bytes: nextBytes, path: directory });
        release();
    }
    const disk = await statfs(directory, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(minimum) + BigInt(nextBytes)) {
        throw backupFailure(
            'BACKUP_DISK_FULL',
            'Недостаточно свободного места с учётом резерва диска. Предыдущие копии сохранены. Попросите администратора освободить место.',
        );
    }
}

export class BackupBudget {
    constructor(
        private readonly directory: string,
        private readonly policy: IBackupPolicy,
        private usedBytes: number,
    ) {
        if (usedBytes >= policy.maxTotalBytes) {
            throw backupFailure(
                'BACKUP_QUOTA_EXCEEDED',
                'Хранилище копий заполнено. Предыдущие копии сохранены. Попросите администратора увеличить лимит или перенести старые копии.',
            );
        }
    }
    async consume(bytes: number, fileBytes: number): Promise<void> {
        if (fileBytes > this.policy.maxFileBytes || this.usedBytes + bytes > this.policy.maxTotalBytes) {
            throw backupFailure(
                'BACKUP_QUOTA_EXCEEDED',
                'Достигнут лимит размера файла или общего хранилища копий. Предыдущие копии сохранены. Попросите администратора увеличить лимит или перенести старые копии.',
            );
        }
        await backupFreeSpace(this.directory, this.policy.minFreeBytes, bytes);
        this.usedBytes += bytes;
    }
}

/** Синхронизирует имя после публикации; отказ не объявляется подтверждённой копией. */
export async function syncBackupDirectory(directory: string): Promise<void> {
    const handle = await open(directory, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}
