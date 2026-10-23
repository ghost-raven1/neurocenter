import { AsyncLocalStorage } from 'node:async_hooks';

/** Transport facts for one observed operation; never includes request bodies or credentials. */
export interface ModelDispatchMetrics {
    dispatchCount: number; rateWaitMs: number; providerLatencyMs: number; dispatchedAt: string | null;
}
const storage = new AsyncLocalStorage<ModelDispatchMetrics>();
export const createModelDispatchMetrics = (): ModelDispatchMetrics => ({ dispatchCount: 0, rateWaitMs: 0, providerLatencyMs: 0, dispatchedAt: null });
export const currentModelDispatchMetrics = (): ModelDispatchMetrics | undefined => storage.getStore();
export function withModelDispatchMetrics<T>(state: ModelDispatchMetrics, action: () => T): T { return storage.run(state, action); }
