import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { RuntimeArtifact, RuntimeArtifactEntry } from '../../../../../services/shared/runtime-artifacts.cjs';

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
    portablePath,
    normalizeRuntimeArtifacts,
    validateRuntimeArtifactEntrypoints,
    inspectRuntimeArchive,
} = shared;
export type { RuntimeArtifact, RuntimeArtifactEntry };

/** Linux различает glibc и musl; неизвестная платформа не подменяется похожей. */
export function runtimeArtifactTarget(
    platform: string = process.platform,
    architecture: string = process.arch,
    suppliedReport?: unknown,
): string {
    const base = platform + '-' + architecture;
    if (platform !== 'linux') {
        return base;
    }
    let value = suppliedReport;
    if (value === undefined) {
        try {
            value = process.report?.getReport();
        } catch {
            /* Неизвестная libc не подменяется musl. */
        }
    }
    const report = value as { header?: { glibcVersionRuntime?: unknown }; sharedObjects?: unknown } | undefined;
    if (
        typeof report?.header?.glibcVersionRuntime === 'string' &&
        /^\d+\.\d+(?:\.\d+)?$/.test(report.header.glibcVersionRuntime)
    ) {
        return base + '-glibc';
    }
    if (
        Array.isArray(report?.sharedObjects) &&
        report.sharedObjects.some(
            (item) =>
                typeof item === 'string' &&
                /(?:^|\/)(?:ld-musl-[^/]+\.so(?:\.\d+)*|libc\.musl-[^/]+\.so(?:\.\d+)*)$/.test(item),
        )
    ) {
        return base + '-musl';
    }
    return base + '-unknown';
}
