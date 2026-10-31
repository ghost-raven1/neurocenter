import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import { FeatureFlagError, requireFeaturesEnabled as sharedRequire } from '../../../shared/feature-client.cjs';

/** Общая точка постановки заданий закрывает также повтор из сохранённого payload. */
export async function requireFeaturesEnabled(
    keys: readonly FeatureFlagKey[],
    env = process.env,
    request = globalThis.fetch,
    signal?: AbortSignal,
): Promise<void> {
    try {
        await sharedRequire(keys, env, request, signal);
    } catch (error) {
        if (error instanceof FeatureFlagError && error.status === 403)
            throw new ForbiddenException({
                statusCode: 403,
                code: error.code,
                feature: error.feature,
                blockedBy: error.blockedBy,
                message: error.message,
            });
        if (signal?.aborted) throw signal.reason;
        throw new ServiceUnavailableException(
            'Не удалось проверить доступность функции. Повторите запрос после восстановления сервиса флагов.',
        );
    }
}
export function requireFeatureEnabled(
    key: FeatureFlagKey,
    env = process.env,
    request = globalThis.fetch,
): Promise<void> {
    return requireFeaturesEnabled([key], env, request);
}
