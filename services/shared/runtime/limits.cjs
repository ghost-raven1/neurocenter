'use strict';
/** Канон лимитов комплектов (AD-7): окружение читается только на момент вызова, при импорте — нет. */
const { ARTIFACT_CEILING } = require('@neurocenter/asset-contract');
/**
 * AD-12: ceiling-константы существуют ровно в одном месте — в pinned asset-контракте.
 * Здесь только re-export (не локальные литералы); изменение ceiling = новый релиз контракта + re-pin.
 */
const CEILING = Object.freeze(ARTIFACT_CEILING);
const LIMIT_DEFAULTS = Object.freeze({
    compressedBytes: 256 * 1024 ** 2,
    unpackedBytes: 1024 ** 3,
    filesCount: 20000,
    cacheBytes: 2 * 1024 ** 3,
});
const LIMIT_ENV = {
    compressedBytes: 'NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES',
    unpackedBytes: 'NEUROCENTER_RUNTIME_MAX_UNPACKED_BYTES',
    filesCount: 'NEUROCENTER_RUNTIME_MAX_FILES',
    cacheBytes: 'NEUROCENTER_RUNTIME_CACHE_BYTES',
};
function limitValue(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('Лимит ' + name + ' должен быть положительным целым числом.');
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error('Лимит ' + name + ' превышает допустимое значение.');
    return value;
}
/** Свежие лимиты на каждый вызов: env читается здесь, а не при импорте модуля. */
function getLimits() {
    const value = {};
    for (const [key, name] of Object.entries(LIMIT_ENV)) value[key] = limitValue(name, LIMIT_DEFAULTS[key]);
    return Object.freeze(value);
}
module.exports = { LIMIT_DEFAULTS, CEILING, getLimits };
