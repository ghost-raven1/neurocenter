import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { authorizeAccessWrite } from '../access/access-write-policy';
import {
    DEFAULT_MODEL_RATE_LIMIT,
    type ModelRateAdmission,
    type ModelRateLimitInput,
    type ModelRateLimitPolicy,
} from './model-rate-limits.types';
import { modelRateBeforeAttempt } from './model-rate-limits.wait';
import { modelRateCheckout, modelRateClient } from './model-rate-limits.client';

interface PolicyRow {
    model_id: string;
    revision: string | number;
    requests: number;
    window_ms: number;
    enabled: boolean;
    updated_at: Date | string;
    updated_by: string;
}
const policy = (id: string, row?: PolicyRow): ModelRateLimitPolicy =>
    row
        ? {
              modelId: id,
              revision: Number(row.revision),
              requests: row.requests,
              windowMs: row.window_ms,
              enabled: row.enabled,
              updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
              updatedBy: row.updated_by,
          }
        : { modelId: id, ...DEFAULT_MODEL_RATE_LIMIT };
export const rateStoreUnavailable = () =>
    new ServiceUnavailableException({
        statusCode: 503,
        code: 'MODEL_RATE_STORE_UNAVAILABLE',
        message: 'Не удалось проверить лимит модели. Запрос провайдеру не отправлен; повторите позже.',
    });
export const ratePolicySaveUnconfirmed = () =>
    new ServiceUnavailableException({
        statusCode: 503,
        code: 'MODEL_RATE_POLICY_SAVE_UNCONFIRMED',
        message:
            'Не удалось подтвердить сохранение лимита. Обновите сведения и проверьте результат перед повторным сохранением.',
    });

/** One nonblocking transaction admits one physical call across all catalog replicas. */
export class ModelRateLimitsRepository {
    constructor(readonly pool: Pool) {}
    async read(id: string): Promise<ModelRateLimitPolicy> {
        return policy(
            id,
            (await this.pool.query<PolicyRow>('SELECT * FROM model_api_rate_limits WHERE model_id=$1', [id])).rows[0],
        );
    }
    private async lock(db: PoolClient, id: string): Promise<boolean> {
        return (
            await db.query<{ locked: boolean }>(
                "SELECT pg_try_advisory_xact_lock(hashtextextended('neurocenter:model-api-rate:'||$1,0)) AS locked",
                [id],
            )
        ).rows[0].locked;
    }
    async tryAcquire(
        id: string,
        signal?: AbortSignal,
        beforeAttempt?: () => Promise<boolean | void>,
    ): Promise<ModelRateAdmission> {
        const db = await modelRateCheckout(this.pool, signal),
            client = modelRateClient(db, signal);
        let begun = false;
        try {
            signal?.throwIfAborted();
            const enforcement = beforeAttempt ? await modelRateBeforeAttempt(beforeAttempt, signal) : undefined;
            signal?.throwIfAborted();
            if (enforcement === false) return { admitted: true, retryAfterMs: 0 };
            await db.query('BEGIN');
            begun = true;
            signal?.throwIfAborted();
            if (!(await this.lock(db, id))) {
                await db.query('ROLLBACK');
                begun = false;
                return { admitted: false, retryAfterMs: 15 };
            }
            signal?.throwIfAborted();
            const current = policy(
                id,
                (await db.query<PolicyRow>('SELECT * FROM model_api_rate_limits WHERE model_id=$1', [id])).rows[0],
            );
            const clock = (await db.query<{ instant: string }>('SELECT clock_timestamp()::text AS instant')).rows[0]
                .instant;
            await db.query(
                "DELETE FROM model_api_dispatch_slots WHERE model_id=$1 AND dispatched_at < $2::timestamptz-interval '24 hours'",
                [id, clock],
            );
            if (current.enabled) {
                const row = (
                    await db.query<{ retry_ms: string }>(
                        `SELECT greatest(1,ceil(extract(epoch FROM (dispatched_at + $3::integer*interval '1 millisecond' - $2::timestamptz))*1000))::text AS retry_ms
     FROM model_api_dispatch_slots WHERE model_id=$1 AND dispatched_at>$2::timestamptz-$3::integer*interval '1 millisecond'
     ORDER BY dispatched_at DESC OFFSET $4 LIMIT 1`,
                        [id, clock, current.windowMs, current.requests - 1],
                    )
                ).rows[0];
                if (row) {
                    signal?.throwIfAborted();
                    await db.query('ROLLBACK');
                    begun = false;
                    return { admitted: false, retryAfterMs: Number(row.retry_ms) };
                }
            }
            signal?.throwIfAborted();
            await db.query(
                'INSERT INTO model_api_dispatch_slots(id,model_id,dispatched_at) VALUES($1,$2,$3::timestamptz)',
                [randomUUID(), id, clock],
            );
            signal?.throwIfAborted();
            // An ambiguous COMMIT is never repeated: its slot may already exist.
            await db.query('COMMIT');
            begun = false;
            signal?.throwIfAborted();
            return { admitted: true, retryAfterMs: 0 };
        } catch (error) {
            if (begun && !client.released) await db.query('ROLLBACK').catch(() => undefined);
            signal?.throwIfAborted();
            throw error;
        } finally {
            client.close();
        }
    }
    async trySave(
        id: string,
        input: ModelRateLimitInput,
        actor: string,
        authorize: () => Promise<unknown>,
        signal?: AbortSignal,
    ): Promise<ModelRateLimitPolicy | null> {
        const db = await modelRateCheckout(this.pool, signal),
            client = modelRateClient(db, signal);
        let begun = false;
        try {
            signal?.throwIfAborted();
            await modelRateBeforeAttempt(authorize, signal);
            signal?.throwIfAborted();
            await db.query('BEGIN');
            begun = true;
            if (!(await this.lock(db, id))) {
                await db.query('ROLLBACK');
                begun = false;
                return null;
            }
            const card = await db.query('SELECT id FROM model_catalog WHERE id=$1 AND archived_at IS NULL FOR SHARE', [
                id,
            ]);
            if (!card.rowCount) throw new NotFoundException('Модель отсутствует в каталоге.');
            await authorizeAccessWrite(db, { email: actor, activeRole: 'Главный админ' });
            await modelRateBeforeAttempt(authorize, signal);
            signal?.throwIfAborted();
            const current = policy(
                id,
                (await db.query<PolicyRow>('SELECT * FROM model_api_rate_limits WHERE model_id=$1', [id])).rows[0],
            );
            if (current.revision !== input.expectedRevision)
                throw new ConflictException('Настройки лимита изменились. Обновите сведения и повторите сохранение.');
            if (!Number.isSafeInteger(current.revision + 1))
                throw new ConflictException('Достигнут предел ревизий настроек лимита. Обратитесь к администратору.');
            const saved = (
                await db.query<PolicyRow>(
                    `INSERT INTO model_api_rate_limits(model_id,revision,requests,window_ms,enabled,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())
    ON CONFLICT(model_id) DO UPDATE SET revision=EXCLUDED.revision,requests=EXCLUDED.requests,window_ms=EXCLUDED.window_ms,enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at RETURNING *`,
                    [id, current.revision + 1, input.requests, input.windowMs, input.enabled, actor],
                )
            ).rows[0];
            signal?.throwIfAborted();
            await db.query('COMMIT');
            begun = false;
            signal?.throwIfAborted();
            return policy(id, saved);
        } catch (error) {
            if (begun && !client.released) await db.query('ROLLBACK').catch(() => undefined);
            signal?.throwIfAborted();
            throw error;
        } finally {
            client.close();
        }
    }
}
