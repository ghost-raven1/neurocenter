import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Pool } from 'pg';
import { backupError, backupFailure } from './backup-policy';
import type { BackupBudget } from './backup-storage';

export interface IPgLocation {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
}

export function parsePgUrl(value: string): IPgLocation {
    try {
        const url = new URL(value);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.slice(1)) {
            throw new Error('format');
        }
        return {
            host: url.hostname.replace(/^\[|\]$/g, '') || 'localhost',
            port: url.port || '5432',
            user: decodeURIComponent(url.username || 'postgres'),
            password: decodeURIComponent(url.password || ''),
            database: decodeURIComponent(url.pathname.slice(1)),
        };
    } catch {
        throw new Error('Некорректная строка подключения PostgreSQL');
    }
}

/** Отменяет только собственный pg_dump, в том числе после обрыва docker exec. */
async function cancelDump(location: IPgLocation, applicationName: string): Promise<void> {
    const pool = new Pool({
        ...location,
        port: Number(location.port),
        application_name: 'nc-backup-cancel',
        max: 1,
        connectionTimeoutMillis: 1000,
        query_timeout: 2000,
    });
    pool.on('error', () => undefined);
    try {
        await pool.query(
            'SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE application_name=$1 AND usename=current_user AND datname=$2 AND pid<>pg_backend_pid()',
            [applicationName, location.database],
        );
    } finally {
        await pool.end();
    }
}

/** Поток ограничен бюджетом до записи; неполный файл не получает окончательное имя. */
export async function runPgDump(
    location: IPgLocation,
    file: string,
    budget: BackupBudget,
    signal: AbortSignal,
): Promise<number> {
    const handle = await open(file, 'wx+', 0o600);
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<void> | undefined;
    let streamed: Promise<void> | undefined;
    let writing: Promise<void> | undefined;
    let failed = false;
    const application = 'nc-backup-' + randomUUID();
    try {
        signal.throwIfAborted();
        const container = ['localhost', '127.0.0.1', '::1'].includes(location.host)
            ? process.env.DEV_POSTGRES_CONTAINER
            : undefined;
        const arguments_ = [
            '-h',
            container ? '127.0.0.1' : location.host,
            '-p',
            container ? '5432' : location.port,
            '-U',
            location.user,
            '-d',
            location.database,
            '-Fc',
            '--lock-wait-timeout=5s',
        ];
        child = spawn(
            container ? 'docker' : 'pg_dump',
            container
                ? ['exec', '-e', 'PGPASSWORD', '-e', 'PGAPPNAME', container, 'pg_dump', ...arguments_]
                : arguments_,
            {
                env: { ...process.env, PGPASSWORD: location.password, PGAPPNAME: application },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        // stderr может содержать данные и реквизиты: осушаем поток, не возвращая его клиенту.
        child.stderr!.resume();
        closed = new Promise<void>((resolve, reject) => {
            child!.once('error', () =>
                reject(
                    backupFailure(
                        'BACKUP_PROCESS_FAILED',
                        'Не удалось запустить программу резервного копирования.',
                        503,
                    ),
                ),
            );
            child!.once('close', (code) =>
                code === 0
                    ? resolve()
                    : reject(
                          backupFailure(
                              'BACKUP_PROCESS_FAILED',
                              'PostgreSQL не подтвердил полный дамп. Предыдущие копии сохранены.',
                              503,
                          ),
                      ),
            );
        });
        let bytes = 0;
        const output = new Writable({
            write(chunk: Buffer, _encoding, done) {
                writing = (async () => {
                    bytes += chunk.length;
                    await budget.consume(chunk.length, bytes);
                    signal.throwIfAborted();
                    // FileHandle принадлежит этой функции: destroy потока не закроет его посреди записи.
                    for (let offset = 0; offset < chunk.length;) {
                        signal.throwIfAborted();
                        const written = await handle.write(chunk, offset, chunk.length - offset);
                        if (!written.bytesWritten) {
                            throw new Error('Файл не принимает данные');
                        }
                        offset += written.bytesWritten;
                    }
                })();
                void writing.then(() => done(), done);
            },
        });
        const aborted = (): void => {
            child?.kill('SIGTERM');
        };
        signal.addEventListener('abort', aborted, { once: true });
        try {
            streamed = pipeline(child.stdout!, output, { signal });
            await Promise.all([closed, streamed]);
        } finally {
            signal.removeEventListener('abort', aborted);
        }
        signal.throwIfAborted();
        if (bytes < 5) {
            throw new Error('Пустой дамп');
        }
        const header = Buffer.alloc(5);
        await handle.read(header, 0, 5, 0);
        if (header.toString() !== 'PGDMP') {
            throw new Error('Не подтверждён custom-формат PostgreSQL');
        }
        await handle.sync();
        return bytes;
    } catch (error) {
        failed = true;
        if (child) {
            child.kill('SIGTERM');
            const timer = setTimeout(() => child?.kill('SIGKILL'), 500);
            timer.unref();
            try {
                await Promise.allSettled([
                    closed,
                    streamed,
                    writing,
                    child.pid ? cancelDump(location, application) : undefined,
                ]);
            } finally {
                clearTimeout(timer);
            }
        }
        throw backupError(signal.aborted ? signal.reason : error);
    } finally {
        await handle.close();
        if (failed) {
            await rm(file, { force: true });
        }
    }
}
