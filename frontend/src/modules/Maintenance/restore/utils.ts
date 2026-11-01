import type { IRestoreJob } from './interfaces';

export const restoreTerminal = (job: IRestoreJob | undefined) =>
    !!job && ['ready', 'succeeded', 'failed', 'interrupted', 'cancelled'].includes(job.state);
