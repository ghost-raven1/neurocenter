import { TARGETS } from '../../../../shared/runtime-artifacts.cjs';

function assertTarget(target: string): string {
    if (!TARGETS.includes(target)) {
        throw new Error('Платформа хоста не поддерживается для комплектов: ' + target + '.');
    }
    return target;
}

/** Runtime descriptors use the Gateway's platform, including Linux libc. Unknown libc is never guessed. */
export function hostRuntimeTarget(): string {
    const base = process.platform + '-' + process.arch;
    if (process.platform !== 'linux') {
        return assertTarget(base);
    }
    let report: unknown;
    try {
        report = process.report?.getReport();
    } catch {
        /* Неизвестная libc не подменяется musl. */
    }
    const value = report as { header?: { glibcVersionRuntime?: unknown }; sharedObjects?: unknown } | undefined;
    if (
        typeof value?.header?.glibcVersionRuntime === 'string' &&
        /^\d+\.\d+(?:\.\d+)?$/.test(value.header.glibcVersionRuntime)
    ) {
        return assertTarget(base + '-glibc');
    }
    if (
        Array.isArray(value?.sharedObjects) &&
        value.sharedObjects.some(
            (item) =>
                typeof item === 'string' &&
                /(?:^|\/)(?:ld-musl-[^/]+\.so(?:\.\d+)*|libc\.musl-[^/]+\.so(?:\.\d+)*)$/.test(item),
        )
    ) {
        return assertTarget(base + '-musl');
    }
    throw new Error('Платформа хоста не поддерживается для комплектов: ' + base + '.');
}
