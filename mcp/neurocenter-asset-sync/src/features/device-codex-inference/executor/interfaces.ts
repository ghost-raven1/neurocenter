import type { loadDeviceCodexTransport } from '../../opencode-providers/connector.js';
import type { DeviceCodexContext } from '../contract.js';

export interface ICodexJob {
    id: string;
    lease: string;
    payload: unknown;
}

export interface IExecutionDependencies {
    context: (job: ICodexJob) => Promise<unknown>;
    dispatch: (job: ICodexJob, callId: string) => Promise<unknown>;
    transport: typeof loadDeviceCodexTransport;
    checkLocal?: (context: DeviceCodexContext) => Promise<void>;
    prepare?: (context: DeviceCodexContext, authorize: () => Promise<unknown>) => Promise<unknown>;
    pollMs?: number;
}
