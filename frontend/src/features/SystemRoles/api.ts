import api from '../../core/api/base';
import type { IRoleMcpReceipt } from '../../../../services/shared/system-role-mcp.cjs';
import type { IRoleOverview, IRolePrepared, IRoleRun, IRoleSelection, IRoleStart, TSystemRoleId } from './interfaces';
const base = '/api/system-roles',
    path = (id: TSystemRoleId): string => base + '/' + id;
/** Preview is read-only; a paid start always carries explicit consent and exact model/source pins. */
export const systemRolesApi = {
    overview: (projectId?: string): Promise<IRoleOverview> =>
        api.get<IRoleOverview>(base, { params: { projectId } }).then((value) => value.data),
    list: (id: TSystemRoleId, projectId?: string): Promise<IRoleRun[]> =>
        api.get<IRoleRun[]>(path(id) + '/runs', { params: { projectId } }).then((value) => value.data),
    get: (id: TSystemRoleId, run: string): Promise<IRoleRun> =>
        api.get<IRoleRun>(path(id) + '/runs/' + encodeURIComponent(run)).then((value) => value.data),
    mcpCalls: (run: string): Promise<IRoleMcpReceipt[]> =>
        api
            .get<IRoleMcpReceipt[]>('/api/system-role-mcp/runs/' + encodeURIComponent(run) + '/calls')
            .then((value) => value.data),
    prepare: (id: TSystemRoleId, input: IRoleSelection): Promise<IRolePrepared> =>
        api.post<IRolePrepared>(path(id) + '/prepare', input).then((value) => value.data),
    start: (id: TSystemRoleId, input: IRoleStart): Promise<IRoleRun> =>
        api.post<IRoleRun>(path(id) + '/runs', input).then((value) => value.data),
    action: (run: IRoleRun, action: 'cancel' | 'apply' | 'rollback', requestId: string): Promise<IRoleRun> =>
        api
            .post<IRoleRun>(path(run.agentId) + '/runs/' + encodeURIComponent(run.id) + '/' + action, {
                expectedRevision: run.revision,
                requestId,
            })
            .then((value) => value.data),
};
