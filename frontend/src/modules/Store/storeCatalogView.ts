import type { IProjectSummary } from '../../core/api/interfaces';
import { projectRoleLevel } from '../../features/UserBlock/roles';
import type { IStoreApp, TStoreKind } from '../../features/Catalog/types';

/** Выбранный проект и его права вычисляются вместе, чтобы имя не подменяло идентификатор. */
export function selectStoreTarget(projects: readonly IProjectSummary[], requested: string | null,
    user: Parameters<typeof projectRoleLevel>[0]) {
    const project = projects.find(item => item.id === requested) ?? projects.find(item => item.name === requested);
    return { project, level: projectRoleLevel(user, project?.id) };
}

/** API получает ID проекта; читаемое имя остаётся только в подписях интерфейса. */
export function storeProjectAssetRequest(project: Pick<IProjectSummary, 'id'>, app: Pick<IStoreApp, 'id' | 'kind'>,
    assetId = app.id): [string, { assetId: string; assetKind: TStoreKind }] {
    return [project.id, { assetId, assetKind: app.kind }];
}

/** Фильтры витрины не меняют доступность инструментов в исходном каталоге. */
export function visibleStoreApps(catalog: readonly IStoreApp[], options: {
    projectOnly: boolean;
    projectSelected: boolean;
    installedOnly: boolean;
    kind: 'all' | TStoreKind;
    query: string;
    inProject(app: IStoreApp): boolean;
}): IStoreApp[] {
    return catalog
        .filter(app => !options.projectOnly || options.inProject(app))
        .filter(app => options.kind === 'all' || app.kind === options.kind)
        .filter(app => !options.projectSelected || !options.installedOnly || options.inProject(app))
        .filter(app => !options.query || `${app.name} ${app.description}`.toLowerCase().includes(options.query.toLowerCase()));
}
