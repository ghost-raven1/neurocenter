import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type { OpenCodeCliPayload, OpenCodeCliResult } from '../../../../../services/shared/computer-setup.cjs';
const source = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/computer-setup.cjs'
        : '../../shared/computer-setup.cjs',
    import.meta.url,
);
export const {
    OPENCODE_CLI_INSPECT_JOB,
    OPENCODE_CLI_CAPABILITY,
    normalizeOpenCodeCliPayload,
    normalizeOpenCodeCliResult,
} = createRequire(import.meta.url)(
    fileURLToPath(source),
) as typeof import('../../../../../services/shared/computer-setup.cjs');
