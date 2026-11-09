import pg from 'pg';

/**
 * PG-счётчики pairing-окон device-channel (entry 9, AD-6).
 *
 * Счётчики общие для всех реплик gateway: таблица rate_limit_windows создаётся
 * catalog schema migration (DDL-owner = catalog service, инвариант 1.11), gateway
 * только пишет/читает её локальным read-write пулом (2-3 коннекции).
 *
 * Fail-closed (AD-19): любая ошибка PG (нет URL, PG down, таймаут) — бросаем,
 * вызыватель отвечает 503 фиксированным сообщением. Fail-открыт запрещён.
 */

export type TRateLimitScope = 'pair-start' | 'pair-poll' | 'pair-poll-code';

/** Лимиты окон (записаны в route-policy-строку /api/device-channel/* и nginx-инварианты). */
export const RATE_LIMIT_MAX: Record<TRateLimitScope, number> = {
    'pair-start': 15,
    'pair-poll': 6000,
    'pair-poll-code': 60,
};

/** Окно 60s, зафиксированное SQL'ем (window_start = date_trunc('minute', now())). */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Один параметризованный запрос: purge устаревших окон + атомарный upsert текущего
 * (count+1). CTE-DELETE и INSERT — одна транзакция-заявление: гонки между репликами
 * разрешает ON CONFLICT на первичном ключе (scope, key, window_start).
 */
const RECORD_SQL = `
    WITH purge AS (
        DELETE FROM rate_limit_windows
        WHERE window_start < date_trunc('minute', now()) - interval '1 minute'
    )
    INSERT INTO rate_limit_windows (scope, key, window_start, count)
    VALUES ($1, $2, date_trunc('minute', now()), 1)
    ON CONFLICT (scope, key, window_start) DO UPDATE
        SET count = rate_limit_windows.count + 1
    RETURNING count
`;

export class RateLimitStore {
    private pool: pg.Pool | null = null;

    constructor(private readonly connectionString: string | undefined) {}

    private get poolInstance(): pg.Pool {
        if (!this.connectionString) {
            throw new Error('rate-limit-store: CATALOG_PG_URL не задан (fail-closed, AD-19).');
        }
        if (!this.pool) {
            this.pool = new pg.Pool({
                connectionString: this.connectionString,
                max: 3,
                connectionTimeoutMillis: 2000,
            });
        }
        return this.pool;
    }

    /** Атомарно увеличивает счётчик окна; true, если лимит scope превышен. Ошибки PG — бросок (503 у вызывателя). */
    async record(scope: TRateLimitScope, key: string): Promise<boolean> {
        const maximum = RATE_LIMIT_MAX[scope];
        if (maximum === undefined) {
            throw new Error('rate-limit-store: неизвестный scope: ' + String(scope));
        }
        if (typeof key !== 'string' || key.length === 0) {
            throw new Error('rate-limit-store: key обязан быть непустой строкой.');
        }
        const client = await this.poolInstance.connect();
        try {
            const result = await client.query(RECORD_SQL, [scope, key]);
            const count: number = Number(result.rows[0].count);
            return count > maximum;
        } finally {
            client.release();
        }
    }

    /** Закрытие пула (NestJS onModuleDestroy / тесты). */
    async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
}
