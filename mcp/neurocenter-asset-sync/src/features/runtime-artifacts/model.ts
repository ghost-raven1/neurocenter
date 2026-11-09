import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { IRuntimeArtifact, IRuntimeArtifactEntry } from '../../../../../services/shared/runtime-artifacts.cjs';

// В исходниках и автономном архиве используется один и тот же проверенный TAR-парсер.
const moduleUrl = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/runtime-artifacts.cjs'
        : '../../shared/runtime-artifacts.cjs',
    import.meta.url,
);
const shared = createRequire(import.meta.url)(
    fileURLToPath(moduleUrl),
) as typeof import('../../../../../services/shared/runtime-artifacts.cjs');
export const { TARGETS, CEILING, portablePath, validateRuntimeArtifactEntrypoints, runtimeDescriptorDigest } = shared;
export type RuntimeArtifact = IRuntimeArtifact;
export type RuntimeArtifactEntry = IRuntimeArtifactEntry;
/**
 * AD-2: env-лимиты клиента удалены — клиентская политика = константа ceiling контракта.
 * LIMITS (env-снимок) остаётся только для серверной admission-политики (AD-1) и не реэкспортируется сюда.
 */
export const normalizeRuntimeArtifacts = (value: unknown): RuntimeArtifact[] =>
    shared.normalizeRuntimeArtifacts(value, CEILING);
/** Пределы распаковки привязаны к одобренному дескриптору, а не к окружению процесса. */
export const inspectRuntimeArchive = (
    filename: string,
    descriptor: RuntimeArtifact,
    options?: { destination?: string; signal?: AbortSignal },
): Promise<RuntimeArtifactEntry[]> =>
    shared.inspectRuntimeArchive(filename, descriptor, {
        ...options,
        limits: { unpackedBytes: descriptor.unpackedBytes, filesCount: descriptor.filesCount },
    });

// AD-13: версия контракта — тот же pinned источник, что и на сервере; строгий semver без зависимостей.
const contractVersionUrl = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/runtime/contract-version.cjs'
        : '../../shared/runtime/contract-version.cjs',
    import.meta.url,
);
export const {
    CONTRACT_VERSION,
    isContractVersion,
    compareContractVersions,
} = createRequire(import.meta.url)(
    fileURLToPath(contractVersionUrl),
) as typeof import('../../../../../services/shared/runtime/contract-version.cjs');

// Детекция цели хоста — канон runtime/host-target.cjs (AD-7); injectable report сохраняется для тестов.
const hostTargetModuleUrl = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/runtime/host-target.cjs'
        : '../../shared/runtime/host-target.cjs',
    import.meta.url,
);
const { getHostTarget } = createRequire(import.meta.url)(
    fileURLToPath(hostTargetModuleUrl),
) as typeof import('../../../../../services/shared/runtime/host-target.cjs');

/** Linux различает glibc и musl; неизвестная платформа не подменяется похожей. */
export function runtimeArtifactTarget(
    platform: string = process.platform,
    architecture: string = process.arch,
    suppliedReport?: unknown,
): string {
    return getHostTarget({ platform, arch: architecture, report: suppliedReport, mode: 'unknown' });
}
