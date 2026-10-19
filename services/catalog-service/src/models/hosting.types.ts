export type HostingAction = 'start' | 'stop' | 'check';
export interface IHostingProgress { stage: string; message: string; progress: number | null }
export interface IHostingOperation extends IHostingProgress {
    id: string; action: HostingAction; state: 'running' | 'completed' | 'failed';
    startedAt: string; finishedAt: string | null;
}
export interface IModelHosting {
    state: 'unavailable' | 'missing' | 'stopped' | 'ready' | 'busy' | 'error';
    message: string; checkedAt: string | null; operation?: IHostingOperation;
}
export interface IHostingJobRow {
    id: string; model_id: string; action: HostingAction; actor: string; state: IHostingOperation['state'];
    stage: string; message: string; progress: number | null; started_at: Date | string;
    finished_at: Date | string | null; operation_id: string;
}

/** Наружу не выходят служебная идентичность исполнителя и параметры соединения. */
export const hostingOperation = (row: IHostingJobRow): IHostingOperation => ({
    id: row.id, action: row.action, state: row.state, stage: row.stage, message: row.message,
    progress: row.progress, startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
});
