export type {
    LearningOverview, LearningExperience, LearningExperienceInput, LearningHypothesis,
    LearningHypothesisDraft, LearningHypothesisInput, LearningCheck, LearningCheckInput,
    LearningCandidate, LearningCandidateInput, LearningCandidateActionInput, LearningMutationResult,
    LearningEvidence, LearningCapabilities, LearningHistoryEntry,
    LearningPageInfo,
} from '../../../../services/shared/project-learning.cjs';

import type {
    LearningExperienceInput, LearningHypothesisInput, LearningCheckInput,
    LearningCandidateInput, LearningCandidateActionInput,
} from '../../../../services/shared/project-learning.cjs';

type Draft<T> = Omit<T, 'requestKey' | 'expectedRevision'>;
export type LearningCommand =
    | {kind: 'experience'; value: Draft<LearningExperienceInput>}
    | {kind: 'hypothesis'; value: Draft<LearningHypothesisInput>}
    | {kind: 'check'; hypothesisId: string; value: Draft<LearningCheckInput>}
    | {kind: 'candidate'; value: Draft<LearningCandidateInput>}
    | {kind: 'approve' | 'reject' | 'revoke' | 'activate'; candidateId: string; value: Draft<LearningCandidateActionInput>};
export interface LearningIntent {projectId: string; requestKey: string; expectedRevision: number; command: LearningCommand}
export interface LearningAnalysis {
    id: string; projectId: string; requestKey: string; state: 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
    modelId: string; modelPin: string; experienceIds: string[]; sourceRevision: number;
    createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
    hypothesisIds: string[]; error: {code: string; message: string} | null;
}
export interface LearningEditorState {busy: boolean; error: string; conflict: boolean; unconfirmed: boolean}
export type LearningCollection = 'experiences' | 'hypotheses' | 'candidates';
