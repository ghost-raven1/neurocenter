import {
    IAccessDecisionList,
    IAccessUsersList,
    IBackupStatus,
    IAuditEvent,
    IAuditListParams,
    IHeadUpdateResult,
    IImageVersion,
    IOperation,
    IOperationPage,
    IOperationDetail,
    IOperationListParams,
    IPage,
    IRagProjectSummary,
    IRagSummary,
    IRagQuota,
    IRagBootstrapResult,
    IRagRestoreResult,
    IPackage,
    IPackageDetail,
    IProfileReleaseResult,
    IProjectDetail,
    IProjectListParams,
    IProjectMember,
    IProjectMemberAdd,
    IProjectProfile,
    IProjectSummary,
    ISkillCreateRequest,
    ISkillFile,
    ISkillMutationResult,
    ISkillDeleteResult,
    ISkillDirectoryResult,
    IAiPlugin,
    IAiPluginCreate,
    IAiPluginFile,
    IAiPluginUpdate,
    IAiPluginVersion,
    IBundlePackage,
    IProjectAsset,
    ILocalImportResult,
    ILocalProjectsImportResult,
    ISkillListSummary,
    ISkillPin,
    ISkillTreeNode,
    ISkillUpdateRequest,
    ISkillsListQuery,
    ISnapshotManifest,
    IStorageSummary,
    IQuota,
} from './interfaces';
import type { IAuthMe } from '../interfaces';
import base from './base';
import { requireRagSuccess } from './ragResult';

/**
 * Контракт BFF API панели администратора.
 * Бэкенд не реализован — контракт предложен и должен быть сверен с NestJS.
 */
