/** Дефолтные лимиты комплектов: совпадают с контрактом поставки. */
export const LIMIT_DEFAULTS: { compressedBytes: number; unpackedBytes: number; filesCount: number; cacheBytes: number };
/**
 * Лимиты комплектов настраиваются окружением процесса:
 * NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES / NEUROCENTER_RUNTIME_MAX_UNPACKED_BYTES / NEUROCENTER_RUNTIME_MAX_FILES / NEUROCENTER_RUNTIME_CACHE_BYTES.
 * Окружение читается на каждый вызов, при импорте модуля — нет; результат заморожен.
 */
export function getLimits(): { compressedBytes: number; unpackedBytes: number; filesCount: number; cacheBytes: number };
