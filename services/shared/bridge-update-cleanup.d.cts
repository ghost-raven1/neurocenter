export interface ICleanupPolicy {
    enabled: boolean;
    keepPrevious: number;
    minAgeDays: number;
}
export interface IRuntimeIdentity {
    dev: string;
    ino: string;
}
export interface IRuntimeUseLease {
    identity: IRuntimeIdentity;
    release(): Promise<void>;
}
export interface ICleanupResult {
    removed: string[];
    kept: Array<{ path: string; reason: string }>;
    warnings: string[];
}
export const OWNER_FILE: string;
export const CAPABILITY_FILE: string;
export const RUNTIME_USE_ENTRYPOINTS: readonly string[];
export const DEFAULT_CLEANUP_POLICY: Readonly<ICleanupPolicy>;
export function normalizeCleanupPolicy(input?: unknown): ICleanupPolicy;
export function controlRootForInstallRoot(installRoot: string): Promise<string>;
export function acquireRuntimeUseLease(
    runtimeRoot: string,
    options?: { required?: boolean },
): Promise<IRuntimeUseLease | undefined>;
export function acquireForEntrypoint(
    entrypoint: URL | string,
    options?: { ascend?: number; required?: boolean },
): Promise<IRuntimeUseLease | undefined>;
export function writeInstalledRuntimeReceipt(input: {
    installRoot: string;
    runtimeRoot: string;
}): Promise<{ baselinePath: string }>;
export function writeSuccessfulBackupReceipt(input: {
    installRoot: string;
    backupRoot: string;
    completedAt?: number;
}): Promise<{ eligible: boolean; receiptPath?: string; reason?: string }>;
export function cleanupSuccessfulBackups(input: {
    installRoot: string;
    policy?: ICleanupPolicy;
    now?: number;
    beforeDelete?: () => Promise<unknown>;
    signal?: AbortSignal;
}): Promise<ICleanupResult>;
