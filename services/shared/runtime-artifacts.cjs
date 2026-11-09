'use strict';
// Фасад (AD-7): канон целей, переносимых путей и лимитов — в подпапке runtime/; плоский путь и экспорты не меняются.
const { createHash } = require('node:crypto');
const { TARGETS } = require('./runtime/targets.cjs');
const { portablePath } = require('./runtime/portable-path.cjs');
const { LIMIT_DEFAULTS, CEILING, getLimits } = require('./runtime/limits.cjs');
const { inspectRuntimeArchive: archiveInspect } = require('./runtime/archive.cjs');
const { isContractVersion } = require('./runtime/contract-version.cjs');
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
const LIMIT_KEYS = ['compressedBytes', 'unpackedBytes', 'filesCount', 'cacheBytes'];
/** AD-2: политика несётся полем limits дескриптора; значения — [1..ceiling], иначе invalid (fail-closed). */
function validArtifactLimits(limits) {
    return (
        !!limits &&
        typeof limits === 'object' &&
        !Array.isArray(limits) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(limits)) &&
        Object.keys(limits).every((key) => LIMIT_KEYS.includes(key)) &&
        LIMIT_KEYS.every((key) => Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= CEILING[key])
    );
}
/**
 * Одобрение закрепляет только точные переносимые артефакты, без URL и install hooks.
 * `policy` — потолок размеров артефакта: серверная admission-политика (env-снимок, AD-1)
 * или CEILING-константа (AD-2) для клиентов, где env-лимитов не существует.
 */
function normalizeRuntimeArtifacts(value, policy = getLimits()) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length < 1 || value.length > 8)
        throw new Error('Укажите от 1 до 8 готовых платформенных артефактов.');
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
                            'limits',
                            'contractVersion',
                        ].includes(key),
                ) ||
                !TARGETS.includes(item.target) ||
                seen.has(item.target) ||
                !/^[a-f0-9]{64}$/.test(item.sha256) ||
                !portablePath(item.entrypoint) ||
                (item.executable !== undefined && typeof item.executable !== 'boolean') ||
                (item.limits !== undefined && !validArtifactLimits(item.limits)) ||
                // AD-13: contractVersion артефакта опционален (издательский) — при наличии строгий semver.
                (item.contractVersion !== undefined && !isContractVersion(item.contractVersion)) ||
                !['compressedBytes', 'unpackedBytes', 'filesCount'].every(
                    (key) => Number.isSafeInteger(item[key]) && item[key] > 0 && item[key] <= policy[key],
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
    const { destination, signal, limits } = options;
    normalizeRuntimeArtifacts([descriptor], limits ? { ...CEILING, ...limits } : undefined);
    return archiveInspect(filename, descriptor, { destination, signal, limits: limits ?? getLimits() });
}
/**
 * Канонический descriptor-текст runtime-артефактов: тот же алгоритм, что canonicalJson контракта
 * (отсортированные ключи, JSON 2-space, завершающий перевод строки) — клиент и сервер считают одно и то же.
 */
function canonicalDescriptorText(value) {
    const visit = (item) => {
        if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
        if (typeof item === 'number' && Number.isFinite(item)) return item;
        if (Array.isArray(item)) return Array.from(item, visit);
        if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item)))
            return Object.fromEntries(
                Object.keys(item)
                    .sort()
                    .map((key) => {
                        if (['__proto__', 'prototype', 'constructor'].includes(key))
                            throw new Error('Неразрешимый ключ descriptor-текста.');
                        return [key, visit(item[key])];
                    }),
            );
        throw new Error('Descriptor-текст содержит не-JSON значение.');
    };
    return JSON.stringify(visit(value), null, 2) + '\n';
}
/**
 * AD-3: server-issued descriptorSha256 — sha256 канонического descriptor-текста runtime-артефактов пакета.
 * Считается из descriptor-текста, никогда из байтов пакета (self-referential hash запрещён).
 * Вход — уже нормализованный массив (normalizeRuntimeArtifacts): клиент и сервер считают один и тот же
 * дайджест по одному одобренному снимку без обращения к локальной среде лимитов.
 */
function runtimeDescriptorDigest(artifacts) {
    if (!Array.isArray(artifacts)) throw new Error('Descriptor-дайджест требует массив runtime-артефактов.');
    return createHash('sha256').update(canonicalDescriptorText(artifacts)).digest('hex');
}
module.exports = {
    TARGETS,
    LIMIT_DEFAULTS,
    LIMITS,
    CEILING,
    portablePath,
    normalizeRuntimeArtifacts,
    validateRuntimeArtifactEntrypoints,
    inspectRuntimeArchive,
    runtimeDescriptorDigest,
};
