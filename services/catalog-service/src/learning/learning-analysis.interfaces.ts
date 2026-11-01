import type { IAccessActor } from '../access/access.model';
import type { ILearningAnalysisInput, ILearningExperience } from '../../../shared/project-learning.cjs';

export type TLearningAnalysisState = 'queued' | 'running' | 'completed' | 'failed' | 'unknown';

export interface ILearningAnalysis {
    id: string;
    projectId: string;
    requestKey: string;
    state: TLearningAnalysisState;
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

export interface IAnalysisSnapshot {
    actor: IAccessActor;
    projectId: string;
    revision: number;
    experiences: ILearningExperience[];
}

export interface IAnalysisRow {
    id: string;
    project_id: string;
    request_key: string;
    mutation_key: string;
    request_hash: string;
    actor_email: string;
    actor_role: string;
    model_epoch: string;
    state: TLearningAnalysisState;
    model_id: string;
    model_pin: string;
    source_revision: string | number;
    input: ILearningAnalysisInput;
    experiences: ILearningExperience[];
    hypothesis_ids: string[];
    error_code: string | null;
    error_message: string | null;
    worker_id: string | null;
    lease_until: Date | string | null;
    created_at: Date | string;
    updated_at: Date | string;
    started_at: Date | string | null;
    finished_at: Date | string | null;
}
