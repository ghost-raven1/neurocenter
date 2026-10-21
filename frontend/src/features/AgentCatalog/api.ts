import api from '../../core/api/base';
import type { IAgentCatalog, IAgentConnectTarget, IAgentCreate, IAgentProjectPatch, IAgentSaved, ICatalogAgent, TAgentJob } from './types';

const agentPath = (id: string): string => '/api/agents/' + encodeURIComponent(id);
const projectPath = (id: string): string => '/api/projects/' + encodeURIComponent(id) + '/agents';

/** Agent mutations carry immutable version pins, project CAS and stable request keys. */
export const agentCatalogApi = {
    list: (projectId?: string): Promise<IAgentCatalog> => api.get<IAgentCatalog>('/api/agents', { params: { projectId } }).then(result => result.data),
    get: (id: string): Promise<ICatalogAgent> => api.get<ICatalogAgent>(agentPath(id)).then(result => result.data),
    create: (value: IAgentCreate, requestKey: string): Promise<ICatalogAgent> => api.post<ICatalogAgent>('/api/agents', { ...value, requestKey }).then(result => result.data),
    update: (agent: ICatalogAgent, value: IAgentCreate, requestKey: string): Promise<ICatalogAgent> => api.patch<ICatalogAgent>(agentPath(agent.id), {
        ...value, expectedVersion: agent.version, requestKey,
    }).then(result => result.data),
    assign: (projectId: string, agent: ICatalogAgent, expectedRevision: number, requestKey: string): Promise<IAgentSaved> => api.post<IAgentSaved>(projectPath(projectId), {
        agentId: agent.id, version: agent.version, manifest: agent.manifest, expectedRevision, requestKey,
    }).then(result => result.data),
    configure: (projectId: string, agentId: string, value: IAgentProjectPatch, expectedRevision: number, requestKey: string): Promise<IAgentSaved> => api.patch<IAgentSaved>(projectPath(projectId) + '/' + encodeURIComponent(agentId), {
        ...value, expectedRevision, requestKey,
    }).then(result => result.data),
    remove: (projectId: string, agentId: string, expectedRevision: number, requestKey: string): Promise<IAgentSaved> => api.delete<IAgentSaved>(projectPath(projectId) + '/' + encodeURIComponent(agentId), {
        data: { expectedRevision, requestKey },
    }).then(result => result.data),
    connect: (projectId: string, target: IAgentConnectTarget, expectedRevision: number, requestKey: string): Promise<TAgentJob> => api.post<TAgentJob>(projectPath(projectId) + '/connect', {
        ...target, expectedRevision, requestKey,
    }).then(result => result.data),
};
