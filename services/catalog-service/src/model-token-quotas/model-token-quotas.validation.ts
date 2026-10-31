import { BadRequestException } from '@nestjs/common';
import { normalizeEmail } from '../access/access.model';
import { MODEL_TOKEN_QUOTA_MAX_PERIOD_MS, type ModelTokenQuotaInput } from './model-token-quotas.types';

export const quotaRequestKey = (value: unknown): string => {
    if (
        typeof value !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    )
        throw new BadRequestException('Нужен устойчивый UUID запроса настройки квоты.');
    return value.toLowerCase();
};
export function quotaUserEmail(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException('Выберите пользователя платформы.');
    try {
        return normalizeEmail(value);
    } catch {
        throw new BadRequestException('Выберите пользователя платформы.');
    }
}
/** Duration is a token-budget policy, independent from the short request-rate window. */
export function modelTokenQuotaInput(raw: unknown): ModelTokenQuotaInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new BadRequestException('Передайте персональную квоту модели.');
    const v = raw as Record<string, unknown>,
        fields = ['requestKey', 'expectedRevision', 'enabled', 'tokenLimit', 'periodMs'];
    if (
        Object.keys(v).length !== fields.length ||
        Object.keys(v).some((k) => !fields.includes(k)) ||
        !Number.isSafeInteger(v.expectedRevision) ||
        Number(v.expectedRevision) < 0 ||
        typeof v.enabled !== 'boolean' ||
        !Number.isSafeInteger(v.tokenLimit) ||
        Number(v.tokenLimit) < 1 ||
        !Number.isSafeInteger(v.periodMs) ||
        Number(v.periodMs) < 1 ||
        Number(v.periodMs) > MODEL_TOKEN_QUOTA_MAX_PERIOD_MS
    )
        throw new BadRequestException('Укажите целый положительный бюджет, период до 365 дней и текущую ревизию.');
    return {
        requestKey: quotaRequestKey(v.requestKey),
        expectedRevision: Number(v.expectedRevision),
        enabled: v.enabled,
        tokenLimit: Number(v.tokenLimit),
        periodMs: Number(v.periodMs),
    };
}
