import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/** PostgreSQL JSONB key order must not alter an immutable source or connection identity. */
export function deviceCodexIdentityDigest(value: unknown): string {
    const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
        : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item;
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function deviceCodexConflict(): never {
    throw new ConflictException('Подключение Codex, компьютер или контекст изменились. Повторите чтение OpenCode.');
}
