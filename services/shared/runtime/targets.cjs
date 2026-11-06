'use strict';
/** Канон платформенных целей (AD-7): единственный список целей и явные маппинги имён, без regex-срезов. */
const TARGETS = Object.freeze([
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64-glibc',
    'linux-x64-glibc',
    'linux-arm64-musl',
    'linux-x64-musl',
    'win32-arm64',
    'win32-x64',
]);
const WINDOWS_TARGET_BY_CANONICAL = Object.freeze({
    'win32-arm64': 'windows-arm64',
    'win32-x64': 'windows-x64',
});
const CANONICAL_TARGET_BY_WINDOWS = Object.freeze({
    'windows-arm64': 'win32-arm64',
    'windows-x64': 'win32-x64',
});
const PACKAGE_TARGET_BY_CANONICAL = Object.freeze({
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64-glibc': 'linux-arm64',
    'linux-x64-glibc': 'linux-x64',
    'linux-arm64-musl': 'linux-arm64-musl',
    'linux-x64-musl': 'linux-x64-musl',
});
const CANONICAL_TARGET_BY_PACKAGE = Object.freeze({
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64': 'linux-arm64-glibc',
    'linux-x64': 'linux-x64-glibc',
    'linux-arm64-musl': 'linux-arm64-musl',
    'linux-x64-musl': 'linux-x64-musl',
});
/** win32-* имеют явный windows-аналог, остальные цели отклоняются. */
function toWindowsTarget(canonicalTarget) {
    if (typeof canonicalTarget !== 'string' || !Object.hasOwn(WINDOWS_TARGET_BY_CANONICAL, canonicalTarget))
        throw new Error('Цель ' + String(canonicalTarget) + ' не имеет явного windows-аналога.');
    return WINDOWS_TARGET_BY_CANONICAL[canonicalTarget];
}
/** Любое известное имя (канон, windows-*, package) приводит к канону, неизвестное отклоняется. */
function toCanonicalTarget(target) {
    if (typeof target === 'string' && TARGETS.includes(target)) return target;
    if (typeof target === 'string' && Object.hasOwn(CANONICAL_TARGET_BY_WINDOWS, target))
        return CANONICAL_TARGET_BY_WINDOWS[target];
    if (typeof target === 'string' && Object.hasOwn(CANONICAL_TARGET_BY_PACKAGE, target))
        return CANONICAL_TARGET_BY_PACKAGE[target];
    throw new Error('Неизвестная платформенная цель: ' + String(target) + '.');
}
/** Каноническая цель к цели bridge-пакета; win32-* package-аналога не имеют. */
function toPackageTarget(canonicalTarget) {
    if (typeof canonicalTarget !== 'string' || !Object.hasOwn(PACKAGE_TARGET_BY_CANONICAL, canonicalTarget))
        throw new Error('Цель ' + String(canonicalTarget) + ' не имеет явного package-аналога.');
    return PACKAGE_TARGET_BY_CANONICAL[canonicalTarget];
}
module.exports = {
    TARGETS,
    WINDOWS_TARGET_BY_CANONICAL,
    CANONICAL_TARGET_BY_WINDOWS,
    PACKAGE_TARGET_BY_CANONICAL,
    CANONICAL_TARGET_BY_PACKAGE,
    toWindowsTarget,
    toCanonicalTarget,
    toPackageTarget,
};
