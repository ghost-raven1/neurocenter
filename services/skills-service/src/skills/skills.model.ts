/**
 * Версия скилла: инструкция, метаданные и переносимые ресурсы в файловом хранилище.
 */

import type { IDependencyPin } from '../../../shared/dependency-pins.cjs';

export type TScope = 'common' | 'project';
export type TNodeType = 'dir' | 'file';

export interface IHistoryEntry {
    version: number;
    at: string;
    author: string;
    note?: string;
}

export interface ISkillMeta {
    /** Отличает новую публикацию после удаления от прежней истории того же пути. */
    generation?: string;
    name: string;
    slug: string;
    scope: TScope;
    projectId?: string;
    description?: string;
    mcp: string[];
    plugins: string[];
    /** Явные версии MCP/плагинов; legacy-имена выше не подменяются текущим head. */
    dependencies?: IDependencyPin[];
    specialization?: string;
    tags: string[];
    version: number;
    owner: string;
    updatedAt: string;
    history: IHistoryEntry[];
}

export interface ISkillAuditReceipt { audit?: {state:'pending'}; }

/** Скилл как файл: относительный путь (без расширения), метаданные, тело. */
export interface ISkillFile extends ISkillAuditReceipt {
    path: string;
    meta: ISkillMeta;
    body: string;
    resources?: ISkillResource[];
}

/** Бинарные ресурсы передаются каноническим base64; текст — UTF-8. */
export interface ISkillResource {
    path: string;
    content: string;
    encoding?: 'utf8' | 'base64';
}

/** Лёгкое представление скилла для списков (без тела). */
export interface ISkillListSummary {
    path: string;
    meta: ISkillMeta;
}

/** Узел дерева каталога скиллов (папка или `.md`-файл). */
export interface ISkillTreeNode {
    name: string;
    path: string;
    type: TNodeType;
    children?: ISkillTreeNode[];
    meta?: ISkillMeta;
}

export interface ISkillCreateRequest {
    path: string;
    slug: string;
    name: string;
    body: string;
    resources?: ISkillResource[];
    meta?: Partial<Omit<ISkillMeta, 'generation' | 'version' | 'history' | 'updatedAt' | 'owner' | 'slug'>>;
}

export interface ISkillUpdateRequest {
    expectedVersion?: number;
    body?: string;
    resources?: ISkillResource[];
    name?: string;
    meta?: Partial<Omit<ISkillMeta, 'generation' | 'version' | 'history' | 'updatedAt' | 'owner' | 'slug'>>;
    note?: string;
}

export interface IDirectoryCreateRequest {
    path: string;
}

export interface ISkillsListQuery {
    path?: string;
    projectKey?: string;
    query?: string;
    mcp?: string;
    plugin?: string;
}

/** Элемент синхронизации: карточка скилла, прочитанная в проекте (через MCP). */
export interface ISkillsSyncItem {
    name: string;
    slug: string;
    body?: string;
    description?: string;
    mcp?: string[];
    plugins?: string[];
    dependencies?: IDependencyPin[];
    tags?: string[];
    specialization?: string;
    version?: number;
}

/** Запрос синхронизации скиллов проекта (ingest в каталог `project-<projectKey>`). */
export interface ISkillsSyncRequest {
    projectKey: string;
    skills: ISkillsSyncItem[];
}

/** Результат синхронизации скиллов. */
export interface ISkillsSyncResult extends ISkillAuditReceipt {
    projectKey: string;
    upserted: number;
    removed: number;
    total: number;
}
