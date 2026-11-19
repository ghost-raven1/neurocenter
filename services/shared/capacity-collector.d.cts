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
    /** 2 — текущий коллектор (7 ресурсов, включая model-weights); 1 — legacy, совместим на читательской стороне. */
    schemaVersion: 1 | 2;
    observedAt: number;
    resources: Partial<Record<TCapacityResource, ICapacityResourceState>>;
    /** AD-18: host-RAM/CPU из /proc (network_mode none + DAC_OVERRIDE не маскируют /proc). */
    machine?: IMachineSnapshot;
}
/** AD-18: machine-метрики хоста. cpuUtilization отсутствует на первом тике коллектора («нет данных»). */
export interface IMachineSnapshot {
    ramTotalBytes: number;
    ramAvailableBytes: number;
    cpuCores: number;
    cpuUtilization?: number;
}
/** Пути определены production-топологией, а не пользовательскими или произвольными env-путями. */
export function collectCapacity(options?: { root?: string; now?: () => number }): Promise<ICapacitySnapshot>;
/** Machine-метрики хоста (RAM/CPU) из /proc — обособлены для тестов и переиспользования. */
export function collectMachine(options?: { meminfoPath?: string; statPath?: string }): Promise<IMachineSnapshot>;
/** Snapshot is published atomically under /capacity with 0600 mode. */
export function publishCapacity(value: ICapacitySnapshot): Promise<void>;
