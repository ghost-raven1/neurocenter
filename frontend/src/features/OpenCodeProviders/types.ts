import type {OpenCodeProviderIdentity, OpenCodeProviderJobKind, OpenCodeProviderKind, OpenCodeProviderOpened, OpenCodeProviderPreparation, OpenCodeProviderStatus} from '../../../../services/shared/opencode-providers.cjs';
import type {IBridgeJob} from '../McpBridge/api';

export type {OpenCodeProviderIdentity, OpenCodeProviderKind, OpenCodeProviderOpened, OpenCodeProviderPreparation, OpenCodeProviderStatus};
export interface IProviderSetupTarget {deviceId: string; projectId: string; expectedBindingId: string; expectedInstanceId: string;}
export type IProviderSetupSelection = IProviderSetupTarget & ({providerKind: 'openai-compatible' | 'ollama'; catalogModelId: string; expectedModelPin: string}
    | {providerKind: 'codex-bridge'; catalogModelId?: never; expectedModelPin?: never});
export type IProviderSetupRequest = IProviderSetupSelection & {kind: OpenCodeProviderJobKind; requestKey: string;
    preparationJobId?: string; expectedProviderSchemaDigest?: string};
export interface IProviderSetupJob extends IBridgeJob {
    providerKind: OpenCodeProviderKind; providerId: string; providerSchemaDigest: string; catalogModelId: string | null; expectedModelPin: string | null;
}
export type TProviderReport = OpenCodeProviderPreparation | OpenCodeProviderOpened | OpenCodeProviderStatus;
