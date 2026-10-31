import type { IQuota } from './dto';

/** Старые частичные JSON-квоты получают прежние нулевые значения; сохранённые замеры не заменяются. */
export function normalizeProjectQuota(value: unknown): IQuota {
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            value = null;
        }
    }
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<IQuota>) : {};
    return {
        currentBytesLimit: 0,
        currentBytesUsed: 0,
        retentionBytesLimit: 0,
        retentionBytesUsed: 0,
        stagingBytesLimit: 0,
        stagingBytesUsed: 0,
        ...stored,
    };
}
