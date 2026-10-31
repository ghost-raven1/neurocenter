import { BadRequestException, ConflictException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RAG_QUOTA_SCHEMA, RAG_QUOTA_MIGRATION, RAG_WRITE_LOCK } from './rag-quota-schema';

export interface IRagQuota {
    usedBytes: number;
    limitBytes: number;
    revision: number;
    maximumBytes: number;
    availableBytes: number;
}
export interface IRagQuotaPolicy {
    defaultBytes: number;
    maximumBytes: number;
}
export interface IRagQuotaUpdate {
    limitBytes: number;
    expectedRevision: number;
}
const GiB = 1024 ** 3;

/** Ноль не отключает защиту: неверная конфигурация прекращает запуск. */
export function ragQuotaPolicy(env: NodeJS.ProcessEnv = process.env): IRagQuotaPolicy {
    const read = (key: string, fallback: number): number => {
        const raw = env[key];
        if (raw !== undefined && !/^[1-9][0-9]*$/.test(raw)) {
            throw new Error('Некорректный ' + key);
        }
        const value = raw === undefined ? fallback : Number(raw);
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error('Некорректный ' + key);
        }
        return value;
    };
    const policy = {
        defaultBytes: read('RAG_DEFAULT_QUOTA_BYTES', GiB),
        maximumBytes: read('RAG_MAX_QUOTA_BYTES', 16 * GiB),
    };
    if (policy.defaultBytes > policy.maximumBytes) {
        throw new Error('RAG_DEFAULT_QUOTA_BYTES превышает RAG_MAX_QUOTA_BYTES');
    }
    return policy;
}

export function validateRagQuotaUpdate(value: unknown): asserts value is IRagQuotaUpdate {
    const input = value as Partial<IRagQuotaUpdate> | null;
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !Number.isSafeInteger(input.limitBytes) ||
        Number(input.limitBytes) <= 0 ||
        !Number.isSafeInteger(input.expectedRevision) ||
        Number(input.expectedRevision) < 0
    ) {
        throw new BadRequestException('Укажите положительный лимит в байтах и актуальную ревизию.');
    }
}

