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
export const {
    TARGETS,
    LIMITS,
    CEILING,
    portablePath,
    normalizeRuntimeArtifacts,
    validateRuntimeArtifactEntrypoints,
    inspectRuntimeArchive,
} = shared;
export type { IRuntimeArtifact as RuntimeArtifact, IRuntimeArtifactEntry as RuntimeArtifactEntry };

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
