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
export const LIMITS: { compressedBytes: number; unpackedBytes: number; filesCount: number; cacheBytes: number };
export function portablePath(value: unknown): boolean;
export function normalizeRuntimeArtifacts(value: unknown): IRuntimeArtifact[];
/** Плагин допускает только импортируемую JS-точку входа. */
export function validateRuntimeArtifactEntrypoints(kind: string, artifacts: IRuntimeArtifact[]): void;
export function inspectRuntimeArchive(
    filename: string,
    descriptor: IRuntimeArtifact,
    options?: { destination?: string; signal?: AbortSignal },
): Promise<IRuntimeArtifactEntry[]>;