export interface IBffApi {
    /* AUTH */
    me: () => Promise<IAuthMe>;
    logout: () => Promise<{ redirectUrl?: string }>;
    switchRole: (role: string) => Promise<IAuthMe>;
    /* PROJECTS */
    listProjects: (params: IProjectListParams) => Promise<IPage<IProjectSummary>>;
    getProject: (id: string) => Promise<IProjectDetail>;
    listProjectMembers: (projectId: string) => Promise<IProjectMember[]>;
    listProjectAssets: (projectIdOrName: string) => Promise<IProjectAsset[]>;
    addProjectAsset: (projectIdOrName: string, payload: { assetId: string; assetKind: 'mcp' | 'plugin' | 'skill' }) => Promise<{ ok: boolean }>;
    removeProjectAsset: (projectIdOrName: string, payload: { assetId: string; assetKind: 'mcp' | 'plugin' | 'skill' }) => Promise<{ ok: boolean }>;
    addProjectMember: (projectId: string, payload: IProjectMemberAdd) => Promise<IProjectMember>;
    updateProjectMember: (projectId: string, userId: string, payload: { role: string; expectedRole?: string }) => Promise<IProjectMember>;
    removeProjectMember: (projectId: string, userId: string, expectedRole?: string) => Promise<{ ok: true; userId: string }>;
    deleteProject: (id: string) => Promise<{ ok: true; id: string }>;
    createProject: (payload: { name: string; externalResourceId: string; retention?: number; quota?: IQuota }) => Promise<IProjectDetail>;
    importLocalProjects: (names: string[]) => Promise<ILocalProjectsImportResult>;
    updateProject: (id: string, payload: Partial<Omit<IProjectDetail, 'quota' | 'head'>>) => Promise<IProjectDetail>;
    /* IMAGE VERSIONS */
    listVersions: (projectId: string, status?: string) => Promise<IImageVersion[]>;
    getManifest: (projectId: string, snapshotId: string) => Promise<ISnapshotManifest>;
    activateHead: (projectId: string, snapshotId: string, payload: { expectedHeadId: string; expectedHeadRevision: number }) => Promise<IHeadUpdateResult>;
    rollbackHead: (projectId: string, snapshotId: string, payload: { expectedHeadId: string; expectedHeadRevision: number }) => Promise<IHeadUpdateResult>;
    deleteSnapshot: (projectId: string, snapshotId: string, payload?: { gracePeriodHours?: number }) => Promise<{ operationId: string }>;
    releaseProfile: (projectId: string, payload: { snapshotId: string; skillPins: ISkillPin[]; expectedProfileId?: string; expectedProfileRevision?: number; moveHead?: { expectedHeadId: string; expectedHeadRevision: number } }) => Promise<IProfileReleaseResult>;
    listProfiles: (projectId: string) => Promise<IProjectProfile[]>;
    /* SKILLS (файловая модель: каталог CephFS, CRUD) */
    getSkillTree: () => Promise<ISkillTreeNode[]>;
    listSkills: (params: ISkillsListQuery) => Promise<ISkillListSummary[]>;
    getSkill: (path: string) => Promise<ISkillFile>;
    createSkill: (payload: ISkillCreateRequest) => Promise<ISkillMutationResult>;
    updateSkill: (path: string, payload: ISkillUpdateRequest) => Promise<ISkillMutationResult>;
    deleteSkill: (path: string) => Promise<ISkillDeleteResult>;
    createSkillDirectory: (path: string) => Promise<ISkillDirectoryResult>;
    /* RAG (develop-индекс, PG + pgvector) */
    listRagProjects: () => Promise<IRagProjectSummary[]>;
    getRagSummary: (projectKey: string) => Promise<IRagSummary>;
    getRagQuota: (projectKey:string) => Promise<IRagQuota>;
    updateRagQuota: (projectKey:string,payload:{limitBytes:number;expectedRevision:number}) => Promise<IRagQuota>;
    restoreLocalRag: (projectKey: string) => Promise<IRagRestoreResult>;
    bootstrapRag: (projectKey: string) => Promise<IRagBootstrapResult>;
    /* OPERATIONS */
    listOperations: (params: IOperationListParams) => Promise<IOperationPage>;
    getOperation: (operationId: string) => Promise<IOperationDetail>;
    retryOperation: (operationId: string) => Promise<IOperation>;
    cancelOperation: (operationId: string) => Promise<IOperation>;
    /* AUDIT */
    listAudit: (params: IAuditListParams) => Promise<IPage<IAuditEvent>>;
    /* MAINTENANCE */
    getStorage: () => Promise<IStorageSummary>;
    getBackup: () => Promise<IBackupStatus>;
    backupNow: () => Promise<void>;
    restore: (checkpointId: string) => Promise<{ operationId: string }>;
    updateQuotas: (projectId: string, payload: IQuota) => Promise<IQuota>;
    updateRetention: (projectId: string, payload: { retention: number }) => Promise<{ retention: number }>;
    /* PACKAGES */
    listPackageCollections: () => Promise<{ id: string; title: string }[]>;
    listPackages: (params: { collectionId: string }) => Promise<IPackage[]>;
    getPackage: (packageId: string) => Promise<IPackageDetail>;
    listAiPlugins: (params?: { pageSize?: number; page?: number }) => Promise<{ items: IAiPlugin[]; total: number; page: number; size: number }>;
    getAiPlugin: (id: string) => Promise<IAiPlugin>;
    createAiPlugin: (body: IAiPluginCreate) => Promise<IAiPlugin>;
    updateAiPlugin: (id: string, body: IAiPluginUpdate) => Promise<IAiPlugin>;
    getAiPluginFile: (id: string, filePath: string, version?: number) => Promise<IAiPluginFile>;
    listAiPluginVersions: (id: string) => Promise<IAiPluginVersion[]>;
    activateAiPluginVersion: (id: string, version: number) => Promise<IAiPlugin>;
    getAiPluginPackage: (id: string, version?: number) => Promise<IBundlePackage>;
    deleteAiPlugin: (id: string) => Promise<{ ok: boolean; id: string }>;
    importLocalAiPlugins: (projectName: string) => Promise<ILocalImportResult>;
    scanLocalAssets: (params?: { q?: string; maxProjects?: number }) => Promise<{ root: string; query: string | null; projects: { project: string; path: string; skills: string[]; mcpServers: string[]; plugins: string[] }[]; scannedCount: number; totalProjects: number }>;
    installLocalAsset: (body: { kind: 'mcp' | 'plugin' | 'skill'; name: string; projectName: string; content?: string; config?: Record<string, unknown>; origin?: string; files?: { path: string; content: string }[]; action?: 'install' | 'uninstall'; dryRun?: boolean }) => Promise<{ kind: string; name: string; action: string; targetPath: string; affected: string; dryRun: boolean }>;
    /* ACCESS */
    getDecisions: (scope: string) => Promise<IAccessDecisionList>;
    getAccessUsers: () => Promise<IAccessUsersList>;
}

/**
 * Реализация клиента BFF API поверх axios.
 */
