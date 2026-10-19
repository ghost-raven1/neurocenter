/**
 * Типы domain-сущностей, возвращаемых BFF API (лancedb-storage).
 */

/** Статус снимка (snapshot). */
export type TSnapshotStatus = 'VERIFYING' | 'VERIFIED' | 'REJECTED' | 'DELETING' | 'DELETED';

/** Статус операции. */
export type TOperationState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'CONFLICT';

/** Тип операции. */
export type TOperationType = 'UPLOAD' | 'VERIFY' | 'DOWNLOAD' | 'SYNC' | 'RELEASE' | 'DELETE' | 'INSTALL' | 'CATALOG' | 'PROJECT';

/** Статус проекта. */
export type TProjectState = 'ACTIVE' | 'ARCHIVED' | 'LOCKED';

/** Scope скилла: общий или привязан к проекту. */
export type TSkillScope = 'common' | 'project';

/** Вид пакета. */
export type TPackageKind = 'LOCAL_MCP' | 'REMOTE_PROFILE' | 'PLUGIN';

/** Страница списка с пагинацией. */
export interface IPage<T> {
    items: T[];
    page: number;
    size: number;
    total: number;
}

/** Квоты проекта. */
export interface IQuota {
    currentBytesLimit: number;
    currentBytesUsed: number | null;
    retentionBytesLimit: number;
    retentionBytesUsed: number | null;
    stagingBytesLimit: number;
    stagingBytesUsed: number;
}

/** Develop-индекс RAG по projectKey (сводка). */
export interface IRagProjectSummary {
    projectKey: string;
    rowCount: number;
    lastSyncedAt: string | null;
    dimension: number;
}

/** Детальная сводка develop-индекса RAG по projectKey. */
export interface IRagSummary {
    projectKey: string;
    rowCount: number;
    lastSyncedAt: string | null;
    dimension: number;
    quota?: IRagQuota;
}

/** Действующее ограничение полезных данных серверной базы знаний. */
export interface IRagQuota {usedBytes:number;limitBytes:number;revision:number;maximumBytes:number;availableBytes:number;}

/** Результат bootstrap-индексации (локальная LanceDB → develop-индекс pgvector). */
export interface IRagBootstrapResult {
    ok: boolean;
    projectKey?: string;
    upserted?: number;
    deleted?: number;
    added?: number;
    removed?: number;
    remaining?: number;
    error?: string;
    message?: string;
    storePath?: string;
}

/** Результат обратной синхронизации (pgvector → локальная LanceDB). */
export interface IRagRestoreResult {
    ok: boolean;
    projectKey?: string;
    storePath?: string;
    sourceCount?: number;
    written?: number;
    deleted?: number;
    created?: boolean;
    dimension?: number;
    error?: string;
    message?: string;
    note?: string;
}

/** Краткая сводка по проекту (список). */
export interface IProjectSummary {
    id: string;
    name: string;
    externalResourceId: string;
    fsRootPath: string;
    state: TProjectState;
    head: { snapshotId: string; snapshotDate: string; author: string; headRevision: number } | null;
    logicalBytes: number | null;
    logicalSizeError?: string;
    retainedBytes: number | null;
    retainedSizeError?: string;
    retention: number;
    activeProfileId: string | null;
    activeProfileRevision: number;
    activeOperations: number;
}

/** Детальная карточка проекта. */
export interface IProjectDetail extends IProjectSummary {
    createdAt: string;
    quota: IQuota;
}

/** Сотрудник (участник) проекта. */
export interface IProjectMember {
    userId: string;
    principalName: string;
    displayName: string;
    role: string;
    addedAt: string;
}

/** Payload добавления сотрудника в проект. */
export interface IProjectMemberAdd {
    principalName: string;
    displayName?: string;
    role?: string;
}

/** Параметры списка проектов. */
export interface IProjectListParams {
    page: number;
    size: number;
    query?: string;
}

/** Сущность версии образа (snapshot). */
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

/** Результат согласованного обновления head/profile. */
export interface IHeadUpdateResult {
    headId: string;
    headRevision: number;
}

/** Параметры CAS-обновления head. */
export interface IHeadUpdateParams {
    expectedHeadId: string;
    expectedHeadRevision: number;
}

/** Пин скилла в профиле. */
export interface ISkillPin {
    skillSlug: string;
    skillId: string;
    skillVersionId: string;
}

/** Параметры релизного профиля. */
export interface IReleaseProfileParams {
    snapshotId: string;
    skillPins: ISkillPin[];
    expectedProfileId?: string;
    expectedProfileRevision?: number;
    moveHead?: IHeadUpdateParams;
}

