export type TLearningSubject = 'project' | 'agent';
export type TLearningOutcome = 'succeeded' | 'failed' | 'mixed' | 'unknown';
export type TLearningEvidenceKind =
    'test' | 'typecheck' | 'lint' | 'lsp' | 'human_feedback' | 'artifact' | 'observation';
export interface ILearningEvidence {
    kind: TLearningEvidenceKind;
    status: 'passed' | 'failed' | 'unknown';
    summary: string;
    reference?: string;
    sha256?: string;
}
export interface ILearningSourceContext {
    agentId?: string;
    agentVersion?: number;
    agentsRevision?: number;
    gitCommit?: string;
    sourceSnapshot?: string;
}
export interface ILearningDeviceContext {
    deviceId: string;
    bindingId: string;
    instanceId: string;
}
export interface ILearningModelProvenance {
    modelId: string;
    modelPin: string;
    version?: number;
    analysisId?: string;
    sourceRevision?: number;
}
export interface ILearningMutationInput {
    requestKey: string;
    expectedRevision: number;
}
export interface ILearningExperienceInput extends ILearningMutationInput {
    title: string;
    summary: string;
    outcome: TLearningOutcome;
    evidence: ILearningEvidence[];
    context?: ILearningSourceContext;
    source?: import('./project-learning-quirks.cjs').IQuirkSource;
}
export type TLearningObservedExperienceInput = Omit<ILearningExperienceInput, 'expectedRevision'>;
export interface ILearningExperience {
    id: string;
    projectId: string;
    title: string;
    summary: string;
    outcome: TLearningOutcome;
    evidence: ILearningEvidence[];
    context: ILearningSourceContext;
    source?: import('./project-learning-quirks.cjs').IQuirkSource;
    origin: 'human' | 'device';
    device: ILearningDeviceContext | null;
    createdBy: string;
    createdAt: string;
}
export interface ILearningHypothesisDraft {
    subject: TLearningSubject;
    title: string;
    statement: string;
    rationale: string;
    verificationPlan: string;
    experienceIds: string[];
}
export interface ILearningHypothesisInput extends ILearningMutationInput, ILearningHypothesisDraft {}
export type TLearningHypothesisStatus = 'open' | 'supported' | 'refuted' | 'inconclusive';
export interface ILearningCheckInput extends ILearningMutationInput {
    method: 'human_review' | 'llm_assessment';
    result: 'passed' | 'failed' | 'inconclusive';
    summary: string;
    experienceIds: string[];
}
export interface ILearningCheck {
    id: string;
    projectId: string;
    hypothesisId: string;
    method: 'human_review' | 'llm_assessment';
    result: 'passed' | 'failed' | 'inconclusive';
    summary: string;
    experienceIds: string[];
    revision: number;
    createdBy: string;
    createdAt: string;
}
export interface ILearningHypothesis extends ILearningHypothesisDraft {
    id: string;
    projectId: string;
    status: TLearningHypothesisStatus;
    revision: number;
    origin: 'human' | 'device' | 'llm';
    device: ILearningDeviceContext | null;
    model: ILearningModelProvenance | null;
    checks: ILearningCheck[];
    checkCount: number;
    checksNextCursor: string | null;
    createdBy: string;
    createdAt: string;
}
export interface ILearningCandidateInput extends ILearningMutationInput {
    hypothesisId: string;
    checkId: string;
    key: string;
    kind: 'lesson' | 'instruction';
    title: string;
    content: string;
    targetAgentId?: string;
}
export type TLearningCandidateStatus = 'proposed' | 'approved' | 'rejected' | 'revoked';
export interface ILearningCandidate {
    id: string;
    projectId: string;
    hypothesisId: string;
    checkId: string;
    key: string;
    version: number;
    kind: 'lesson' | 'instruction';
    title: string;
    content: string;
    targetAgentId: string | null;
    status: TLearningCandidateStatus;
    active: boolean;
    revision: number;
    createdBy: string;
    createdAt: string;
    approvedBy: string | null;
    approvedAt: string | null;
    reason: string | null;
}
export interface ILearningCandidateActionInput extends ILearningMutationInput {
    reason?: string;
}
export interface ILearningHistoryEntry {
    id: string;
    projectId: string;
    revision: number;
    action: string;
    resourceId: string;
    actor: string;
    createdAt: string;
    details: Record<string, unknown>;
}
export interface ILearningCapabilities {
    read: boolean;
    record: boolean;
    review: boolean;
    approve: boolean;
}
export interface ILearningPageInfo {
    nextCursor: string | null;
    total: number;
}
export interface ILearningPage<T> extends ILearningPageInfo {
    items: T[];
}
export interface ILearningOverview {
    schemaVersion: 1;
    projectId: string;
    revision: number;
    experiences: ILearningExperience[];
    hypotheses: ILearningHypothesis[];
    candidates: ILearningCandidate[];
    activeCandidates: ILearningCandidate[];
    pages: { experiences: ILearningPageInfo; hypotheses: ILearningPageInfo; candidates: ILearningPageInfo };
    history: ILearningHistoryEntry[];
    capabilities: ILearningCapabilities;
}
export interface ILearningContextEntry {
    id: string;
    key: string;
    version: number;
    kind: 'lesson' | 'instruction';
    title: string;
    content: string;
    targetAgentId: string | null;
    hypothesisId: string;
    checkId: string;
    approvedAt: string;
}
export interface ILearningContext {
    schemaVersion: 1;
    projectId: string;
    revision: number;
    entries: ILearningContextEntry[];
    digest: string;
    note: string;
}
export interface ILearningMutationResult<T = Record<string, unknown>> {
    schemaVersion: 1;
    projectId: string;
    revision: number;
    requestKey: string;
    result: T;
}
export interface ILearningExperienceResult {
    experience: ILearningExperience;
}
export interface ILearningHypothesisResult {
    hypotheses: ILearningHypothesis[];
    hypothesis: ILearningHypothesis | null;
}
export interface ILearningAnalysisInput extends ILearningMutationInput {
    experienceIds: string[];
    modelId?: string;
}
export interface ILearningAnalysisRecord extends ILearningMutationInput {
    hypotheses: ILearningHypothesisDraft[];
    model: ILearningModelProvenance;
}
export const PROJECT_LEARNING_NOTE: string;
export function normalizeLearningExperienceInput(value: unknown): ILearningExperienceInput;
export function normalizeLearningObservedExperienceInput(value: unknown): TLearningObservedExperienceInput;
export function normalizeLearningHypothesisDraft(value: unknown): ILearningHypothesisDraft;
export function normalizeLearningHypothesisInput(value: unknown): ILearningHypothesisInput;
export function normalizeLearningCheckInput(value: unknown): ILearningCheckInput;
export function normalizeLearningCandidateInput(value: unknown): ILearningCandidateInput;
export function normalizeLearningCandidateActionInput(value: unknown): ILearningCandidateActionInput;
export function normalizeLearningAnalysisInput(value: unknown): ILearningAnalysisInput;
export function normalizeLearningAnalysisRecord(value: unknown): ILearningAnalysisRecord;
export function normalizeLearningContext(value: unknown): ILearningContext;
export function createLearningContext(value: {
    projectId: string;
    revision: number;
    entries: ILearningContextEntry[];
}): ILearningContext;
