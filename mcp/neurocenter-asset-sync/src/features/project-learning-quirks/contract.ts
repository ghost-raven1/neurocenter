import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const source = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/project-learning-quirks.cjs'
        : '../../shared/project-learning-quirks.cjs',
    import.meta.url,
);
export const {
    QUIRKS_LIMITS,
    normalizeQuirksLimits,
    parseQuirksJsonl,
    normalizeQuirksReceipt,
    supportsLearningQuirks,
} = createRequire(import.meta.url)(
    fileURLToPath(source),
) as typeof import('../../../../../services/shared/project-learning-quirks.cjs');
export type {
    QuirksReceipt,
    QuirksSnapshot,
    LearningQuirksLimits,
} from '../../../../../services/shared/project-learning-quirks.cjs';
