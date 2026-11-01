import type {
    IOpenCodeProviderOpened,
    IOpenCodeProviderPreparation,
    IOpenCodeProviderStatus,
} from '../../../../services/shared/opencode-providers.cjs';

/** Contract owned by model. */
export type TProviderReport = IOpenCodeProviderPreparation | IOpenCodeProviderOpened | IOpenCodeProviderStatus;