/** Результат выпуска профиля. */
export interface IProfileReleaseResult {
    profileId: string;
    profileRevision: number;
    head: IHeadUpdateResult | null;
}

/** Версия профиля (релизный профиль проекта). */
export interface IProjectProfile {
    profileId: string;
    snapshotId: string;
    revision: number;
    isActive: boolean;
    skillPins: ISkillPin[];
}

/** Манифест снимка. */
export interface ISnapshotManifest {
    snapshotId: string;
    tables: { name: string; tableVersion: number }[];
    files: { path: string; size: number; sha256: string }[];
    signature: string;
}

/** Запись истории изменений скилла. */
export interface ISkillHistoryEntry {
    version: number;
    at: string;
    author: string;
    note?: string;
}

/** Закреплённая версия MCP/плагина с проверяемым SHA-256 пакета. */
export interface IDependencyPin {
    kind: 'mcp' | 'plugin';
    id: string;
    version: number;
    manifest: string;
}

/** Метаданные скилла (YAML-frontmatter `.md`). */
export interface ISkillMeta {
    name: string;
    slug: string;
    scope: TSkillScope;
    projectId?: string;
    description?: string;
    mcp: string[];
    plugins: string[];
    dependencies?: IDependencyPin[];
    specialization?: string;
    tags: string[];
    version: number;
    owner: string;
    updatedAt: string;
    history: ISkillHistoryEntry[];
}

/** Ресурс версии скилла: текст UTF-8 или канонический base64. */
export interface ISkillResource {path: string; content: string; encoding?: 'utf8' | 'base64';}

/** Скилл как файл: путь (без расширения), метаданные, markdown-тело. */
export interface ISkillFile {
    path: string;
    meta: ISkillMeta;
    body: string;
    resources?: ISkillResource[];
}

/** Файл уже сохранён; подтверждение записи аудита может прийти позже. */
export interface ISkillMutationReceipt { audit?: { state: 'pending' }; }
export interface ISkillMutationResult extends ISkillFile, ISkillMutationReceipt {}
export interface ISkillDeleteResult extends ISkillMutationReceipt { ok: true; path: string; }
export interface ISkillDirectoryResult extends ISkillMutationReceipt { ok: true; path: string; }

/** Лёгкое представление скилла для списка. */
export interface ISkillListSummary {
    path: string;
    meta: ISkillMeta;
}

/** Узел дерева каталога скиллов (папка или `.md`). */
export interface ISkillTreeNode {
    name: string;
    path: string;
    type: 'dir' | 'file';
    children?: ISkillTreeNode[];
    meta?: ISkillMeta;
}

/** Параметры создания скилла. */
export interface ISkillCreateRequest {
    resources?: ISkillResource[];
    path: string;
    slug: string;
    name: string;
    body: string;
    meta?: Partial<Pick<ISkillMeta, 'description' | 'projectId' | 'mcp' | 'plugins' | 'specialization' | 'tags' | 'dependencies'>>;
}

/** Параметры обновления скилла. */
export interface ISkillUpdateRequest {
    resources?: ISkillResource[];
    expectedVersion?: number;
    body?: string;
    name?: string;
    meta?: Partial<Pick<ISkillMeta, 'description' | 'projectId' | 'mcp' | 'plugins' | 'specialization' | 'tags' | 'dependencies'>>;
    note?: string;
}

/** Фильтры/параметры списка скиллов. */
export interface ISkillsListQuery {
    path?: string;
    projectKey?: string;
    query?: string;
    mcp?: string;
    plugin?: string;
}

/** Сущность операции (передача/проверка). */
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
}

/** Детали операции. */
export interface IOperationDetail extends IOperation {
    log: { at: string; level: string; message: string }[];
    retries: number;
}

/** Фильтры списка операций. */
export interface IOperationListParams {
    projectId?: string;
    type?: TOperationType;
    state?: TOperationState;
    page: number;
    size: number;
}

/** Событие аудита. */
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

/** Фильтры списка аудита. */
export interface IAuditListParams {
    actor?: string;
    action?: string;
    resourceType?: string;
    from?: string;
    to?: string;
    outcome?: string;
    page: number;
    size: number;
}

/** Сводка по хранилищу. */
export interface IStorageSummary {
    totalBytesUsed: number;
    totalBytesLimit: number;
    buckets: { name: string; bytesUsed: number }[];
    stagingBytesBudget: number;
}

