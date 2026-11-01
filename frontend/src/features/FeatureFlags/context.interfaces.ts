import type { IFeatureAvailabilityState } from './availabilityController';

export interface IAvailabilityContext extends IFeatureAvailabilityState {
    refresh: () => Promise<void>;
}
