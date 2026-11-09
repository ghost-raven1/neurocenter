import type { TCapacityResource } from './capacity.cjs';
/** State of one physical volume in the shared capacity snapshot. */
export interface ICapacityResourceState {
    available: boolean;
    filesystem?: string;
    totalBytes?: number;
    freeBytes?: number;
    walBytes?: number;
}
/** Shared snapshot of physical volume capacity, published by the collector sidecar. */
export interface ICapacitySnapshot {
    schemaVersion: 1;
    observedAt: number;
    resources: Partial<Record<TCapacityResource, ICapacityResourceState>>;
}
/** Пути определены production-топологией, а не пользовательскими или произвольными env-путями. */
export function collectCapacity(options?: { root?: string; now?: () => number }): Promise<ICapacitySnapshot>;
/** Snapshot is published atomically under /capacity with 0600 mode. */
export function publishCapacity(value: ICapacitySnapshot): Promise<void>;
