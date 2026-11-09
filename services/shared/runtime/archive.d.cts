export interface IRuntimeArchiveLimits {
    unpackedBytes: number;
    filesCount: number;
}
export interface IRuntimeArchiveEntry {
    path: string;
    size: number;
    sha256: string;
    executable: boolean;
}
export interface IRuntimeArchiveDescriptor {
    target: string;
    sha256: string;
    compressedBytes: number;
    unpackedBytes: number;
    filesCount: number;
    entrypoint: string;
    executable?: boolean;
}
/**
 * Разбор обычного USTAR-архива комплекта (ссылки, PAX и устройства запрещены).
 * Descriptor обязан быть уже нормализованным; лимиты — обязательный параметр (источник лимитов отделён от парсера).
 */
export function inspectRuntimeArchive(
    filename: string,
    descriptor: IRuntimeArchiveDescriptor,
    options: { destination?: string; signal?: AbortSignal; limits: IRuntimeArchiveLimits },
): Promise<IRuntimeArchiveEntry[]>;
