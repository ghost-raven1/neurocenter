import type { Pool, PoolClient } from 'pg';

/** Cancel only this checkout; a client delivered after cancellation returns unused to its pool. */
export function modelRateCheckout(pool: Pool, signal?: AbortSignal): Promise<PoolClient> {
    signal?.throwIfAborted();
    return new Promise<PoolClient>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', aborted);
        const aborted = () => {
            settled = true;
            cleanup();
            reject(signal?.reason);
        };
        signal?.addEventListener('abort', aborted, { once: true });
        Promise.resolve()
            .then(() => {
                signal?.throwIfAborted();
                return pool.connect();
            })
            .then(
                (db) => {
                    if (settled) {
                        db.release();
                        return;
                    }
                    settled = true;
                    cleanup();
                    resolve(db);
                },
                (error) => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        reject(error);
                    }
                },
            );
    });
}

/** Interrupt an owned SQL wait without cancelling another operation or releasing twice. */
export function modelRateClient(db: PoolClient, signal?: AbortSignal) {
    let released = false;
    const release = (destroy = false) => {
        if (!released) {
            released = true;
            db.release(destroy);
        }
    };
    const aborted = () => release(true);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    return {
        get released() {
            return released;
        },
        close() {
            signal?.removeEventListener('abort', aborted);
            release();
        },
    };
}
