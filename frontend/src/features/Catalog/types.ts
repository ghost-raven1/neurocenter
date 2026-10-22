import type { IAiPlugin, ISkillFile } from '../../core/api/interfaces';

/** Разновидности «приложений» в магазине. */
export type TStoreKind = 'mcp' | 'plugin' | 'skill';

/** Полная закреплённая карточка общего или проектного каталога. */
export type TStoreDetail = { kind: 'skill'; skill: ISkillFile } | { kind: 'bundle'; plugin: IAiPlugin };

/**
 * Унифицированное «приложение» витрины (скилл/MCP/плагин в одном виде).
 */
export interface IStoreApp {
    /** Идентификатор: для скилла — path, для mcp/plugin — id каталога. */
    id: string;
    name: string;
    kind: TStoreKind;
    description: string;
    version: number;
    tags: string[];
    origin: string;
    /** Закреплённая ревизия поставки отличается от номера редакции карточки. */
    revision?: string|null;
    /** Путь скилла в каталоге (для резолва content). */
    path?: string;
    /** Техническое имя скилла; отображаемое название не определяет проектное назначение. */
    skillSlug?: string;
    /** Конфиг MCP (из каталога). */
    config?: Record<string, unknown>;
    /** Файлы плагина (из каталога) — для one-click установки дерева. */
    files?: { path: string; content?: string }[];
    /** Exact project snapshot не подменяется изменившимся head при открытии деталей. */
    projectCard?: TStoreDetail;
    projectManifest?: string;
    pinError?: string;
    /** Кол-во файлов (для бандлов). */
    filesCount?: number;
}

