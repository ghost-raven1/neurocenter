'use strict';
const { TARGETS } = require('./targets.cjs');
/** Поддерживаются только цели из канонического списка, гадание запрещено (AD-7). */
function assertTarget(target) {
    if (!TARGETS.includes(target)) throw new Error('Платформа хоста не поддерживается для комплектов: ' + target + '.');
    return target;
}
/**
 * Единая детекция цели хоста (AD-7): glibc по glibcVersionRuntime, musl по sharedObjects.
 * Поведение при неизвестной libc — параметр: 'unknown' оставляет base-unknown, 'throw' отклоняет цель.
 */
function getHostTarget({
    platform = process.platform,
    arch = process.arch,
    report = undefined,
    mode = 'unknown',
} = {}) {
    const base = platform + '-' + arch;
    if (platform !== 'linux') return mode === 'throw' ? assertTarget(base) : base;
    let value = report;
    if (value === undefined) {
        try {
            value = process.report?.getReport();
        } catch {
            /* Неизвестная libc не подменяется musl. */
        }
    }
    if (
        typeof value?.header?.glibcVersionRuntime === 'string' &&
        /^\d+\.\d+(?:\.\d+)?$/.test(value.header.glibcVersionRuntime)
    )
        return mode === 'throw' ? assertTarget(base + '-glibc') : base + '-glibc';
    if (
        Array.isArray(value?.sharedObjects) &&
        value.sharedObjects.some(
            (item) =>
                typeof item === 'string' &&
                /(?:^|\/)(?:ld-musl-[^/]+\.so(?:\.\d+)*|libc\.musl-[^/]+\.so(?:\.\d+)*)$/.test(item),
        )
    )
        return mode === 'throw' ? assertTarget(base + '-musl') : base + '-musl';
    if (mode === 'throw') throw new Error('Платформа хоста не поддерживается для комплектов: ' + base + '.');
    return base + '-unknown';
}
module.exports = { getHostTarget };
