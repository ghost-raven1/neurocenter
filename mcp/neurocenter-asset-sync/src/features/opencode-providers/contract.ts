import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const source = import.meta.url.endsWith('.ts')
    ? '../../../../../services/shared/opencode-providers.cjs'
    : '../../shared/opencode-providers.cjs';
const shared = createRequire(import.meta.url)(
    fileURLToPath(new URL(source, import.meta.url)),
) as typeof import('../../../../../services/shared/opencode-providers.cjs');
export const {
    OPENCODE_PROVIDER_CAPABILITY,
    OPENCODE_OLLAMA_CAPABILITY,
    OPENCODE_PROVIDER_JOBS,
    normalizeProviderDescriptor,
    providerReportIdentity,
    normalizeProviderReport,
} = shared;
export type {
    OpenCodeProviderDescriptor,
    OpenCodeProviderPreparation,
    OpenCodeProviderStatus,
    OpenCodeProviderOpened,
} from '../../../../../services/shared/opencode-providers.cjs';