/** Защита остаётся в БД; неизвестный откат не возвращает незавершённую инициализацию в пул. */
export async function setupRagQuota(pool: Pool, policy: IRagQuotaPolicy): Promise<void> {
    const client = await pool.connect();
    let discard = false;
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(72465386)');
        await client.query(
            `CREATE TABLE IF NOT EXISTS neurocenter_rag_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        const checksum = createHash('sha256').update(RAG_QUOTA_SCHEMA).digest('hex');
        const found = await client.query<{ checksum: string }>(
            'SELECT checksum FROM neurocenter_rag_migrations WHERE version=$1',
            [RAG_QUOTA_MIGRATION],
        );
        if (found.rowCount && found.rows[0].checksum !== checksum) {
            throw new Error('Изменена применённая миграция квоты RAG');
        }
        if (!found.rowCount) {
            // Старые писатели не имеют advisory lock: блокировка таблицы закрывает окно переноса.
            await client.query('LOCK TABLE rag_chunks IN SHARE ROW EXCLUSIVE MODE');
        }
        await client.query('SELECT pg_advisory_xact_lock($1)', [RAG_WRITE_LOCK]);
        if (!found.rowCount) {
            await client.query(RAG_QUOTA_SCHEMA);
        }
        await client.query(
            `INSERT INTO rag_storage_settings(singleton,default_bytes,maximum_bytes) VALUES(true,$1,$2)
            ON CONFLICT(singleton) DO UPDATE SET default_bytes=EXCLUDED.default_bytes,maximum_bytes=EXCLUDED.maximum_bytes
            WHERE rag_storage_settings.default_bytes IS DISTINCT FROM EXCLUDED.default_bytes OR rag_storage_settings.maximum_bytes IS DISTINCT FROM EXCLUDED.maximum_bytes`,
            [policy.defaultBytes, policy.maximumBytes],
        );
        if (!found.rowCount) {
            await client.query(
                `INSERT INTO rag_storage_budget(project_key,used_bytes,limit_bytes)
                SELECT project_key,sum(public.neurocenter_rag_row_bytes(c)),GREATEST($1,sum(public.neurocenter_rag_row_bytes(c))) FROM rag_chunks c GROUP BY project_key`,
                [policy.defaultBytes],
            );
            await client.query('INSERT INTO neurocenter_rag_migrations(version,checksum) VALUES($1,$2)', [
                RAG_QUOTA_MIGRATION,
                checksum,
            ]);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {
            discard = true;
        });
        throw error;
    } finally {
        client.release(discard);
    }
}

function safeNumber(value: unknown): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new ServiceUnavailableException('Счётчик базы знаний требует проверки.');
    }
    return number;
}
async function readQuota(client: PoolClient, projectKey: string): Promise<IRagQuota> {
    await client.query('SELECT public.neurocenter_ensure_rag_budget($1)', [projectKey]);
    const { rows } = await client.query(
        `SELECT used_bytes,limit_bytes,revision,maximum_bytes FROM rag_storage_budget CROSS JOIN rag_storage_settings WHERE project_key=$1 AND singleton`,
        [projectKey],
    );
    if (!rows[0]) {
        throw new ServiceUnavailableException('Не удалось прочитать лимит базы знаний.');
    }
    const row = rows[0];
    const usedBytes = safeNumber(row.used_bytes);
    const limitBytes = safeNumber(row.limit_bytes);
    return {
        usedBytes,
        limitBytes,
        revision: safeNumber(row.revision),
        maximumBytes: safeNumber(row.maximum_bytes),
        availableBytes: Math.max(0, limitBytes - usedBytes),
    };
}

/** Перенос сохраняет знания; неизвестный откат не оставляет сессию с неподтверждённой бронью. */
export async function reserveLegacyRagQuota(pool: Pool, projectKey: string, bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error('Некорректный объём переноса знаний');
    }
    const client = await pool.connect();
    let discard = false;
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE rag_chunks IN ROW EXCLUSIVE MODE');
        await client.query('SELECT pg_advisory_xact_lock($1)', [RAG_WRITE_LOCK]);
        await client.query("SELECT set_config('neurocenter.rag_actor','system:legacy-rag-migration',true)");
        const quota = await readQuota(client, projectKey);
        if (bytes > quota.limitBytes) {
            if (quota.revision !== 0) {
                throw new ConflictException(
                    'Лимит изменён администратором. Проверьте его перед продолжением переноса знаний.',
                );
            }
            await client.query('UPDATE rag_storage_budget SET limit_bytes=$2 WHERE project_key=$1', [
                projectKey,
                bytes,
            ]);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {
            discard = true;
        });
        throw error;
    } finally {
        client.release(discard);
    }
}

/** Неизвестный откат не оставляет сессию, в которой следующее чтение могло бы зафиксировать прежнюю запись. */
export async function ragQuota(
    pool: Pool,
    projectKey: string,
    update?: IRagQuotaUpdate,
    actor = 'system:rag',
): Promise<IRagQuota> {
    if (update) {
        validateRagQuotaUpdate(update);
    }
    const client = await pool.connect();
    let discard = false;
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='10s'");
        await client.query('LOCK TABLE rag_chunks IN ROW EXCLUSIVE MODE');
        await client.query('SELECT pg_advisory_xact_lock($1)', [RAG_WRITE_LOCK]);
        let quota = await readQuota(client, projectKey);
        if (update && update.limitBytes !== quota.limitBytes) {
            if (update.expectedRevision !== quota.revision) {
                throw new ConflictException(
                    'Лимит уже изменён другим администратором. Обновите сведения и проверьте введённое значение.',
                );
            }
            if (update.limitBytes > quota.maximumBytes) {
                throw new BadRequestException('Лимит превышает разрешённый максимум сервера.');
            }
            if (update.limitBytes < quota.usedBytes) {
                throw new ConflictException(
                    'Новый лимит меньше объёма сохранённых знаний. Сначала уменьшите объём или выберите больший лимит.',
                );
            }
            await client.query("SELECT set_config('neurocenter.rag_actor',$1,true)", [actor]);
            await client.query(
                'UPDATE rag_storage_budget SET limit_bytes=$2,revision=revision+1 WHERE project_key=$1',
                [projectKey, update.limitBytes],
            );
            quota = await readQuota(client, projectKey);
        }
        await client.query('COMMIT');
        return quota;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {
            discard = true;
        });
        throw mapRagQuotaError(error);
    } finally {
        client.release(discard);
    }
}

/** Ошибка ограничения не теряет содержимое дельты: PostgreSQL откатывает весь пакет. */
export function mapRagQuotaError(error: unknown): unknown {
    const pg = error as { code?: string; constraint?: string; detail?: string };
    if (pg?.code === '23514' && pg.constraint === 'rag_storage_quota_limit') {
        let detail: Record<string, unknown> = {};
        try {
            const parsed = JSON.parse(pg.detail || '{}') as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                detail = parsed as Record<string, unknown>;
            }
        } catch {
            /* Детали БД не обязательны для безопасного отказа. */
        }
        const numbers = Object.fromEntries(
            ['attemptedBytes', 'limitBytes']
                .filter((key) => Number.isSafeInteger(detail[key]) && Number(detail[key]) >= 0)
                .map((key) => [key, detail[key]]),
        );
        return new HttpException(
            {
                statusCode: 413,
                code: 'RAG_QUOTA_EXCEEDED',
                message:
                    'Лимит базы знаний достигнут. Удалите ненужные фрагменты или попросите администратора проекта увеличить лимит. Весь пакет отменён, сохранённые знания не изменены.',
                ...numbers,
            },
            413,
        );
    }
    if (['55P03', '40P01'].includes(pg?.code || '')) {
        return new ServiceUnavailableException({
            code: 'RAG_BUSY',
            message: 'База знаний занята другой операцией. Повторите действие чуть позже.',
            retryAfterSeconds: 2,
        });
    }
    return error;
}
