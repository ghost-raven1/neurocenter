import {
    IPage,
    ISkill,
    ISkillCollection,
    ISkillDetail,
    IPackage,
    IPackageDetail,
} from './dto';

/**
 * In-memory mock-каталог (dev). При подключении реального лancedb-storage —
 * заменить на запросы к хранилищу (каталог проектов/версий/скиллов/пакетов).
 */

export const SKILL_COLLECTIONS: ISkillCollection[] = [
    { collectionId: 'col-common', scope: 'COMMON', projectId: null, title: 'Встроенные скиллы' },
    { collectionId: 'col-core', scope: 'PROJECT', projectId: 'prj-lancedb-core', title: 'Скиллы проекта Core' },
];

export const SKILLS: ISkill[] = [
    { id: 'sk-1', collectionId: 'col-common', slug: 'vector-search', owner: 'platform', state: 'PUBLISHED', currentVersionId: 'skv-2', versionsCount: 2, bytes: 204800, pinnedInCount: 1, nameConflict: false },
    { id: 'sk-2', collectionId: 'col-core', slug: 'compaction', owner: 'dev@localhost', state: 'PUBLISHED', currentVersionId: 'skv-5', versionsCount: 3, bytes: 512000, pinnedInCount: 0, nameConflict: true },
];

export const SKILL_DETAILS: Record<string, ISkillDetail> = {
    'sk-1': {
        skill: SKILLS[0],
        versions: [
            { versionId: 'skv-2', skillId: 'sk-1', parentId: 'skv-1', author: 'platform', createdAt: '2026-10-05T10:00:00Z', contentHash: 'h2' },
            { versionId: 'skv-1', skillId: 'sk-1', parentId: null, author: 'platform', createdAt: '2026-09-01T10:00:00Z', contentHash: 'h1' },
        ],
    },
    'sk-2': {
        skill: SKILLS[1],
        versions: [
            { versionId: 'skv-5', skillId: 'sk-2', parentId: 'skv-4', author: 'dev@localhost', createdAt: '2026-10-08T10:00:00Z', contentHash: 'h5' },
            { versionId: 'skv-4', skillId: 'sk-2', parentId: null, author: 'dev@localhost', createdAt: '2026-10-02T10:00:00Z', contentHash: 'h4' },
        ],
    },
};

export const PACKAGE_COLLECTIONS: { id: string; title: string }[] = [
    { id: 'pkcol-1', title: 'MCP-агенты' },
    { id: 'pkcol-2', title: 'Плагины' },
];

export const PACKAGES: IPackage[] = [
    { id: 'pk-1', collectionId: 'pkcol-1', name: 'lancedb-mcp-agent', kind: 'LOCAL_MCP', currentVersionId: 'pkv-3', compatibility: 'node>=18', variantsCount: 2, origin: 'git:internal', pinnedInCount: 1 },
    { id: 'pk-2', collectionId: 'pkcol-2', name: 'query-export-plugin', kind: 'PLUGIN', currentVersionId: 'pkv-1', compatibility: 'web', variantsCount: 1, origin: 'git:internal', pinnedInCount: 0 },
];

export const PACKAGE_DETAILS: Record<string, IPackageDetail> = {
    'pk-1': {
        package: PACKAGES[0],
        manifestHash: 'mh-1',
        variants: [
            { variantId: 'pkv-3-linux', os: 'linux', architecture: 'x64', runtime: 'node18', bytes: 15728640, entrypoint: 'dist/index.js' },
            { variantId: 'pkv-3-win', os: 'windows', architecture: 'x64', runtime: 'node18', bytes: 16777216, entrypoint: 'dist/index.js' },
        ],
    },
    'pk-2': {
        package: PACKAGES[1],
        manifestHash: 'mh-2',
        variants: [{ variantId: 'pkv-1-web', os: 'web', architecture: 'wasm', runtime: 'browser', bytes: 4194304, entrypoint: 'plugin.js' }],
    },
};

/**
 * Отсечёт страницу списка (page-size).
 *
 * @template {unknown} T
 * @param {T[]} all - весь набор
 * @param {number} page - 1-based
 * @param {number} size - размер страницы
 * @returns {IPage<T>}
 */
export function toPage<T>(all: T[], page: number, size: number): IPage<T> {
    const start = (page - 1) * size;

    return { items: all.slice(start, start + size), page, size, total: all.length };
}

/** Допустимые роли сотрудника в проекте. */
export const MEMBER_ROLE_OPTIONS: string[] = ['Админ проекта', 'Разработчик', 'Наблюдатель'];
