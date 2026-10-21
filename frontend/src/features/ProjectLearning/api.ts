import api from '../../core/api/base';
import type {LearningAnalysis, LearningCandidate, LearningCheck, LearningCollection, LearningExperience, LearningHistoryEntry, LearningHypothesis, LearningIntent, LearningMutationResult, LearningOverview} from './types';

export const learningPath = (projectId: string): string => '/api/projects/' + encodeURIComponent(projectId) + '/learning';

/** Every project write carries the original CAS revision and one stable request key. */
export const projectLearningApi = {
    read: (projectId: string): Promise<LearningOverview> => api.get<LearningOverview>(learningPath(projectId)).then(value => value.data),
    page: (projectId: string, collection: LearningCollection, before: string): Promise<{items: unknown[]; nextCursor: string | null; total: number}> =>
        api.get(learningPath(projectId) + '/' + collection, {params: {before}}).then(value => value.data),
    experience: (projectId: string, id: string): Promise<LearningExperience> => api.get<LearningExperience>(learningPath(projectId) + '/experiences/' + encodeURIComponent(id)).then(value => value.data),
    hypothesis: (projectId: string, id: string): Promise<LearningHypothesis> => api.get<LearningHypothesis>(learningPath(projectId) + '/hypotheses/' + encodeURIComponent(id)).then(value => value.data),
    candidate: (projectId: string, id: string): Promise<LearningCandidate> => api.get<LearningCandidate>(learningPath(projectId) + '/candidates/' + encodeURIComponent(id)).then(value => value.data),
    checks: (projectId: string, id: string, before: string): Promise<{items: LearningCheck[]; nextCursor: string | null; total: number}> => api.get(learningPath(projectId) + '/hypotheses/' + encodeURIComponent(id) + '/checks', {params: {before}}).then(value => value.data),
    check: (projectId: string, hypothesisId: string, checkId: string): Promise<LearningCheck> => api.get<LearningCheck>(learningPath(projectId) + '/hypotheses/' + encodeURIComponent(hypothesisId) + '/checks/' + encodeURIComponent(checkId)).then(value => value.data),
    history: (projectId: string, beforeRevision: number): Promise<LearningHistoryEntry[]> => api.get<LearningHistoryEntry[]>(learningPath(projectId) + '/history', {params: {beforeRevision}}).then(value => value.data),
    receipt: (projectId: string, key: string): Promise<LearningMutationResult | null> =>
        api.get<LearningMutationResult | null>(learningPath(projectId) + '/requests/' + encodeURIComponent(key)).then(value => value.data).catch((cause: unknown) => {
            if ((cause as {response?: {status?: number}})?.response?.status === 404) return null;
            throw cause;
        }),
    mutate: (intent: LearningIntent): Promise<LearningMutationResult> => {
        const {command, requestKey, expectedRevision, projectId} = intent;
        const base = learningPath(projectId);
        const suffix = command.kind === 'experience' ? '/experiences' : command.kind === 'hypothesis' ? '/hypotheses'
            : command.kind === 'check' ? '/hypotheses/' + encodeURIComponent(command.hypothesisId) + '/checks'
                : command.kind === 'candidate' ? '/candidates' : '/candidates/' + encodeURIComponent(command.candidateId) + '/' + command.kind;
        return api.post<LearningMutationResult>(base + suffix, {...command.value, requestKey, expectedRevision}, {timeout: 30000}).then(value => value.data);
    },
    analyze: (projectId: string, value: {requestKey: string; expectedRevision: number; experienceIds: string[]; modelId: string}): Promise<LearningAnalysis> =>
        api.post<LearningAnalysis>(learningPath(projectId) + '/analyses', value, {timeout: 30000}).then(result => result.data),
    analysis: (projectId: string, analysisId: string): Promise<LearningAnalysis> =>
        api.get<LearningAnalysis>(learningPath(projectId) + '/analyses/' + encodeURIComponent(analysisId)).then(result => result.data),
    analysisReceipt: (projectId: string, requestKey: string): Promise<LearningAnalysis> =>
        api.get<LearningAnalysis>(learningPath(projectId) + '/analyses/requests/' + encodeURIComponent(requestKey)).then(result => result.data),
};
