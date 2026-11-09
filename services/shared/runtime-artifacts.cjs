'use strict';
// Фасад (AD-7): канон целей, переносимых путей и лимитов — в подпапке runtime/; плоский путь и экспорты не меняются.
const { TARGETS } = require('./runtime/targets.cjs');
const { portablePath } = require('./runtime/portable-path.cjs');
const { LIMIT_DEFAULTS, getLimits } = require('./runtime/limits.cjs');
const { inspectRuntimeArchive: archiveInspect } = require('./runtime/archive.cjs');
/**
 * Лимиты комплектов настраиваются окружением процесса; дефолты совпадают с контрактом поставки.
 * Снимок ленивый (AD-7): окружение читается на каждый доступ, а не при импорте модуля.
 */
const LIMITS = Object.freeze({
    get compressedBytes() {
        return getLimits().compressedBytes;
    },
    get unpackedBytes() {
        return getLimits().unpackedBytes;
    },
    get filesCount() {
        return getLimits().filesCount;
    },
    get cacheBytes() {
        return getLimits().cacheBytes;
    },
});
const ordinal = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
/** Одобрение закрепляет только точные переносимые артефакты, без URL и install hooks. */
function normalizeRuntimeArtifacts(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length < 1 || value.length > 8)
        throw new Error('Укажите от 1 до 8 готовых платформенных артефактов.');
    const limits = getLimits();
    const seen = new Set();
    return value
        .map((item) => {
            if (
                !item ||
                typeof item !== 'object' ||
                Array.isArray(item) ||
                Object.keys(item).some(
                    (key) =>
                        ![
                            'target',
                            'sha256',
                            'compressedBytes',
                            'unpackedBytes',
                            'filesCount',
                            'entrypoint',
                            'executable',
                        ].includes(key),
                ) ||
                !TARGETS.includes(item.target) ||
                seen.has(item.target) ||
                !/^[a-f0-9]{64}$/.test(item.sha256) ||
                !portablePath(item.entrypoint) ||
                (item.executable !== undefined && typeof item.executable !== 'boolean') ||
                !['compressedBytes', 'unpackedBytes', 'filesCount'].every(
                    (key) => Number.isSafeInteger(item[key]) && item[key] > 0 && item[key] <= limits[key],
                )
            )
                throw new Error('Некорректный или повторяющийся платформенный артефакт.');
            seen.add(item.target);
            return { ...item };
        })
        .sort((a, b) => ordinal(a.target, b.target));
}
/** Плагин OpenCode импортируется как JS-модуль и не может быть нативной командой. */
function validateRuntimeArtifactEntrypoints(kind, artifacts) {
    if (
        kind === 'plugin' &&
        artifacts.some((item) => item.executable === true || !/\.(?:js|mjs|cjs)$/.test(item.entrypoint))
    )
        throw new Error('Готовому плагину нужна точка входа .js, .mjs или .cjs без нативного запуска.');
}
/** Тонкий wrapper (AD-7): лимиты — со снимка окружения на момент вызова, сам парсер — в runtime/archive.cjs. */
async function inspectRuntimeArchive(filename, descriptor, options = {}) {
    const { destination, signal } = options;
    normalizeRuntimeArtifacts([descriptor]);
    return archiveInspect(filename, descriptor, { destination, signal, limits: getLimits() });
}
module.exports = {
    TARGETS,
    LIMIT_DEFAULTS,
    LIMITS,
    portablePath,
    normalizeRuntimeArtifacts,
    validateRuntimeArtifactEntrypoints,
    inspectRuntimeArchive,
};
