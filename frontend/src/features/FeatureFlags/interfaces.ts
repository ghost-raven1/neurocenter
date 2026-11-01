import type { TFeatureFlagKey, IFeatureFlagDefinition } from '../../../../services/shared/feature-flags.cjs';

export type { TFeatureFlagKey } from '../../../../services/shared/feature-flags.cjs';

export type TFeatureFlagGroup = IFeatureFlagDefinition['group'];

export interface IFeatureFlag {
    key: TFeatureFlagKey;
    name: string;
    description: string;
    group: TFeatureFlagGroup;
    dependsOn: readonly TFeatureFlagKey[];
    enabled: boolean;
    revision: number;
    updatedAt: string | null;
    updatedBy: string | null;
}

export interface IFeatureFlagList {
    items: IFeatureFlag[];
}

export interface IEvaluatedFeatureFlags {
    flags: Record<TFeatureFlagKey, boolean>;
    configured: Record<TFeatureFlagKey, boolean>;
    blockedBy: Record<TFeatureFlagKey, TFeatureFlagKey[]>;
}
