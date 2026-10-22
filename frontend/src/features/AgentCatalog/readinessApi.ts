import api from '../../core/api/base';
import { requireAgentReadiness, requireAgentTrial } from './readinessModel';
import type { IAgentTrial, IAgentTrialStart } from './readinessTypes';

const root = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/agents`;
const trials = (projectId: string, agentId: string): string => `${root(projectId)}/${encodeURIComponent(agentId)}/readiness-trials`;

/** Reading or refreshing readiness metadata never starts a diagnostic model call. */
export const agentReadinessApi = {
    list: (projectId: string, signal: AbortSignal) => api.get(`${root(projectId)}/readiness`, { signal }).then(value => requireAgentReadiness(value.data)),
    start: (projectId: string, agentId: string, input: IAgentTrialStart, signal: AbortSignal) => api.post(trials(projectId, agentId), input, { signal }).then(value => requireAgentTrial(value.data)),
    read: (projectId: string, agentId: string, trialId: string, signal: AbortSignal) => api.get(`${trials(projectId, agentId)}/${encodeURIComponent(trialId)}`, { signal }).then(value => requireAgentTrial(value.data)),
    cancel: (projectId: string, agentId: string, trial: IAgentTrial, signal: AbortSignal) => api.post(`${trials(projectId, agentId)}/${encodeURIComponent(trial.id)}/cancel`,
        { expectedRevision: trial.revision }, { signal }).then(value => requireAgentTrial(value.data)),
};