const bffApi: IBffApi = {
    me: async () => base.get<IAuthMe>('/auth/me', { skipUnauthorizedHandler: true }).then(r => r.data),
    logout: async () => base.post<{ redirectUrl?: string }>('/auth/logout', undefined, { skipUnauthorizedHandler: true }).then(r => r.data),
    switchRole: async (role) => base.post<IAuthMe>('/auth/switch-role', { role }, { skipUnauthorizedHandler: true }).then(r => r.data),
    listProjects: async (params) => base.get<IPage<IProjectSummary>>('/api/projects', { params }).then(r => r.data),
    getProject: async (id) => base.get<IProjectDetail>(`/api/projects/${id}`).then(r => r.data),
    createProject: async ({ quota, ...payload }) => base.post<IProjectDetail>('/api/projects', { ...payload, ...(quota?{quotas:quota}:{}) }).then(r => r.data),
    importLocalProjects: async (names: string[]) => base.post<ILocalProjectsImportResult>('/api/projects/import-local', { names }).then(r => r.data),
    updateProject: async (id, payload) => base.patch<IProjectDetail>(`/api/projects/${id}`, payload).then(r => r.data),
    listProjectMembers: async (projectId) => base.get<IProjectMember[]>(`/api/projects/${projectId}/members`).then(r => r.data),
    listProjectAssets: async (projectIdOrName) => base.get<IProjectAsset[]>(`/api/projects/${encodeURIComponent(projectIdOrName)}/assets`).then(r => r.data),
    addProjectAsset: async (projectIdOrName, payload) => base.post<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectIdOrName)}/assets`, payload).then(r => r.data),
    removeProjectAsset: async (projectIdOrName, payload) => base.delete<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectIdOrName)}/assets`, { data: payload }).then(r => r.data),
    addProjectMember: async (projectId, payload) => base.post<IProjectMember>(`/api/projects/${projectId}/members`, payload).then(r => r.data),
    updateProjectMember: async (projectId, userId, payload) => base.patch<IProjectMember>(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, payload).then(r => r.data),
    removeProjectMember: async (projectId, userId, expectedRole) => base.delete<{ ok: true; userId: string }>(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {params:{expectedRole}}).then(r => r.data),
    deleteProject: async (id) => base.delete<{ ok: true; id: string }>(`/api/projects/${id}`).then(r => r.data),
    listVersions: async (projectId, status) => base.get<IImageVersion[]>(`/api/projects/${projectId}/versions`, { params: { status } }).then(r => r.data),
    getManifest: async (projectId, snapshotId) => base.get<ISnapshotManifest>(`/api/projects/${projectId}/versions/${snapshotId}/manifest`).then(r => r.data),
    activateHead: async (projectId, snapshotId, payload) => base.post<IHeadUpdateResult>(`/api/projects/${projectId}/versions/${snapshotId}/activate`, payload).then(r => r.data),
    rollbackHead: async (projectId, snapshotId, payload) => base.post<IHeadUpdateResult>(`/api/projects/${projectId}/versions/${snapshotId}/rollback`, payload).then(r => r.data),
    deleteSnapshot: async (projectId, snapshotId, payload) => base.delete<{ operationId: string }>(`/api/projects/${projectId}/versions/${snapshotId}`, { data: payload }).then(r => r.data),
    releaseProfile: async (projectId, payload) => base.post<IProfileReleaseResult>(`/api/projects/${projectId}/release-profile`, payload).then(r => r.data),
    listProfiles: async (projectId) => base.get<IProjectProfile[]>(`/api/projects/${projectId}/profiles`).then(r => r.data),
    getSkillTree: async () => base.get<ISkillTreeNode[]>('/api/skills/tree').then(r => r.data),
    listSkills: async (params) => base.get<ISkillListSummary[]>('/api/skills', { params }).then(r => r.data),
    getSkill: async (path) => base.get<ISkillFile>(`/api/skills/${path}`).then(r => r.data),
    createSkill: async (payload) => base.post<ISkillMutationResult>('/api/skills', payload).then(r => r.data),
    updateSkill: async (path, payload) => base.put<ISkillMutationResult>(`/api/skills/${path}`, payload).then(r => r.data),
    deleteSkill: async (path) => base.delete<ISkillDeleteResult>(`/api/skills/${path}`).then(r => r.data),
    createSkillDirectory: async (path) => base.post<ISkillDirectoryResult>('/api/skills/directory', { path }).then(r => r.data),
    listRagProjects: async () => base.get<{ projects: IRagProjectSummary[] }>('/api/rag/projects').then(r => r.data.projects),
    getRagSummary: async (projectKey) => base.get<IRagSummary>('/api/rag/summary', { params: { projectKey } }).then(r => r.data),
    getRagQuota: async(projectKey)=>base.get<IRagQuota>('/api/rag/quota',{params:{projectKey}}).then(r=>r.data),
    updateRagQuota: async(projectKey,payload)=>base.patch<IRagQuota>('/api/rag/quota',{projectKey,limitBytes:payload.limitBytes,expectedRevision:payload.expectedRevision}).then(r=>r.data),
    restoreLocalRag: async (projectKey) => base.post<IRagRestoreResult>('/api/rag/restore-local', { projectKey }).then(r => requireRagSuccess(r.data)),
    bootstrapRag: async (projectKey) => base.post<IRagBootstrapResult>('/api/rag/bootstrap', { projectKey }).then(r => requireRagSuccess(r.data)),
    listOperations: async (params) => base.get<IOperationPage>('/api/operations', { params }).then(r => r.data),
    getOperation: async (operationId) => base.get<IOperationDetail>(`/api/operations/${operationId}`).then(r => r.data),
    retryOperation: async (operationId) => base.post<IOperation>(`/api/operations/${operationId}/retry`).then(r => r.data),
    cancelOperation: async (operationId) => base.post<IOperation>(`/api/operations/${operationId}/cancel`).then(r => r.data),
    listAudit: async (params) => base.get<IPage<IAuditEvent>>('/api/audit', { params }).then(r => r.data),
    getStorage: async () => base.get<IStorageSummary>('/api/maintenance/storage').then(r => r.data),
    getBackup: async () => base.get<IBackupStatus>('/api/maintenance/backup').then(r => r.data),
    backupNow: async () => base.post('/api/maintenance/backup').then(() => undefined),
    restore: async (checkpointId) => base.post<{ operationId: string }>('/api/maintenance/restore', { checkpointId }).then(r => r.data),
    updateQuotas: async (projectId, payload) => base.patch<IQuota>(`/api/projects/${projectId}/quotas`, payload).then(r => r.data),
    updateRetention: async (projectId, payload) => base.patch<{ retention: number }>(`/api/projects/${projectId}/retention`, payload).then(r => r.data),
    listPackageCollections: async () => base.get<{ id: string; title: string }[]>('/api/packages/collections').then(r => r.data),
    listPackages: async (params) => base.get<IPage<IPackage>>('/api/packages', { params }).then(r => r.data.items),
    getPackage: async (packageId) => base.get<IPackageDetail>(`/api/packages/${packageId}`).then(r => r.data),
    listAiPlugins: async (params) => base
        .get<{ items: IAiPlugin[]; total: number; page: number; size: number }>('/api/ai-plugins', { params: { size: params?.pageSize ?? 100, ...(params?.page !== undefined ? {page: params.page} : {}) } })
        .then(r => r.data),
    getAiPlugin: async (id) => base.get<IAiPlugin>(`/api/ai-plugins/${encodeURIComponent(id)}`).then(r => r.data),
    createAiPlugin: async (body) => base.post<IAiPlugin>('/api/ai-plugins', body).then(r => r.data),
    updateAiPlugin: async (id, body) => base.patch<IAiPlugin>(`/api/ai-plugins/${encodeURIComponent(id)}`, body).then(r => r.data),
    getAiPluginFile: async (id, filePath, version) => base
        .get<IAiPluginFile>(`/api/ai-plugins/${encodeURIComponent(id)}/files`, { params: { path: filePath, version } })
        .then(r => r.data),
    listAiPluginVersions: async (id) => base
        .get<IAiPluginVersion[]>(`/api/ai-plugins/${encodeURIComponent(id)}/versions`)
        .then(r => r.data),
    activateAiPluginVersion: async (id, version) => base
        .post<IAiPlugin>(`/api/ai-plugins/${encodeURIComponent(id)}/versions/${version}/activate`)
        .then(r => r.data),
    getAiPluginPackage: async (id, version) => base
        .get<IBundlePackage>(`/api/ai-plugins/${encodeURIComponent(id)}/package`, { params: { version } })
        .then(r => r.data),
    deleteAiPlugin: async (id) => base.delete<{ ok: boolean; id: string }>(`/api/ai-plugins/${encodeURIComponent(id)}`).then(r => r.data),
    importLocalAiPlugins: async (projectName: string) => base.post<ILocalImportResult>('/api/ai-plugins/import-local', { projectName }).then(r => r.data),
    scanLocalAssets: async (params) => base.get('/api/local-assets/scan', { params }).then(r => r.data),
    installLocalAsset: async (body) => base.post('/api/local-assets/install', body).then(r => r.data),
    getDecisions: async (scope) => base.get<IAccessDecisionList>('/api/me/decisions', { params: { scope } }).then(r => r.data),
    getAccessUsers: async () => base.get<IAccessUsersList>('/api/access/users').then(r => r.data),
};

export default bffApi;
