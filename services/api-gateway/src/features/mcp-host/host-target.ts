/** Runtime descriptors use the Gateway's platform, including Linux libc. */
export function hostRuntimeTarget(): string {
    const report =
        process.platform === 'linux'
            ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
            : undefined;
    return process.platform === 'linux'
        ? `linux-${process.arch}-${report?.header?.glibcVersionRuntime ? 'glibc' : 'musl'}`
        : `${process.platform}-${process.arch}`;
}
