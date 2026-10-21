/**
 * DTO каталога — структуры ответов microservice (структурно совпадают с
 * `frontend/src/core/api/interfaces.ts`).
 */

import type { IDependencyPin } from '../../../shared/dependency-pins.cjs';

export type TSnapshotStatus = 'UPLOADING' | 'VERIFYING' | 'VERIFIED' | 'REJECTED' | 'DELETING' | 'DELETED';
export type TOperationState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'CONFLICT';
export type TOperationType = 'UPLOAD' | 'VERIFY' | 'DOWNLOAD' | 'SYNC' | 'RELEASE' | 'DELETE' | 'INSTALL' | 'CATALOG' | 'PROJECT' | 'BUILD' | 'MODEL';
export type TProjectState = 'ACTIVE' | 'ARCHIVED' | 'LOCKED';

export interface IPage<T> {
    items: T[];
    page: number;
    size: number;
    total: number;
}

export interface IQuota {
    currentBytesLimit: number;
    currentBytesUsed: number | null;
    retentionBytesLimit: number;
    retentionBytesUsed: number | null;
    stagingBytesLimit: number;
    stagingBytesUsed: number;
}

export interface IProjectSummary {
    id: string;
    name: string;
    externalResourceId: string;
    fsRootPath: string;
    state: TProjectState;
    head: { snapshotId: string; snapshotDate: string; author: string; headRevision: number } | null;
    headRevision: number;
    logicalBytes: number | null;
    retainedBytes: number | null;
    logicalSizeError?: string;
    retainedSizeError?: string;
    retention: number;
    activeProfileId: string | null;
    activeProfileRevision: number;
    activeOperations: number;
}

export interface IProjectDetail extends IProjectSummary {
    createdAt: string;
    quota: IQuota;
}

/**
 * Сотрудник (участник) проекта.
 */
export interface IProjectMember {
    userId: string;
    principalName: string;
    displayName: string;
    role: string;
    addedAt: string;
}

/**
 * Payload добавления сотрудника в проект.
 */
export interface IProjectMemberAdd {
    principalName: string;
    displayName?: string;
    role?: string;
}

/** Проект из доступов пользователя (строка таблицы «Доступ»). */
export interface IAccessProjectRef {
    projectId: string;
    projectName: string;
    /** Id участника в project_members (для смены роли/удаления без фабрикации на фронтенде). */
    userId: string;
    role: string;
}

/** Пользователь и проекты, к которым у него есть доступ. */
export interface IAccessUserRow {
    principalName: string;
    displayName: string;
    accesses: IAccessProjectRef[];
}

/** Ответ GET /api/access/users. */
export interface IAccessUsersList {
    users: IAccessUserRow[];
}

export interface IImageVersion {
    snapshotId: string;
    storeId: string;
    parentId: string | null;
    status: TSnapshotStatus;
    author: string;
    createdAt: string;
    bytes: number;
    formatVersion: string;
    isHead: boolean;
    pinned: boolean;
}

export interface IHeadUpdateResult {
    headId: string;
    headRevision: number;
}

export interface ISkillPin {
    id: string;
    version: number;
    manifest: string;
}

export interface IProfileReleaseResult {
    profileId: string;
    profileRevision: number;
    head: IHeadUpdateResult | null;
}

export interface IProjectProfile {
    profileId: string;
    snapshotId: string;
    revision: number;
    isActive: boolean;
    skillPins: ISkillPin[];
}

export interface ISnapshotManifest {
    snapshotId: string;
    tables: { name: string; tableVersion: number }[];
    files: { path: string; size: number; sha256: string }[];
    signature: string;
}

export interface IOperation {
    operationId: string;
    type: TOperationType;
    projectId: string | null;
    resourceType: string;
    resourceId: string;
    actor: string;
    state: TOperationState;
    percent: number;
    bytesDone: number;
    bytesTotal: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    bridgeJob?: { kind: string; retrySupported: boolean; minimumLevel: number };
    actions?: {
        executor: 'bridge'|'rag-reindex'|'model-hosting'|'tool-build'|'history'; digest: string;
        retry: {supported:boolean;reason?:string}; cancel: {supported:boolean;reason?:string};
    };
}

export interface IOperationDetail extends IOperation {
    log: { at: string; level: string; message: string }[];
    retries: number;
}

export interface IAuditEvent {
    source?: 'operation'|'security';
    details?: {before:unknown;after:unknown}|null;
    id: string;
    at: string;
    actor: string;
    versionAuthor: string;
    action: string;
    resourceType: string;
    resourceId: string;
    outcome: string;
    decisionId: string;
    correlationId: string;
}

