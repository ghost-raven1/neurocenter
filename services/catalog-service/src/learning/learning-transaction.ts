import type { PoolClient } from 'pg';

/** An unacknowledged rollback must discard the session before another request can commit it. */
export async function rollbackLearningTransaction(db: Pick<PoolClient, 'query'>): Promise<boolean> {
    try {
        await db.query('ROLLBACK');
        return false;
    } catch {
        return true;
    }
}
