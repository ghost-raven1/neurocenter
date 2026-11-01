import type { IRestoreJob } from './restore.interfaces';

/** API не раскрывает серверные пути, Docker stderr или служебную аренду. */
export const restoreJobView = (row: IRestoreJob) => ({
    id: row.id,
    requestKey: row.request_key,
    kind: row.kind,
    state: row.state,
    input: row.input,
    preview: row.preview,
    receipt: row.receipt,
    errorCode: row.error_code,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});
