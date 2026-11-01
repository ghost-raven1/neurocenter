import { AsyncLocalStorage } from 'node:async_hooks';

/** Transport facts for one observed operation; never includes request bodies or credentials. */
export interface IModelDispatchMetrics {
    dispatchCount: number;
    rateWaitMs: number;
    providerLatencyMs: number;
    dispatchedAt: string | null;
    usageId?: string;
    workerId?: string;
    quotaAttempted?: boolean;
    progress?: (active: boolean) => Promise<void>;
}
const storage = new AsyncLocalStorage<IModelDispatchMetrics>();
export const createModelDispatchMetrics = (): IModelDispatchMetrics => ({
    dispatchCount: 0,
    rateWaitMs: 0,
    providerLatencyMs: 0,
    dispatchedAt: null,
});
export const currentModelDispatchMetrics = (): IModelDispatchMetrics | undefined => storage.getStore();
export function withModelDispatchMetrics<T>(state: IModelDispatchMetrics, action: () => T): T {
    return storage.run(state, action);
}
