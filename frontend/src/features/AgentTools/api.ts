import api from '../../core/api/base';
import type { IAgentToolCapabilities, IAgentToolStep } from './interfaces';
/** Capability and receipt reads never start inference, search, installation or a system-role task. */
export const agentToolsApi = {
    capabilities: (projectId: string, signal: AbortSignal) =>
        api
            .get<IAgentToolCapabilities>('/api/agent-tools/capabilities', { params: { projectId }, signal })
            .then((value) => value.data),
    steps: (projectId: string, turnId: string, signal: AbortSignal) =>
        api
            .get<{ steps: IAgentToolStep[] }>('/api/agent-tools/steps', { params: { projectId, turnId }, signal })
            .then((value) => value.data.steps),
    step: (id: string, signal: AbortSignal) =>
        api
            .get<{ step: IAgentToolStep }>('/api/agent-tools/steps/' + encodeURIComponent(id), { signal })
            .then((value) => value.data.step),
};
