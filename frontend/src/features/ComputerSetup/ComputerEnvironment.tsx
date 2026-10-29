import {createContext, useContext, type ReactNode} from 'react';
import {useLocation} from 'react-router-dom';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useBridge} from '../McpBridge/useBridge';
import {useBridgeInstaller} from '../McpBridge/useBridgeInstaller';
import {useCliObservation} from './useCliObservation';

interface ComputerEnvironment {
    bridge: ReturnType<typeof useBridge>;
    installer: ReturnType<typeof useBridgeInstaller>;
    cli: ReturnType<typeof useCliObservation>;
}
const ComputerEnvironmentContext = createContext<ComputerEnvironment | undefined>(undefined);

/** Header and setup share one selected computer and one durable CLI observation owner. */
export function ComputerEnvironmentProvider({children}: {children: ReactNode}): JSX.Element {
    const bridge = useBridge(), installer = useBridgeInstaller();
    const availability = useFeatureAvailability('unified_project_setup');
    const location = useLocation();
    const cli = useCliObservation(bridge, availability.enabled, location.pathname === '/start');
    return <ComputerEnvironmentContext.Provider value={{bridge, installer, cli}}>{children}</ComputerEnvironmentContext.Provider>;
}

export function useComputerEnvironment(): ComputerEnvironment {
    const value = useContext(ComputerEnvironmentContext);
    if (!value) throw new Error('Computer environment requires its authenticated shell owner.');
    return value;
}
