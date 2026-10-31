import { HttpException } from '@nestjs/common';
import { FeatureFlagError, requireFeaturesEnabled } from '../../../shared/feature-client.cjs';
import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';

/** Internal RAG routes and per-batch workers apply the same uncached feature policy as the gateway. */
export async function requireRagFeatures(keys: readonly FeatureFlagKey[], signal?: AbortSignal): Promise<void> {
    try {
        await requireFeaturesEnabled(keys, process.env, globalThis.fetch, signal);
    } catch (error) {
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
