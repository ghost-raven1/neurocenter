export type LearningSubject='project'|'agent';
export type LearningOutcome='succeeded'|'failed'|'mixed'|'unknown';
export type LearningEvidenceKind='test'|'typecheck'|'lint'|'lsp'|'human_feedback'|'artifact'|'observation';
export interface LearningEvidence {kind:LearningEvidenceKind;status:'passed'|'failed'|'unknown';summary:string;reference?:string;sha256?:string}
export interface LearningSourceContext {agentId?:string;agentVersion?:number;agentsRevision?:number;gitCommit?:string;sourceSnapshot?:string}
export interface LearningDeviceContext {deviceId:string;bindingId:string;instanceId:string}
export interface LearningModelProvenance {modelId:string;modelPin:string;version?:number;analysisId?:string;sourceRevision?:number}
export interface LearningMutationInput {requestKey:string;expectedRevision:number}
export interface LearningExperienceInput extends LearningMutationInput {title:string;summary:string;outcome:LearningOutcome;evidence:LearningEvidence[];context?:LearningSourceContext;source?:import('./project-learning-quirks.cjs').QuirkSource}
export type LearningObservedExperienceInput=Omit<LearningExperienceInput,'expectedRevision'>;
export interface LearningExperience {id:string;projectId:string;title:string;summary:string;outcome:LearningOutcome;evidence:LearningEvidence[];context:LearningSourceContext;source?:import('./project-learning-quirks.cjs').QuirkSource;origin:'human'|'device';device:LearningDeviceContext|null;createdBy:string;createdAt:string}
export interface LearningHypothesisDraft {subject:LearningSubject;title:string;statement:string;rationale:string;verificationPlan:string;experienceIds:string[]}
export interface LearningHypothesisInput extends LearningMutationInput,LearningHypothesisDraft {}
export type LearningHypothesisStatus='open'|'supported'|'refuted'|'inconclusive';
export interface LearningCheckInput extends LearningMutationInput {method:'human_review'|'llm_assessment';result:'passed'|'failed'|'inconclusive';summary:string;experienceIds:string[]}
export interface LearningCheck {id:string;projectId:string;hypothesisId:string;method:'human_review'|'llm_assessment';result:'passed'|'failed'|'inconclusive';summary:string;experienceIds:string[];revision:number;createdBy:string;createdAt:string}
export interface LearningHypothesis extends LearningHypothesisDraft {id:string;projectId:string;status:LearningHypothesisStatus;revision:number;origin:'human'|'device'|'llm';device:LearningDeviceContext|null;model:LearningModelProvenance|null;checks:LearningCheck[];checkCount:number;checksNextCursor:string|null;createdBy:string;createdAt:string}
export interface LearningCandidateInput extends LearningMutationInput {hypothesisId:string;checkId:string;key:string;kind:'lesson'|'instruction';title:string;content:string;targetAgentId?:string}
export type LearningCandidateStatus='proposed'|'approved'|'rejected'|'revoked';
export interface LearningCandidate {id:string;projectId:string;hypothesisId:string;checkId:string;key:string;version:number;kind:'lesson'|'instruction';title:string;content:string;targetAgentId:string|null;status:LearningCandidateStatus;active:boolean;revision:number;createdBy:string;createdAt:string;approvedBy:string|null;approvedAt:string|null;reason:string|null}
export interface LearningCandidateActionInput extends LearningMutationInput {reason?:string}
export interface LearningHistoryEntry {id:string;projectId:string;revision:number;action:string;resourceId:string;actor:string;createdAt:string;details:Record<string,unknown>}
export interface LearningCapabilities {read:boolean;record:boolean;review:boolean;approve:boolean}
export interface LearningPageInfo {nextCursor:string|null;total:number}
export interface LearningPage<T> extends LearningPageInfo {items:T[]}
export interface LearningOverview {schemaVersion:1;projectId:string;revision:number;experiences:LearningExperience[];hypotheses:LearningHypothesis[];candidates:LearningCandidate[];activeCandidates:LearningCandidate[];pages:{experiences:LearningPageInfo;hypotheses:LearningPageInfo;candidates:LearningPageInfo};history:LearningHistoryEntry[];capabilities:LearningCapabilities}
export interface LearningContextEntry {id:string;key:string;version:number;kind:'lesson'|'instruction';title:string;content:string;targetAgentId:string|null;hypothesisId:string;checkId:string;approvedAt:string}
export interface LearningContext {schemaVersion:1;projectId:string;revision:number;entries:LearningContextEntry[];digest:string;note:string}
export interface LearningMutationResult<T=Record<string,unknown>> {schemaVersion:1;projectId:string;revision:number;requestKey:string;result:T}
export interface LearningExperienceResult {experience:LearningExperience}
export interface LearningHypothesisResult {hypotheses:LearningHypothesis[];hypothesis:LearningHypothesis|null}
export interface LearningAnalysisInput extends LearningMutationInput {experienceIds:string[];modelId?:string}
export interface LearningAnalysisRecord extends LearningMutationInput {hypotheses:LearningHypothesisDraft[];model:LearningModelProvenance}
export const PROJECT_LEARNING_NOTE:string;
export function normalizeLearningExperienceInput(value:unknown):LearningExperienceInput;
export function normalizeLearningObservedExperienceInput(value:unknown):LearningObservedExperienceInput;
export function normalizeLearningHypothesisDraft(value:unknown):LearningHypothesisDraft;
export function normalizeLearningHypothesisInput(value:unknown):LearningHypothesisInput;
export function normalizeLearningCheckInput(value:unknown):LearningCheckInput;
export function normalizeLearningCandidateInput(value:unknown):LearningCandidateInput;
export function normalizeLearningCandidateActionInput(value:unknown):LearningCandidateActionInput;
export function normalizeLearningAnalysisInput(value:unknown):LearningAnalysisInput;
export function normalizeLearningAnalysisRecord(value:unknown):LearningAnalysisRecord;
export function normalizeLearningContext(value:unknown):LearningContext;
export function createLearningContext(value:{projectId:string;revision:number;entries:LearningContextEntry[]}):LearningContext;
