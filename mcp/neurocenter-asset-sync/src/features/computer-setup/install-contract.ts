import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
export type {
    OpenCodeInstallPayload,
    OpenCodeInstallResult,
    OpenCodeInstallSupply,
    OpenCodeInstallFailure,
} from '../../../../../services/shared/opencode-cli-install.cjs';
const source = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/opencode-cli-install.cjs'
        : '../../shared/opencode-cli-install.cjs',
    import.meta.url,
);
export const {
    OPENCODE_CLI_INSTALL_JOB,
    OPENCODE_CLI_INSTALL_CAPABILITY,
    OPENCODE_CLI_INSTALL_VERSION,
    normalizeOpenCodeInstallSupply,
    normalizeOpenCodeInstallPayload,
    normalizeOpenCodeInstallResult,
} = createRequire(import.meta.url)(
    fileURLToPath(source),
) as typeof import('../../../../../services/shared/opencode-cli-install.cjs');
