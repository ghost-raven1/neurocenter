export const RUNTIME_CACHE_POLICY_JOB: 'runtime-cache-policy';
export const RUNTIME_CACHE_POLICY_CAPABILITY: 'runtime-cache-policy-v1';
export const BRIDGE_UPDATE_CLEANUP_CAPABILITY: 'bridge-update-cleanup-v1';
export const BRIDGE_UPDATE_CURRENT_ONLY_CAPABILITY: 'bridge-update-current-only-v1';
export const RUNTIME_CACHE_TARGET_CAPABILITY: 'runtime-cache-target-v2';
export const RUNTIME_CACHE_POLICY_LIMITS: Readonly<{
    defaultBytes: number;
    minBytes: number;
    maxBytes: number;
    stepBytes: number;
}>;
export const RUNTIME_CACHE_TARGET_LIMITS: Readonly<{
    defaultBytes: number;
    minBytes: number;
    maxBytes: number;
    stepBytes: number;
}>;
export interface IBridgeUpdateCleanupPolicy {
    enabled: boolean;
    keepPrevious: number;
    minAgeDays: number;
}
export type TRuntimeCachePolicyPayload =
    | { schemaVersion: 1; action: 'inspect' }
    | { schemaVersion: 1 | 2; action: 'set'; expectedRevision: number; limitBytes: number }
    | { schemaVersion: 2; action: 'inspect' }
    | { schemaVersion: 2; action: 'set-cleanup'; expectedRevision: number; cleanup: IBridgeUpdateCleanupPolicy };
interface IRuntimeCachePolicyMetadata {
    revision: number;
    limitBytes: number;
    usedBytes: number;
    defaultBytes: number;
    minBytes: number;
    maxBytes: number;
    observedAt: string;
}
export type TRuntimeCachePolicyResult = IRuntimeCachePolicyMetadata &
    ({ schemaVersion: 1 } | { schemaVersion: 2; cleanup: IBridgeUpdateCleanupPolicy });
export function normalizeRuntimeCachePolicyPayload(value: unknown): TRuntimeCachePolicyPayload;
export function normalizeRuntimeCachePolicyResult(value: unknown): TRuntimeCachePolicyResult;
