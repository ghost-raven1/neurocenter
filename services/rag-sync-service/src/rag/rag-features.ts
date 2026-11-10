import { HttpException } from '@nestjs/common';
import { FeatureFlagError, requireFeaturesEnabled } from '../../../shared/feature-client.cjs';
import type { TFeatureFlagKey } from '../../../shared/feature-flags.cjs';

/** Internal RAG routes and per-batch workers apply the same uncached feature policy as the gateway. */
export async function requireRagFeatures(keys: readonly TFeatureFlagKey[], signal?: AbortSignal): Promise<void> {
    try {
        await requireFeaturesEnabled(keys, process.env, globalThis.fetch, signal);
    } catch (error) {
        // AD-19 allowlist: текст FeatureFlagError сформирован доменом (shared/feature-client.cjs).
        if (error instanceof FeatureFlagError)
            throw new HttpException(
                {
                    statusCode: error.status,
                    code: error.code,
                    message: error.message,
                    feature: error.feature,
                    blockedBy: error.blockedBy,
                },
                error.status,
            );
        throw error;
    }
}
