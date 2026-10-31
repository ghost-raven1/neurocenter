/** Платформа, на которой площадка исполняет комплекты (контейнер сервиса = платформа хоста). */
export function runtimeArtifactTarget(): string {
    const base = process.platform + '-' + process.arch;
    if (process.platform !== 'linux') {
        return base;
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
        return base + '-glibc';
    }
    if (
        Array.isArray(value?.sharedObjects) &&
        value.sharedObjects.some(
            (item) =>
                typeof item === 'string' &&
                /(?:^|\/)(?:ld-musl-[^/]+\.so(?:\.\d+)*|libc\.musl-[^/]+\.so(?:\.\d+)*)$/.test(item),
        )
    ) {
        return base + '-musl';
    }
    return base + '-unknown';
}
