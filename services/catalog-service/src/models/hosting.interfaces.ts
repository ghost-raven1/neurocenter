export type THostingAction = 'start' | 'stop' | 'check';

export interface IHostingProgress {
    stage: string;
    message: string;
    progress: number | null;
}

export interface IHostingOperation extends IHostingProgress {
    id: string;
    action: THostingAction;
    state: 'running' | 'completed' | 'failed';
    startedAt: string;
    finishedAt: string | null;
}

export interface IModelHosting {
    state: 'unavailable' | 'missing' | 'stopped' | 'ready' | 'busy' | 'error';
    message: string;
    checkedAt: string | null;
    operation?: IHostingOperation;
}

export interface IHostingJobRow {
    id: string;
    model_id: string;
    action: THostingAction;
    actor: string;
    state: IHostingOperation['state'];
    stage: string;
    message: string;
    progress: number | null;
    started_at: Date | string;
    finished_at: Date | string | null;
    operation_id: string;
}
