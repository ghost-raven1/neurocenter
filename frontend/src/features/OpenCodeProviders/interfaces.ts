import type {
    IOpenCodeProviderIdentity,
    TOpenCodeProviderJobKind,
    TOpenCodeProviderKind,
    IOpenCodeProviderOpened,
    IOpenCodeProviderPreparation,
    IOpenCodeProviderStatus,
} from '../../../../services/shared/opencode-providers.cjs';
import type { IBridgeJob } from '../McpBridge/api';

export type {
    IOpenCodeProviderIdentity as OpenCodeProviderIdentity,
    TOpenCodeProviderKind as OpenCodeProviderKind,
    IOpenCodeProviderOpened as OpenCodeProviderOpened,
    IOpenCodeProviderPreparation as OpenCodeProviderPreparation,
    IOpenCodeProviderStatus as OpenCodeProviderStatus,
};
export interface IProviderSetupTarget {
    deviceId: string;
    projectId: string;
    expectedBindingId: string;
    expectedInstanceId: string;
}
export type TProviderSetupSelection = IProviderSetupTarget &
    (
        | { providerKind: 'openai-compatible' | 'ollama'; catalogModelId: string; expectedModelPin: string }
        | { providerKind: 'codex-bridge'; catalogModelId?: never; expectedModelPin?: never }
    );
export type TProviderSetupRequest = TProviderSetupSelection & {
    kind: TOpenCodeProviderJobKind;
    requestKey: string;
    preparationJobId?: string;
    expectedProviderSchemaDigest?: string;
};
export interface IProviderSetupJob extends IBridgeJob {
    providerKind: TOpenCodeProviderKind;
    providerId: string;
    providerSchemaDigest: string;
    catalogModelId: string | null;
    expectedModelPin: string | null;
}
