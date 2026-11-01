import type { IChatSearchJob } from './interfaces';

export const pendingSearchJob = (value: IChatSearchJob | null): boolean =>
    !!value && ['QUEUED', 'RUNNING', 'queued', 'running'].includes(value.state);
