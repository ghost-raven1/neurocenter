import { useBridge } from '../McpBridge/hooks/useBridge';
import { useBridgeInstaller } from '../McpBridge/hooks/useBridgeInstaller';
import { useCliObservation } from './hooks/useCliObservation';

export interface IComputerEnvironment {
    bridge: ReturnType<typeof useBridge>;
    installer: ReturnType<typeof useBridgeInstaller>;
    cli: ReturnType<typeof useCliObservation>;
    installation: ReturnType<typeof useCliObservation>;
}
