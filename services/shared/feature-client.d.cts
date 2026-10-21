import type {FeatureFlagKey,IEvaluatedFeatureFlags} from './feature-flags.cjs';
export class FeatureFlagError extends Error{readonly status:403|503;readonly code:'feature-disabled'|'feature-flags-unavailable';readonly feature?:FeatureFlagKey;readonly blockedBy:FeatureFlagKey[];}
export function readFeatures(env?:NodeJS.ProcessEnv,request?:typeof fetch,signal?:AbortSignal):Promise<Pick<IEvaluatedFeatureFlags,'flags'|'blockedBy'>>;
export function requireFeaturesEnabled(keys:readonly FeatureFlagKey[],env?:NodeJS.ProcessEnv,request?:typeof fetch,signal?:AbortSignal):Promise<void>;
