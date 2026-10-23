import api from '../../core/api/base';
import type { RoleOverview, RolePrepared, RoleRun, RoleSelection, RoleStart, SystemRoleId } from './types';
const base = '/api/system-roles', path = (id: SystemRoleId): string => base + '/' + id;
/** Preview is read-only; a paid start always carries explicit consent and exact model/source pins. */
export const systemRolesApi = {
    overview: (projectId?: string): Promise<RoleOverview> => api.get<RoleOverview>(base, { params: { projectId } }).then(value => value.data),
    list: (id: SystemRoleId, projectId?: string): Promise<RoleRun[]> => api.get<RoleRun[]>(path(id) + '/runs', { params: { projectId } }).then(value => value.data),
    get: (id: SystemRoleId, run: string): Promise<RoleRun> => api.get<RoleRun>(path(id) + '/runs/' + encodeURIComponent(run)).then(value => value.data),
    prepare: (id: SystemRoleId, input: RoleSelection): Promise<RolePrepared> => api.post<RolePrepared>(path(id) + '/prepare', input).then(value => value.data),
    start: (id: SystemRoleId, input: RoleStart): Promise<RoleRun> => api.post<RoleRun>(path(id) + '/runs', input).then(value => value.data),
    action: (run: RoleRun, action: 'cancel' | 'apply' | 'rollback', requestId: string): Promise<RoleRun> => api.post<RoleRun>(path(run.agentId) + '/runs/' + encodeURIComponent(run.id) + '/' + action,
        { expectedRevision: run.revision, requestId }).then(value => value.data),
};
