import type { IPurgeRow } from './retired-rag.interfaces';

export const publicPurge = (row: IPurgeRow) => ({
    id: row.id,
    retirementId: row.retirement_id,
    state: row.state,
    message: row.message,
    receipt: row.receipt,
    digest: row.digest,
    updatedAt: row.updated_at,
});
