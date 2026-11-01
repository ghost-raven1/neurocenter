import type { TFeatureFlagKey } from './feature-flags.cjs';
export function requiredRouteFeatures(method: string, path: string, body?: unknown): TFeatureFlagKey[];
export function requiredJobFeatures(kind: string, payload?: unknown, trustedPayload?: boolean): TFeatureFlagKey[];
export function requiredAssetFeatures(kind: string): TFeatureFlagKey[];
export function requiredInferenceFeatures(purpose: string, agentId?: string | null): TFeatureFlagKey[];
