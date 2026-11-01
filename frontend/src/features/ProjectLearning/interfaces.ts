export type {
    ILearningOverview as LearningOverview,
    ILearningExperience as LearningExperience,
    ILearningExperienceInput as LearningExperienceInput,
    ILearningHypothesis as LearningHypothesis,
    ILearningHypothesisDraft as LearningHypothesisDraft,
    ILearningHypothesisInput as LearningHypothesisInput,
    ILearningCheck as LearningCheck,
    ILearningCheckInput as LearningCheckInput,
    ILearningCandidate as LearningCandidate,
    ILearningCandidateInput as LearningCandidateInput,
    ILearningCandidateActionInput as LearningCandidateActionInput,
    ILearningMutationResult as LearningMutationResult,
    ILearningEvidence as LearningEvidence,
    ILearningCapabilities as LearningCapabilities,
    ILearningHistoryEntry as LearningHistoryEntry,
    ILearningPageInfo as LearningPageInfo,
} from '../../../../services/shared/project-learning.cjs';

import type {
    ILearningExperienceInput,
    ILearningHypothesisInput,
    ILearningCheckInput,
    ILearningCandidateInput,
    ILearningCandidateActionInput,
} from '../../../../services/shared/project-learning.cjs';

type TDraft<T> = Omit<T, 'requestKey' | 'expectedRevision'>;
export type TLearningCommand =
    | { kind: 'experience'; value: TDraft<ILearningExperienceInput> }
    | { kind: 'hypothesis'; value: TDraft<ILearningHypothesisInput> }
    | { kind: 'check'; hypothesisId: string; value: TDraft<ILearningCheckInput> }
    | { kind: 'candidate'; value: TDraft<ILearningCandidateInput> }
    | {
          kind: 'approve' | 'reject' | 'revoke' | 'activate';
          candidateId: string;
          value: TDraft<ILearningCandidateActionInput>;
      };
export interface ILearningIntent {
    projectId: string;
    requestKey: string;
    expectedRevision: number;
    command: TLearningCommand;
}
export interface ILearningAnalysis {
    id: string;
    projectId: string;
    requestKey: string;
    state: 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
    modelId: string;
    modelPin: string;
    experienceIds: string[];
    sourceRevision: number;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    hypothesisIds: string[];
    error: { code: string; message: string } | null;
}
export interface ILearningEditorState {
    busy: boolean;
    error: string;
    conflict: boolean;
    unconfirmed: boolean;
}
export type TLearningCollection = 'experiences' | 'hypotheses' | 'candidates';
