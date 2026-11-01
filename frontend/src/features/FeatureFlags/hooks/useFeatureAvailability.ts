import { useContext } from 'react';
import { FeatureAvailabilityContext } from '../context';
import { featureAvailability } from '../utils';
import type { TFeatureFlagKey } from '../interfaces';

export function useFeatureAvailability(...keys: TFeatureFlagKey[]) {
    const state = useContext(FeatureAvailabilityContext);
    return { ...featureAvailability(state, keys), refresh: state.refresh };
}
