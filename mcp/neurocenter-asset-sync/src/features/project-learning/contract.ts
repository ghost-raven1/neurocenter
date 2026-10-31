import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const source = import.meta.url.endsWith('.ts')
    ? '../../../../../services/shared/project-learning.cjs'
    : '../../shared/project-learning.cjs';
const shared = createRequire(import.meta.url)(
    fileURLToPath(new URL(source, import.meta.url)),
) as typeof import('../../../../../services/shared/project-learning.cjs');
export const {
    PROJECT_LEARNING_NOTE,
    normalizeLearningExperienceInput,
    normalizeLearningObservedExperienceInput,
    normalizeLearningHypothesisInput,
    normalizeLearningContext,
} = shared;
export type {
    LearningContext,
    LearningExperienceInput,
    LearningObservedExperienceInput,
    LearningHypothesisInput,
    LearningMutationResult,
} from '../../../../../services/shared/project-learning.cjs';
