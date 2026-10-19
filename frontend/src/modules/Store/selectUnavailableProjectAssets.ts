import type { IProjectAsset } from '../../core/api/interfaces';
import type { IStoreApp } from './AppCard';
import { isToolInProject, skillProject } from './storeHelpers';

/** Ссылки без доступной карточки остаются видимыми и могут быть явно убраны из проекта. */
export function unavailableProjectAssets(assets: readonly IProjectAsset[], catalog: readonly IStoreApp[], projectId: string): IProjectAsset[] {
    const unique = new Map(assets.map(asset => [asset.assetKind + ':' + asset.assetId, asset]));
    return [...unique.values()].filter(asset => !catalog.some(app => app.kind === asset.assetKind
        && (skillProject(app) ? app.id === asset.assetId && skillProject(app) === projectId : isToolInProject(app, projectId, [asset]))));
}
