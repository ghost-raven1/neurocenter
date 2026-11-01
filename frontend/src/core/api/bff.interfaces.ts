import type {
    IAccessDecisionList,
    IAccessUsersList,
    IAiPlugin,
    IAiPluginCreate,
    IAiPluginUpdate,
    IAiPluginVersion,
    IAuditEvent,
    IAuditListParams,
    IBackupStatus,
    IBundlePackage,
    ILocalProjectsImportResult,
    IOperationActionResult,
    IOperationDetail,
    IOperationListParams,
    IOperationPage,
    IPage,
    IProjectAsset,
    IProjectDetail,
    IProjectListParams,
    IProjectMember,
    IProjectMemberAdd,
    IProjectSummary,
    IQuota,
    IRagBootstrapResult,
    IRagProjectSummary,
    IRagQuota,
    IRagRestoreResult,
    IRagSummary,
    ISkillCreateRequest,
    ISkillDeleteResult,
    ISkillDirectoryResult,
    ISkillFile,
    ISkillListSummary,
    ISkillMutationResult,
    ISkillsListQuery,
    ISkillTreeNode,
    ISkillUpdateRequest,
    IStorageSummary,
} from './interfaces';

import type { IAuthMe } from '../interfaces';

/** Browser-facing API operations and typed payloads. */
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
    projectCatalog: (projectId: string) => Promise<IProjectAsset[]>;
    pinProjectAsset: (
        projectId: string,
        payload: {
            assetId: string;
            assetKind: string;
            version: number;
            expectedVersion: number | null;
            expectedManifest: string | null;
        },
    ) => Promise<{ ok: boolean }>;
    addProjectAsset: (
        projectIdOrName: string,
        payload: {
            assetId: string;
            assetKind: 'mcp' | 'plugin' | 'skill';
        },
    ) => Promise<{ ok: boolean }>;
    removeProjectAsset: (
        projectIdOrName: string,
        payload: {
            assetId: string;
            assetKind: 'mcp' | 'plugin' | 'skill';
        },
    ) => Promise<{ ok: boolean }>;
    addProjectMember: (projectId: string, payload: IProjectMemberAdd) => Promise<IProjectMember>;
    updateProjectMember: (
        projectId: string,
        userId: string,
        payload: {
            role: string;
            expectedRole?: string;
        },
    ) => Promise<IProjectMember>;
    removeProjectMember: (
        projectId: string,
        userId: string,
        expectedRole?: string,
    ) => Promise<{
        ok: true;
        userId: string;
    }>;
    deleteProject: (id: string) => Promise<{ ok: true; id: string }>;
    createProject: (payload: {
        name: string;
        externalResourceId: string;
        retention?: number;
        quota?: IQuota;
    }) => Promise<IProjectDetail>;
    importLocalProjects: (names: string[]) => Promise<ILocalProjectsImportResult>;
    updateProject: (id: string, payload: Partial<Omit<IProjectDetail, 'quota' | 'head'>>) => Promise<IProjectDetail>;
    /* SKILLS (файловая модель: каталог CephFS, CRUD) */
    getSkillTree: () => Promise<ISkillTreeNode[]>;
    listSkills: (params: ISkillsListQuery) => Promise<ISkillListSummary[]>;
    getSkill: (path: string, version?: number) => Promise<ISkillFile>;
    createSkill: (payload: ISkillCreateRequest) => Promise<ISkillMutationResult>;
    updateSkill: (path: string, payload: ISkillUpdateRequest) => Promise<ISkillMutationResult>;
    deleteSkill: (path: string) => Promise<ISkillDeleteResult>;
    createSkillDirectory: (path: string) => Promise<ISkillDirectoryResult>;
    /* RAG (develop-индекс, PG + pgvector) */
    listRagProjects: () => Promise<IRagProjectSummary[]>;
    getRagSummary: (projectKey: string) => Promise<IRagSummary>;
    getRagQuota: (projectKey: string) => Promise<IRagQuota>;
    updateRagQuota: (
        projectKey: string,
        payload: {
            limitBytes: number;
            expectedRevision: number;
        },
    ) => Promise<IRagQuota>;
    restoreLocalRag: (projectKey: string) => Promise<IRagRestoreResult>;
    bootstrapRag: (projectKey: string) => Promise<IRagBootstrapResult>;
    /* OPERATIONS */
    listOperations: (params: IOperationListParams) => Promise<IOperationPage>;
    getOperation: (operationId: string) => Promise<IOperationDetail>;
    retryOperation: (
        operationId: string,
        requestKey: string,
        expectedDigest: string,
    ) => Promise<IOperationActionResult>;
    cancelOperation: (
        operationId: string,
        requestKey: string,
        expectedDigest: string,
    ) => Promise<IOperationActionResult>;
    /* AUDIT */
    listAudit: (params: IAuditListParams) => Promise<IPage<IAuditEvent>>;
    /* MAINTENANCE */
    getStorage: () => Promise<IStorageSummary>;
    getBackup: () => Promise<IBackupStatus>;
    backupNow: () => Promise<void>;
    updateQuotas: (projectId: string, payload: IQuota) => Promise<IQuota>;
    updateRetention: (projectId: string, payload: { retention: number }) => Promise<{ retention: number }>;
    /* PACKAGES */
    listAiPlugins: (params?: { pageSize?: number; page?: number }) => Promise<{
        items: IAiPlugin[];
        total: number;
        page: number;
        size: number;
    }>;
    getAiPlugin: (id: string) => Promise<IAiPlugin>;
    createAiPlugin: (body: IAiPluginCreate) => Promise<IAiPlugin>;
    updateAiPlugin: (id: string, body: IAiPluginUpdate) => Promise<IAiPlugin>;
    listAiPluginVersions: (id: string) => Promise<IAiPluginVersion[]>;
    getAiPluginPackage: (id: string, version?: number) => Promise<IBundlePackage>;
    deleteAiPlugin: (id: string) => Promise<{ ok: boolean; id: string }>;
    /* ACCESS */
    getDecisions: (scope: string) => Promise<IAccessDecisionList>;
    getAccessUsers: () => Promise<IAccessUsersList>;
}
