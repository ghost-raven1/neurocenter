export type TCapacityResource =
    'postgres' | 'wal' | 'skills' | 'projects' | 'backups' | 'runtime-artifacts' | 'model-weights';
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
/** Фиксированный набор физических томов production-топологии. */
export const resources: readonly TCapacityResource[];
/** Снимок старше этого возраста считается устаревшим. */
export const maxAgeMs: number;
/** Резерв одного процесса учитывает конкуренцию и зафиксированные записи до следующего замера. */
export function createCapacityGuard(options?: {
    required?: () => boolean;
    snapshot?: (now?: number) => unknown;
    statfs?: (path: string, options: { bigint: boolean }) => Promise<unknown>;
    stat?: (path: string) => Promise<unknown>;
    now?: () => number;
}): (request: { resource: TCapacityResource; bytes: number; path?: string }) => Promise<() => void>;
/** Бросает на устаревшем или неполном снимке; валидный снимок возвращается без изменений. */
export function validateSnapshot(value: unknown, now?: number): unknown;
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
    // model-weights обязателен только в снапшоте schemaVersion 2; legacy (1) — Partial.
    resources?: Partial<
        Record<
            TCapacityResource,
            { available: true; filesystem: string; freeBytes: number; totalBytes: number; walBytes?: number }
        >
    >;
};
