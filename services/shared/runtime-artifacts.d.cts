export interface IArtifactLimits {
    compressedBytes: number;
    unpackedBytes: number;
    filesCount: number;
    cacheBytes: number;
}
export interface IRuntimeArtifact {
    target: string;
    sha256: string;
    compressedBytes: number;
    unpackedBytes: number;
    filesCount: number;
    entrypoint: string;
    executable?: boolean;
    /**
     * AD-2: политика несётся полем limits дескриптора (ровно 4 ключа, каждый в [1..CEILING]).
     * Клиент применяет min(descriptor.limits, ceiling); отсутствие limits на клиенте — fail-closed.
     */
    limits?: IArtifactLimits;
    /** AD-13: версия контракта, изданная с артефактом; обязательна при публикации, опциональна при чтении. */
    contractVersion?: string;
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
/**
 * `policy` — потолок размеров артефакта: серверная admission-политика (env-снимок, AD-1, дефолт)
 * или CEILING-константа (AD-2) для клиентов, где env-лимитов не существует.
 */
export function normalizeRuntimeArtifacts(value: unknown, policy?: IArtifactLimits): IRuntimeArtifact[];
/** Плагин допускает только импортируемую JS-точку входа. */
export function validateRuntimeArtifactEntrypoints(kind: string, artifacts: IRuntimeArtifact[]): void;
export function inspectRuntimeArchive(
    filename: string,
    descriptor: IRuntimeArtifact,
    options?: { destination?: string; signal?: AbortSignal; limits?: Partial<IArtifactLimits> },
): Promise<IRuntimeArtifactEntry[]>;
/**
 * AD-3: sha256 канонического descriptor-текста уже нормализованных runtime-артефактов
 * (server-issued descriptorSha256; self-referential hash из байтов пакета запрещён).
 */
export function runtimeDescriptorDigest(artifacts: IRuntimeArtifact[]): string;
