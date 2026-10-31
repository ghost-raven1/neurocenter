import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const source = import.meta.url.endsWith('.ts')
    ? '../../../../../services/shared/project-configuration.cjs'
    : '../../shared/project-configuration.cjs';
const shared = createRequire(import.meta.url)(
    fileURLToPath(new URL(source, import.meta.url)),
) as typeof import('../../../../../services/shared/project-configuration.cjs');
export const {
    PROJECT_CONFIGURATION_JOB,
    PROJECT_CONFIGURATION_CAPABILITY,
    normalizeProjectConfigurationSession,
    normalizeProjectConfigurationReport,
} = shared;
export type { ProjectConfigurationSession } from '../../../../../services/shared/project-configuration.cjs';
