import type { IAiPlugin, IProjectAsset, ISkillListSummary } from '../../core/api/interfaces';
import type { IStoreApp, TStoreKind } from './AppCard';
import {projectRoleLevel} from '../../features/UserBlock/roles';

/** Извлекает серверный проект только из корректного пути проектного скилла. */
export function skillProject(app: Pick<IStoreApp, 'kind' | 'id'>): string | null {
    const [scope, ...parts] = app.id.split('/');
    return app.kind === 'skill' && scope.startsWith('project-') && scope.length > 8 && parts.length > 0 && parts.every(part => /^[a-z0-9][a-z0-9_-]*$/.test(part)) ? scope.slice(8) : null;
}

/** Проектный скилл уже принадлежит своему каталогу и не подключается ссылкой к другим проектам. */
export function projectSkillReferenceBlocker(app: Pick<IStoreApp, 'kind' | 'id'>, projectId?: string): string | null {
    const owner = skillProject(app);
    if (!owner) { return null; }
    if (owner === projectId) { return 'Этот скилл уже доступен в каталоге своего проекта.'; }
    return 'Проектный скилл нельзя подключить ссылкой к другому проекту. Используйте общий каталог или создайте отдельную копию в нужном проекте.';
}

/** Разработчик редактирует инструкции своего проекта; общий каталог меняет главный админ. */
export function canEditTool(user: Parameters<typeof projectRoleLevel>[0], app: Pick<IStoreApp, 'kind' | 'id'>): boolean {
    return projectRoleLevel(user, skillProject(app)) >= 2 && (user?.activeRole === 'Главный админ' || skillProject(app) !== null);
}

/** Транслит/ascii-слог имени (совпадает c backend slugify). */
export const slug = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type StoreTool = Pick<IStoreApp, 'kind' | 'id' | 'name' | 'path' | 'skillSlug'>;
type ProjectAssetReference = Pick<IProjectAsset, 'assetKind' | 'assetId'>;
const validSkillPath = (value: string): boolean => value.length > 0 && value.length <= 240
    && value.split('/').every(part => /^[a-z0-9][a-z0-9_-]*$/.test(part));

/** Как и на сервере: точный путь важнее старого slug, неоднозначное короткое имя не разрешается. */
export function resolveStoreSkillReference(reference: string, catalog: readonly StoreTool[]): string | undefined {
    if (!validSkillPath(reference)) { return undefined; }
    const skills = catalog.filter(app => app.kind === 'skill');
    return skills.some(app=>(app.path??app.id)===reference)?reference:undefined;
}

/** Возвращает исходную ссылку, чтобы снятие старого назначения удаляло именно его ID. */
export function projectAssetForTool(
    app: StoreTool,
    projectId: string | undefined,
    assets: readonly ProjectAssetReference[],
    catalog: readonly StoreTool[] = [app],
): ProjectAssetReference | undefined {
    if (!projectId || (skillProject(app) && skillProject(app) !== projectId)) { return undefined; }
    return assets.find(asset => asset.assetKind === app.kind && (app.kind === 'skill'
        ? resolveStoreSkillReference(asset.assetId, catalog) === (app.path ?? app.id)
        : asset.assetId === app.id));
}

/** Собственные проектные скиллы доступны по роли; общие требуют однозначного назначения. */
export function isToolInProject(
    app: StoreTool,
    projectId: string | undefined,
    assets: readonly ProjectAssetReference[],
    catalog: readonly StoreTool[] = [app],
): boolean {
    if (!projectId) { return false; }
    const owner = skillProject(app);
    if (owner) { return owner === projectId; }
    return projectAssetForTool(app, projectId, assets, catalog) !== undefined;
}

/** Маппинг MCP/плагина каталога в карточку витрины. */
export const fromPlugin = (p: IAiPlugin): IStoreApp => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    description: p.description,
    version: p.version,
    tags: p.tags,
    origin: p.origin,
    config: (p.config ?? undefined) as Record<string, unknown> | undefined,
    files: (p.files ?? []).map(f => ({ path: f.path, content: f.content })),
});

/** Маппинг скилла каталога в карточку витрины. */
export const fromSkill = (s: ISkillListSummary): IStoreApp => ({
    id: s.path,
    name: s.meta.name || s.path.split('/').pop() || s.path,
    kind: 'skill',
    description: s.meta.description ?? '',
    version: s.meta.version ?? 1,
    tags: s.meta.tags ?? [],
    origin: s.meta.slug ?? s.path,
    path: s.path,
    skillSlug: s.meta.slug,
});

/** Подпись типа приложения. */
export const kindLabel = (k: TStoreKind): string => (k === 'mcp' ? 'MCP' : k === 'plugin' ? 'Плагин' : 'Скилл');

/** Русские формы слова «проект/проекта/проектов». */
export const pluralProjects = (n: number): string => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) {
        return 'проект';
    }
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) {
        return 'проекта';
    }
    return 'проектов';
};

/** Время «ЧЧ:ММ» для комментов. */
export const fmtTime = (ts: number): string => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

