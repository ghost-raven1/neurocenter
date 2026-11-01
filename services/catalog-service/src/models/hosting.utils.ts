import type { IHostingOperation, IHostingJobRow } from './hosting.interfaces';

/** Наружу не выходят служебная идентичность исполнителя и параметры соединения. */
export const hostingOperation = (row: IHostingJobRow): IHostingOperation => ({
    id: row.id,
    action: row.action,
    state: row.state,
    stage: row.stage,
    message: row.message,
    progress: row.progress,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
});
