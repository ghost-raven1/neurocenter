import { BadRequestException, NotFoundException } from '@nestjs/common';
import { isFeatureFlagKey, type FeatureFlagKey } from '../../../shared/feature-flags.cjs';

export function featureFlagKey(value: unknown): FeatureFlagKey {
    if (!isFeatureFlagKey(value)) { throw new NotFoundException('Переключатель функции не зарегистрирован.'); }
    return value;
}

/** Явная ревизия не позволяет двум вкладкам незаметно перезаписать выбор друг друга. */
export function featureFlagPatch(value: unknown): { enabled: boolean; expectedRevision: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new BadRequestException('Передайте состояние переключателя и его ревизию.'); }
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !['enabled', 'expectedRevision'].includes(key)) || typeof body.enabled !== 'boolean'
        || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
        throw new BadRequestException('Нужны enabled: boolean и expectedRevision: целое число от 1.');
    }
    return { enabled: body.enabled, expectedRevision: Number(body.expectedRevision) };
}
