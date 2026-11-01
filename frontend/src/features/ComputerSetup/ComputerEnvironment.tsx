import { ComputerEnvironmentContext } from './context';
export { useComputerEnvironment } from './hooks/useComputerEnvironment';
import { type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { useBridge } from '../McpBridge/hooks/useBridge';
import { useBridgeInstaller } from '../McpBridge/hooks/useBridgeInstaller';
import { useCliObservation } from './hooks/useCliObservation';
import { OPENCODE_CLI_INSTALL_JOB } from '@neurocenter/opencode-cli-install';
import { latestCliInstallation, laterCliJob } from './installationState';
import { cliTerminal } from './model';

/** Header and setup share one selected computer and one durable CLI observation owner. */
export function ComputerEnvironmentProvider({ children }: { children: ReactNode }): JSX.Element {
    const bridge = useBridge(),
        installer = useBridgeInstaller();
    const availability = useFeatureAvailability('unified_project_setup');
    const location = useLocation();
    const reportedInstallation = latestCliInstallation(bridge.jobs, bridge.device?.id ?? '');
    const observation = useCliObservation(
        bridge,
        availability.enabled,
        location.pathname === '/start' && bridge.jobsReady && !reportedInstallation,
    );
    const installationOwner = useCliObservation(bridge, availability.enabled, false, OPENCODE_CLI_INSTALL_JOB);
    const denied = observation.state.denied || installationOwner.state.denied;
    const installation = denied
        ? { ...installationOwner, state: { ...installationOwner.state, job: undefined, denied: true } }
        : installationOwner;
    const latestInstall = denied
        ? undefined
        : laterCliJob(
              installation.state.job,
              bridge.jobsReady && !bridge.errors.jobs ? reportedInstallation : undefined,
          );
    const selected = laterCliJob(observation.state.job, latestInstall);
    const showInstall =
        selected?.kind === OPENCODE_CLI_INSTALL_JOB &&
        (!observation.state.intent || cliTerminal(observation.state.job));
    const owner = showInstall ? installation : observation;
    const displayed = showInstall
        ? {
              ...owner,
              state: { ...owner.state, job: selected },
              controller: { ...owner.controller, start: observation.controller.start },
              canStart: observation.canStart,
              blocker: observation.blocker,
          }
        : observation;
    const cli = denied ? { ...displayed, state: { ...displayed.state, job: undefined, denied: true } } : displayed;
    return (
        <ComputerEnvironmentContext.Provider value={{ bridge, installer, cli, installation }}>
            {children}
        </ComputerEnvironmentContext.Provider>
    );
}
