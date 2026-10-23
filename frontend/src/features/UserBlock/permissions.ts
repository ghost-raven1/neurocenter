import type { IPolitic } from '../../core/interfaces';

/* ==== Политики (BFF politicName). Каждый politicName → список разрешённых ключей. ==== */

/** Политика прав профиля пользователя. */
export const userPolitics: IPolitic = { politicName: 'GET_PERMISSIONS_USER_PROFILE' };
/** Политика проекта (каталог). */
export const projectsPolitics: IPolitic = { politicName: 'GET_PERMISSIONS_LANCEDB_PROJECTS' };
/** Политика версий образа. */
export const versionsPolitics: IPolitic = { politicName: 'GET_PERMISSIONS_LANCEDB_VERSIONS' };
/** Политика скиллов. */
export const skillsPolitics: IPolitic = { politicName: 'GET_PERMISSIONS_LANCEDB_SKILLS' };
/** Политика MCP-пакетов. */
/** Политика операций. */
export const operationsPolitics: IPolitic = { politicName: 'GET_PERMISSIONS_LANCEDB_OPERATIONS' };
/** Политика обслуживания. */
export const maintenancePolitics: IPolitic = { politicName: 'GET_PERMISSIONS_LANCEDB_MAINTENANCE' };
/** Политика аудита. */
export const auditPolitics: IPolitic = { politicName: 'GET_PERMISSIONS_LANCEDB_AUDIT' };
/** Политика доступа. */
export const accessPolitics: IPolitic = { politicName: 'GET_PERMISSIONS_LANCEDB_ACCESS' };
/** Политика develop-индекса RAG. */
export const ragPolitics: IPolitic = { politicName: 'GET_PERMISSIONS_LANCEDB_RAG' };

/* ==== Ключи прав (ABAC action keys). ==== */

/** Ключ прав: создание проекта. */
export const projectCreateKey = 'projects#create';
/** Ключ прав: редактирование проекта. */
export const projectUpdateKey = 'projects#update';
/** Ключ прав: скачать снимок. */
export const imageDownloadKey = 'versions#image-download';
/** Ключ прав: публикация кандидата. */
export const imagePublishKey = 'versions#image-publish';
/** Ключ прав: активация / rollback head. */
export const imageHeadUpdateKey = 'versions#image-head-update';
/** Ключ прав: удаление снимка. */
export const imageDeleteKey = 'versions#image-delete';
/** Ключ прав: выпуск релизного профиля. */
export const profileManageKey = 'profiles#profile-manage';
/** Ключ прав: скачать скилл. */
export const skillDownloadKey = 'skills#read';
/** Ключ прав: публикация версии скилла. */
export const skillPublishKey = 'skills#publish';
/** Ключ прав: управление коллекцией скиллов. */
export const skillCollectionManageKey = 'skills#collection-manage';
/** Ключ прав: управление квотами. */
export const quotaManageKey = 'maintenance#quota-manage';
/** Ключ прав: управление retention. */
export const retentionManageKey = 'maintenance#retention-manage';
/** Ключ прав: бэкап/restore. */
export const backupManageKey = 'maintenance#backup-manage';
/** Ключ прав: просмотр аудита. */
export const auditReadKey = 'audit#read';
/** Ключ прав: управление операциями (retry/cancel). */
export const operationManageKey = 'operations#manage';
/** Ключ прав: просмотр develop-индекса RAG. */
export const ragReadKey = 'rag#read';

/* ==== Имена маршрутов (routePermissions). ==== */

export const PROJECT_ROUTE = 'projects';
export const PROJECT_DETAIL_ROUTE = 'projects-detail';
export const OPERATIONS_ROUTE = 'operations';
export const SKILLS_ROUTE = 'skills';
export const MAINTENANCE_ROUTE = 'maintenance';
export const AUDIT_ROUTE = 'audit';
export const ACCESS_ROUTE = 'access';
export const RAG_ROUTE = 'rag';
export const START_ROUTE = 'start';
export const STORE_ROUTE = 'store';

export const SETTINGS_ROUTE = 'settings';
export const HELP_ROUTE = 'help';
