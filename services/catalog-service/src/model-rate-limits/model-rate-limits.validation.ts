import { BadRequestException } from '@nestjs/common';
import type { ModelRateLimitInput } from './model-rate-limits.types';

/** Policy changes do not mutate a model descriptor or invalidate its verification pin. */
export function modelRateLimitInput(raw: unknown): ModelRateLimitInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new BadRequestException('Передайте настройки лимита модели.');
    const value = raw as Record<string, unknown>;
    if (
        Object.keys(value).some((key) => !['expectedRevision', 'requests', 'windowMs', 'enabled'].includes(key)) ||
        !Number.isSafeInteger(value.expectedRevision) ||
        Number(value.expectedRevision) < 0 ||
        !Number.isSafeInteger(value.requests) ||
        Number(value.requests) < 1 ||
        Number(value.requests) > 1000 ||
        !Number.isSafeInteger(value.windowMs) ||
        Number(value.windowMs) < 1000 ||
        Number(value.windowMs) > 86400000 ||
        typeof value.enabled !== 'boolean'
    )
        throw new BadRequestException(
            'Лимит: 1–1000 запросов за период от 1 секунды до 24 часов. Передайте текущую ревизию настроек.',
        );
    return {
        expectedRevision: Number(value.expectedRevision),
        requests: Number(value.requests),
        windowMs: Number(value.windowMs),
        enabled: value.enabled,
    };
}
