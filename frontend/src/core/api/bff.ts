import type {
    IAccessDecisionList,
    IAccessUsersList,
    IAiPlugin,
    IAiPluginVersion,
    IAuditEvent,
    IBackupStatus,
    IBundlePackage,
    ILocalProjectsImportResult,
    IOperationActionResult,
    IOperationDetail,
    IOperationPage,
    IPage,
    IProjectAsset,
    IProjectDetail,
    IProjectMember,
    IProjectSummary,
    IQuota,
    IRagBootstrapResult,
    IRagProjectSummary,
    IRagQuota,
    IRagRestoreResult,
    IRagSummary,
    ISkillDeleteResult,
    ISkillDirectoryResult,
    ISkillFile,
    ISkillListSummary,
    ISkillMutationResult,
    ISkillTreeNode,
    IStorageSummary,
} from './interfaces';

import type { IAuthMe } from '../interfaces';
import base from './base';
import { requireRagSuccess } from './ragResult';

/**
 * Контракт BFF API панели администратора.
 */
export type { IBffApi } from './bff.interfaces';
import type { IBffApi } from './bff.interfaces';

/**
 * Реализация клиента BFF API поверх axios.
 */
const bffApi: IBffApi = {
    me: async () => base.get<IAuthMe>('/auth/me', { skipUnauthorizedHandler: true }).then((r) => r.data),
    logout: async () =>
        base
            .post<{
                redirectUrl?: string;
            }>('/auth/logout', undefined, { skipUnauthorizedHandler: true })
            .then((r) => r.data),
    switchRole: async (role) =>
        base.post<IAuthMe>('/auth/switch-role', { role }, { skipUnauthorizedHandler: true }).then((r) => r.data),
    listProjects: async (params) => base.get<IPage<IProjectSummary>>('/api/projects', { params }).then((r) => r.data),
    getProject: async (id) => base.get<IProjectDetail>(`/api/projects/${id}`).then((r) => r.data),
    createProject: async ({ quota, ...payload }) =>
        base
            .post<IProjectDetail>('/api/projects', { ...payload, ...(quota ? { quotas: quota } : {}) })
            .then((r) => r.data),
    importLocalProjects: async (names: string[]) =>
        base.post<ILocalProjectsImportResult>('/api/projects/import-local', { names }).then((r) => r.data),
    updateProject: async (id, payload) =>
        base.patch<IProjectDetail>(`/api/projects/${id}`, payload).then((r) => r.data),
    listProjectMembers: async (projectId) =>
        base.get<IProjectMember[]>(`/api/projects/${projectId}/members`).then((r) => r.data),
    listProjectAssets: async (projectIdOrName) =>
        base.get<IProjectAsset[]>(`/api/projects/${encodeURIComponent(projectIdOrName)}/assets`).then((r) => r.data),
    projectCatalog: async (projectId) =>
        base.get<IProjectAsset[]>(`/api/projects/${encodeURIComponent(projectId)}/catalog`).then((r) => r.data),
    pinProjectAsset: async (projectId, payload) =>
        base
            .patch<{
                ok: boolean;
            }>(`/api/projects/${encodeURIComponent(projectId)}/assets/pin`, payload)
            .then((r) => r.data),
    addProjectAsset: async (projectIdOrName, payload) =>
        base
            .post<{
                ok: boolean;
            }>(`/api/projects/${encodeURIComponent(projectIdOrName)}/assets`, payload)
            .then((r) => r.data),
    removeProjectAsset: async (projectIdOrName, payload) =>
        base
            .delete<{
                ok: boolean;
            }>(`/api/projects/${encodeURIComponent(projectIdOrName)}/assets`, { data: payload })
            .then((r) => r.data),
    addProjectMember: async (projectId, payload) =>
        base.post<IProjectMember>(`/api/projects/${projectId}/members`, payload).then((r) => r.data),
    updateProjectMember: async (projectId, userId, payload) =>
        base
            .patch<IProjectMember>(
                `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
                payload,
            )
            .then((r) => r.data),
    removeProjectMember: async (projectId, userId, expectedRole) =>
        base
            .delete<{
                ok: true;
                userId: string;
            }>(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
                params: { expectedRole },
            })
            .then((r) => r.data),
    deleteProject: async (id) => base.delete<{ ok: true; id: string }>(`/api/projects/${id}`).then((r) => r.data),
    getSkillTree: async () => base.get<ISkillTreeNode[]>('/api/skills/tree').then((r) => r.data),
    listSkills: async (params) => base.get<ISkillListSummary[]>('/api/skills', { params }).then((r) => r.data),
    getSkill: async (path, version) =>
        (version === undefined
            ? base.get<ISkillFile>(`/api/skills/${path}`)
            : base.get<ISkillFile>(`/api/skills/${path}`, { params: { version } })
        ).then((r) => r.data),
    createSkill: async (payload) => base.post<ISkillMutationResult>('/api/skills', payload).then((r) => r.data),
    updateSkill: async (path, payload) =>
        base.put<ISkillMutationResult>(`/api/skills/${path}`, payload).then((r) => r.data),
    deleteSkill: async (path) => base.delete<ISkillDeleteResult>(`/api/skills/${path}`).then((r) => r.data),
    createSkillDirectory: async (path) =>
        base.post<ISkillDirectoryResult>('/api/skills/directory', { path }).then((r) => r.data),
    listRagProjects: async () =>
        base
            .get<{
                projects: IRagProjectSummary[];
            }>('/api/rag/projects')
            .then((r) => r.data.projects),
    getRagSummary: async (projectKey) =>
        base.get<IRagSummary>('/api/rag/summary', { params: { projectKey } }).then((r) => r.data),
    getRagQuota: async (projectKey) =>
        base.get<IRagQuota>('/api/rag/quota', { params: { projectKey } }).then((r) => r.data),
    updateRagQuota: async (projectKey, payload) =>
        base
            .patch<IRagQuota>('/api/rag/quota', {
                projectKey,
                limitBytes: payload.limitBytes,
                expectedRevision: payload.expectedRevision,
            })
            .then((r) => r.data),
    restoreLocalRag: async (projectKey) =>
        base.post<IRagRestoreResult>('/api/rag/restore-local', { projectKey }).then((r) => requireRagSuccess(r.data)),
    bootstrapRag: async (projectKey) =>
        base.post<IRagBootstrapResult>('/api/rag/bootstrap', { projectKey }).then((r) => requireRagSuccess(r.data)),
    listOperations: async (params) =>
        base
            .get<IOperationPage>('/api/operations', {
                params,
                timeout: 30000,
            })
            .then((r) => r.data),
    getOperation: async (operationId) =>
        base.get<IOperationDetail>(`/api/operations/${operationId}`).then((r) => r.data),
    retryOperation: async (operationId, requestKey, expectedDigest) =>
        base
            .post<IOperationActionResult>(
                `/api/operations/${encodeURIComponent(operationId)}/retry`,
                {
                    requestKey,
                    expectedDigest,
                },
                { timeout: 10000 },
            )
            .then((r) => r.data),
    cancelOperation: async (operationId, requestKey, expectedDigest) =>
        base
            .post<IOperationActionResult>(
                `/api/operations/${encodeURIComponent(operationId)}/cancel`,
                {
                    requestKey,
                    expectedDigest,
                },
                { timeout: 10000 },
            )
            .then((r) => r.data),
    listAudit: async (params) => base.get<IPage<IAuditEvent>>('/api/audit', { params }).then((r) => r.data),
    getStorage: async () => base.get<IStorageSummary>('/api/maintenance/storage').then((r) => r.data),
    getBackup: async () => base.get<IBackupStatus>('/api/maintenance/backup').then((r) => r.data),
    backupNow: async () => base.post('/api/maintenance/backup').then(() => undefined),
    updateQuotas: async (projectId, payload) =>
        base.patch<IQuota>(`/api/projects/${projectId}/quotas`, payload).then((r) => r.data),
    updateRetention: async (projectId, payload) =>
        base
            .patch<{
                retention: number;
            }>(`/api/projects/${projectId}/retention`, payload)
            .then((r) => r.data),
    listAiPlugins: async (params) =>
        base
            .get<{
                items: IAiPlugin[];
                total: number;
                page: number;
                size: number;
            }>('/api/ai-plugins', {
                params: { size: params?.pageSize ?? 100, ...(params?.page !== undefined ? { page: params.page } : {}) },
            })
            .then((r) => r.data),
    getAiPlugin: async (id) => base.get<IAiPlugin>(`/api/ai-plugins/${encodeURIComponent(id)}`).then((r) => r.data),
    createAiPlugin: async (body) => base.post<IAiPlugin>('/api/ai-plugins', body).then((r) => r.data),
    updateAiPlugin: async (id, body) =>
        base.patch<IAiPlugin>(`/api/ai-plugins/${encodeURIComponent(id)}`, body).then((r) => r.data),
    listAiPluginVersions: async (id) =>
        base.get<IAiPluginVersion[]>(`/api/ai-plugins/${encodeURIComponent(id)}/versions`).then((r) => r.data),
    getAiPluginPackage: async (id, version) =>
        base
            .get<IBundlePackage>(`/api/ai-plugins/${encodeURIComponent(id)}/package`, { params: { version } })
            .then((r) => r.data),
    deleteAiPlugin: async (id) =>
        base
            .delete<{
                ok: boolean;
                id: string;
            }>(`/api/ai-plugins/${encodeURIComponent(id)}`)
            .then((r) => r.data),
    getDecisions: async (scope) =>
        base.get<IAccessDecisionList>('/api/me/decisions', { params: { scope } }).then((r) => r.data),
    getAccessUsers: async () => base.get<IAccessUsersList>('/api/access/users').then((r) => r.data),
};

export default bffApi;
