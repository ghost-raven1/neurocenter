import type { TFeatureFlagKey, IEvaluatedFeatureFlags } from './feature-flags.cjs';
export class FeatureFlagError extends Error {
    readonly status: 403 | 503;
    readonly code: 'feature-disabled' | 'feature-flags-unavailable';
    readonly feature?: TFeatureFlagKey;
    readonly blockedBy: TFeatureFlagKey[];
}
export function readFeatures(
    env?: NodeJS.ProcessEnv,
    request?: typeof fetch,
    signal?: AbortSignal,
): Promise<Pick<IEvaluatedFeatureFlags, 'flags' | 'blockedBy'>>;
export function requireFeaturesEnabled(
    keys: readonly TFeatureFlagKey[],
    env?: NodeJS.ProcessEnv,
    request?: typeof fetch,
    signal?: AbortSignal,
): Promise<void>;
