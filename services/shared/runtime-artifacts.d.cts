export interface IRuntimeArtifact {
    target: string;
    sha256: string;
    compressedBytes: number;
    unpackedBytes: number;
    filesCount: number;
    entrypoint: string;
    executable?: boolean;
}
export interface IRuntimeArtifactEntry {
    path: string;
    size: number;
    sha256: string;
    executable: boolean;
}
export const TARGETS: string[];
export const LIMIT_DEFAULTS: { compressedBytes: number; unpackedBytes: number; filesCount: number; cacheBytes: number };
/**
 * Настройки окружения процесса: NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES/_UNPACKED_BYTES/_MAX_FILES, NEUROCENTER_RUNTIME_CACHE_BYTES.
 * Снимок ленивый (AD-7): окружение читается на каждый доступ, а не при импорте модуля.
 */
export const LIMITS: { compressedBytes: number; unpackedBytes: number; filesCount: number; cacheBytes: number };
/**
 * AD-12: ceiling-константы — re-export из pinned asset-контракта (через runtime/limits.cjs),
 * не значения окружения и не локальные литералы; ceiling > LIMIT_DEFAULTS в каждой секции (invariant AD-1).
 */
export const CEILING: { compressedBytes: number; unpackedBytes: number; filesCount: number; cacheBytes: number };
export function portablePath(value: unknown): boolean;
export function normalizeRuntimeArtifacts(value: unknown): IRuntimeArtifact[];
/** Плагин допускает только импортируемую JS-точку входа. */
export function validateRuntimeArtifactEntrypoints(kind: string, artifacts: IRuntimeArtifact[]): void;
export function inspectRuntimeArchive(
    filename: string,
    descriptor: IRuntimeArtifact,
    options?: { destination?: string; signal?: AbortSignal },
): Promise<IRuntimeArtifactEntry[]>;
