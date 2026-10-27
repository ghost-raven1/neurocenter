import api from '../../core/api/base';
import type { RoleSelection, RoleStart, SystemRoleId } from '../SystemRoles/types';
import type { ServiceDetail, ServiceDialog, ServicePreview, ServiceTurn } from './types';

const base = '/api/system-role-chats', path = (id: string): string => base + '/' + encodeURIComponent(id);
/** Reading history or an accepted request never starts another model operation. */
export const systemRoleChatsApi = {
    list: (projectId?: string): Promise<ServiceDialog[]> => api.get<ServiceDialog[]>(base, { params: { projectId } }).then(value => value.data),
    create: (input: { id: string; title: string; projectId: string | null; agentId: SystemRoleId }): Promise<ServiceDialog> => api.post<ServiceDialog>(base, input).then(value => value.data),
    read: (id: string, signal?: AbortSignal): Promise<ServiceDetail> => (signal ? api.get<ServiceDetail>(path(id), {signal}) : api.get<ServiceDetail>(path(id))).then(value => value.data),
    prepare: (id: string, agentId: SystemRoleId, selection: RoleSelection, includeContext: boolean): Promise<ServicePreview> => api.post<ServicePreview>(path(id) + '/prepare', { agentId, selection, includeContext }).then(value => value.data),
    start: (id: string, agentId: SystemRoleId, input: RoleStart): Promise<ServiceTurn> => api.post<ServiceTurn>(path(id) + '/turns', { agentId, input }).then(value => value.data),
    request: (id: string, requestId: string, signal?: AbortSignal): Promise<ServiceTurn> => (signal ? api.get<ServiceTurn>(path(id) + '/requests/' + encodeURIComponent(requestId), {signal}) : api.get<ServiceTurn>(path(id) + '/requests/' + encodeURIComponent(requestId))).then(value => value.data),
    cancel: (id: string, turn: ServiceTurn, requestId: string): Promise<ServiceTurn> => api.post<ServiceTurn>(path(id) + '/turns/' + encodeURIComponent(turn.id) + '/cancel', { requestId, expectedRevision: turn.run!.revision }).then(value => value.data),
};

/** A role projection retains original dialog/turn IDs and uses the existing receipt actions. */
export function roleConversationApi(agentId: SystemRoleId): typeof systemRoleChatsApi {
    return {...systemRoleChatsApi,
        list: projectId => api.get<ServiceDialog[]>(base, {params: {projectId, agentId}}).then(value => value.data),
        read: (id, signal) => api.get<ServiceDetail>(path(id), {params: {agentId}, ...(signal ? {signal} : {})}).then(value => value.data),
        create: input => systemRoleChatsApi.create({...input, agentId}),
    };
}