export interface IStorageSummary {
    totalBytesUsed: number;
    totalBytesLimit: number;
    buckets: { name: string; bytesUsed: number }[];
    stagingBytesBudget: number;
}

export interface IBackupStatus {
    lastBackupAt: string | null;
    backupLagSeconds: number;
    restoreDrills: { at: string; result: string }[];
}

/** Файл MCP/плагина (манифест; бинарные — в origin/объектном хранилище). */
export interface IAiPluginFile {
    path: string;
    size: number;
    digest: string;
    /** Текстовое содержимое файла (текстовые бандлы: skill/plugin/mcp). */
    content?: string;
}

/** Неизменяемая версия бандла MCP/плагина (дерево файлов + конфиг). */
export interface IAiPluginVersion {
    version: number;
    files: IAiPluginFile[];
    config: IAiPluginConfig | null;
    author: string;
    note: string;
    createdAt: string;
    metadata?: Pick<IAiPlugin, 'kind' | 'description' | 'compatibility' | 'tags' | 'origin' | 'revision' | 'dependencies'>;
}

/** Конфиг подключения MCP-сервера / плагина (stdio или remote). */
export interface IAiPluginConfig {
    transport?: 'stdio' | 'remote';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    extra?: Record<string, unknown>;
    /** Явная точка входа текстового пакета. */
    entrypoint?: string;
    /** false отключает OAuth; без поля OpenCode определяет его автоматически. */
    oauth?: false;
}

/** MCP-сервер или плагин — отдельная сущность каталога. */
export interface IAiPlugin {
    archivedAt?: string;
    id: string;
    name: string;
    kind: 'mcp' | 'plugin';
    description: string;
    version: number;
    compatibility: string | null;
    tags: string[];
    /** Источник файлов: 'git:<url>' | 'upload' | 'internal'. */
    origin: string;
    /** Git-референс (ветка/тег) при origin=git. */
    revision: string | null;
    config: IAiPluginConfig | null;
    files: IAiPluginFile[];
    /** Закреплённые зависимости входят в неизменяемое содержимое версии. */
    dependencies?: IDependencyPin[];
    createdAt: string;
    updatedAt: string;
}

/** Payload создания MCP/плагина. */
export interface IAiPluginCreate {
    name: string;
    kind: 'mcp' | 'plugin';
    description: string;
    version?: number;
    compatibility?: string;
    tags?: string[];
    origin?: string;
    revision?: string | null;
    config?: IAiPluginConfig | null;
    files?: IAiPluginFile[];
    dependencies?: IDependencyPin[];
    /** Один ключ сохраняется при повторной отправке той же формы. */
    publicationKey?: string;
}

/** Итог автосоздания проектов из локальных каталогов. */
export interface ILocalProjectsImportResult {
    created: number;
    existing: number;
    total: number;
    createdNames: string[];
}



/** Payload обновления MCP/плагина. */
export interface IAiPluginUpdate {
    kind?: 'mcp' | 'plugin';
    description?: string;
    version?: number;
    compatibility?: string | null;
    tags?: string[];
    origin?: string;
    revision?: string | null;
    config?: IAiPluginConfig | null;
    files?: IAiPluginFile[];
    dependencies?: IDependencyPin[];
    /** Версия, которую редактировал пользователь; защищает от потери чужих изменений. */
    expectedVersion?: number;
}

export interface IAccessDecision {
    scope: string;
    scopeId: string;
    actions: string[];
    decisionId: string;
    policyRevision: number;
    ttlSeconds: number;
}

export interface IAccessDecisionList {
    decisions: IAccessDecision[];
    externalServiceUrl: string | null;
}

/** Актив (глоб. бандл/скилл), добавленный проектным админом в проект. */
export interface IProjectAsset {
    assetId: string;
    assetKind: 'mcp' | 'plugin' | 'skill';
    addedBy: string;
    addedAt: string;
    version?: number | null;
    manifest?: string | null;
    pinOrigin?: 'unresolved' | 'assigned' | 'manual' | 'migration-current';
    pinError?: string;
}

/** Активность считается для всей области фильтра независимо от текущей страницы. */
export interface IOperationPage extends IPage<IOperation> {
    activeCount: number;
    /** Средний процент активных операций; без оценки байтов и оставшегося времени. */
    activeProgress: { percent: number; running: number; queued: number };
}
