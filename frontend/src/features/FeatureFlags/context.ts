import { createContext } from 'react';
import { emptyAvailability } from './availabilityController';
import type { IAvailabilityContext } from './context.interfaces';

/** Share one availability snapshot without importing UI components. */
export const FeatureAvailabilityContext = createContext<IAvailabilityContext>({
    ...emptyAvailability(),
    refresh: async () => undefined,
});
