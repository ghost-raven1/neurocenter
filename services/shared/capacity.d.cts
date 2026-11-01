export type TCapacityResource = 'postgres' | 'wal' | 'skills' | 'projects' | 'backups' | 'runtime-artifacts';
export interface ICapacityRequest {
    resource: TCapacityResource;
    bytes: number;
    path?: string;
}
export class CapacityError extends Error {
    constructor(code: string, resource: TCapacityResource);
    code: string;
    resource: TCapacityResource;
    statusCode: number;
}
export const reserveBytes: number;
/** Резерв до записи освобождается в finally; production требует свежий замер реальных томов. */
export function reserveCapacity(request: ICapacityRequest): Promise<() => void>;
export function recordCapacityQueue(name: 'rag', pending: number, active: number): void;
export function renderCapacityMetrics(): string;
export function getCapacityStatus(): {
    available: boolean;
    reason?: string;
    observedAt?: string;
    maxAgeSeconds?: number;
    reserveBytes?: number;
    resources?: Record<
        TCapacityResource,
        { available: true; filesystem: string; freeBytes: number; totalBytes: number; walBytes?: number }
    >;
};
