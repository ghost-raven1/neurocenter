import { ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

export const quotaUnavailable = () =>
    new ServiceUnavailableException({
        statusCode: 503,
        code: 'MODEL_TOKEN_QUOTA_STORE_UNAVAILABLE',
        message: 'Не удалось подтвердить состояние бюджета модели. Перечитайте сведения перед новой отправкой.',
    });
export const MODEL_TOKEN_QUOTA_DB_DEADLINE_MS = 3000;
/** A cancelled checkout releases only its own later client; it never leaves an orphan in the pool. */
export async function quotaCheckout(pool: Pool, signal?: AbortSignal): Promise<PoolClient> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        let done = false;
        const cleanup = () => signal?.removeEventListener('abort', aborted);
        const aborted = () => {
            if (done) return;
            done = true;
            cleanup();
            reject(signal?.reason);
        };
        signal?.addEventListener('abort', aborted, { once: true });
        pool.connect().then(
            (db) => {
                if (done) {
                    db.release();
                    return;
                }
                done = true;
                cleanup();
                resolve(db);
            },
            (error) => {
                if (!done) {
                    done = true;
                    cleanup();
                    reject(error);
                }
            },
        );
    });
}
/** A client with an unconfirmed transaction boundary is never returned to ordinary pooled work. */
export async function quotaTransaction<T>(
    pool: Pool,
    work: (db: PoolClient) => Promise<T>,
    options: { signal?: AbortSignal; readOnly?: boolean } = {},
): Promise<T> {
    const deadline = new AbortController(),
        timer = setTimeout(() => deadline.abort(quotaUnavailable()), MODEL_TOKEN_QUOTA_DB_DEADLINE_MS);
    timer.unref();
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    let db: PoolClient | undefined,
        released = false,
        reusable = true,
        beginConfirmed = false,
        rejectAbort: (error: unknown) => void = () => undefined;
    const release = (destroy: boolean) => {
        if (db && !released) {
            released = true;
            db.release(destroy);
        }
    };
    const aborted = () => {
        release(true);
        rejectAbort(signal.reason);
    };
    try {
        db = await quotaCheckout(pool, signal);
        const cancelled = new Promise<never>((_, reject) => {
            rejectAbort = reject;
        });
        cancelled.catch(() => undefined);
        const wait = <V>(operation: Promise<V>): Promise<V> => Promise.race([operation, cancelled]);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
        signal.throwIfAborted();
        reusable = false;
        await wait(db.query(options.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'));
        beginConfirmed = true;
        const result = await wait(work(db));
        signal.throwIfAborted();
        await wait(db.query('COMMIT'));
        reusable = true;
        return result;
    } catch (error) {
        const primary = signal.aborted ? signal.reason : error;
        if (db && !released && !reusable) {
            // The same deadline covers cleanup; an abort destroys the owned socket and releases this wait.
            const rollback = db.query('ROLLBACK');
            rollback.catch(() => undefined);
            try {
                await Promise.race([
                    rollback,
                    new Promise<never>((_, reject) => {
                        rejectAbort = reject;
                    }),
                ]);
                reusable = beginConfirmed;
            } catch {
                /* Preserve the primary failure and destroy an unconfirmed session. */
            }
        }
        throw primary;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        release(!reusable);
    }
}
/** Pair locks serialize budget changes without waiting while a provider or unrelated metadata is active. */
export async function quotaPairLock(db: Pick<PoolClient, 'query'>, email: string, modelId: string): Promise<void> {
    const row = (
        await db.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('neurocenter:user-model-token:'||$1,0)) AS locked",
            [JSON.stringify([email, modelId])],
        )
    ).rows[0];
    if (row?.locked !== true) throw quotaUnavailable();
}