/** Статус бэкапа. */
export interface IBackupStatus {
    lastBackupAt: string | null;
    backupLagSeconds: number;
    restoreDrills: { at: string; result: string }[];
}

/** Пакет MCP/плагин. */
export interface IPackage {
    id: string;
    collectionId: string;
    name: string;
    kind: TPackageKind;
    currentVersionId: string;
    compatibility: string;
    variantsCount: number;
    origin: string;
    pinnedInCount: number;
}

/** Платформенный вариант пакета. */
export interface IPackageVariant {
    variantId: string;
    os: string;
    architecture: string;
    runtime: string;
    bytes: number;
    entrypoint: string;
}

/** Детали пакета. */
export interface IPackageDetail {
    package: IPackage;
    manifestHash: string;
    variants: IPackageVariant[];
}

/** Файл MCP/плагина (манифест). */
export interface IAiPluginFile {
    path: string;
    size: number;
    digest: string;
    /** Текстовое содержимое файла (бандлы: skill/plugin/mcp). */
    content?: string;
}

/** Неизменяемая версия бандла (immutable history). */
export interface IAiPluginVersion {
    version: number;
    files: IAiPluginFile[];
    author: string;
    note: string;
    createdAt: string;
    metadata?: Pick<IAiPlugin, 'kind' | 'description' | 'compatibility' | 'tags' | 'origin' | 'revision' | 'dependencies'>;
}

/** Файл self-verified delivery-пакета. */
export interface IBundlePackageFile {
    path: string;
    size: number;
    sha256: string;
    content: string;
    encoding?: 'base64';
}

/** Self-verified delivery-пакет бандла (per-file sha256 + manifest). */
export interface IBundlePackage {
    schemaVersion: 2 | 3 | 4;
    config: IAiPluginConfig | null;
    plugin: { id: string; name: string; kind: string; version: number };
    files: IBundlePackageFile[];
    manifest: { sha256: string; createdAt: string; filesCount: number };
}

/** Актив (глоб. бандл/скилл) в проектном каталоге (добавлен админом проекта). */
export interface IProjectAsset {
    assetId: string;
    assetKind: 'mcp' | 'plugin' | 'skill';
    addedBy: string;
    addedAt: string;
}

/** Конфигурация подключения MCP/плагина (stdio/remote). */
export interface IAiPluginConfig {
    /** Платформенные комплекты и схема локальных параметров проверяются при редактировании и сервером. */
    extra?: {runtimeArtifacts?: unknown; localConfiguration?: unknown};
    headers?: Record<string, string>;
    transport?: string;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    /** Явная точка входа текстового пакета. */
    entrypoint?: string;
    /** false отключает OAuth; без поля OpenCode определяет его автоматически. */
    oauth?: false;
}

/** MCP/плагин (универсальная сущность). */
export interface IAiPlugin {
    id: string;
    name: string;
    kind: 'mcp' | 'plugin';
    description: string;
    version: number;
    compatibility: string | null;
    tags: string[];
    origin: string;
    revision: string | null;
    config: IAiPluginConfig | null;
    files: IAiPluginFile[];
    dependencies?: IDependencyPin[];
    createdAt: string;
    updatedAt: string;
}

/** Создание MCP/плагина. */
export interface IAiPluginCreate {
    name: string;
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
    /** Один ключ сохраняется при повторной отправке той же формы. */
    publicationKey?: string;
}

/** Обновление MCP/плагина. */
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

/** Итог автосоздания проектов из локальных каталогов. */
export interface ILocalProjectsImportResult {
    created: number;
    existing: number;
    total: number;
    createdNames: string[];
}

/** Итог импорта локальных MCP/плагинов в каталог. */
export interface ILocalImportResult {
    projectName: string;
    imported: number;
    updated: number;
    skipped: number;
    total: number;
}

/** Решение внешнего сервиса прав. */
export interface IAccessDecision {
    scope: string;
    scopeId: string;
    actions: string[];
    decisionId: string;
    policyRevision: number;
    ttlSeconds: number;
}

/** Ответ на запрос решений (access). */
export interface IAccessDecisionList {
    decisions: IAccessDecision[];
    externalServiceUrl: string | null;
}

/** Проект из доступов пользователя. */
export interface IAccessProjectRef {
    userId?: string;
    projectId: string;
    projectName: string;
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

/** Активность считается для всей области фильтра независимо от текущей страницы. */
export interface IOperationPage extends IPage<IOperation> {
    activeCount: number;
    /** Необязательно для совместимости с сервером до добавления сводного прогресса. */
    activeProgress?: { percent: number; running: number; queued: number };
}
