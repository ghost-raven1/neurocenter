import type { IProjectAsset } from '../../core/api/interfaces';
import type { IStoreApp } from '../../features/Catalog/types';
import type { IBridgeInstallation, IBridgeJob } from '../../features/McpBridge/api';
import { currentInstallation, isPending, latestAssetJob, type IInstallationTarget } from '../../features/McpBridge/installationHelpers';
import { pendingLocalJob } from '../../features/McpBridge/operationHelpers';

export interface IProjectCatalogUpdate {
    head?: IStoreApp;
    project: IProjectAsset;
    computer?: IBridgeInstallation;
    receiptsReady: boolean;
    catalogNewer: boolean;
    computerDiffers: boolean;
    attention: boolean;
}
interface IOptions {
    common: readonly IStoreApp[];
    assets: readonly IProjectAsset[];
    installations: IBridgeInstallation[];
    jobs: IBridgeJob[];
    target: IInstallationTarget;
    sourceReady: boolean;
    projectReady: boolean;
    receiptsReady: boolean;
}

/** Сравнение относится к точному назначению и квитанции выбранной папки; head не заменяет pin. */
export function projectCatalogUpdate(app: IStoreApp, options: IOptions): IProjectCatalogUpdate | undefined {
    const project = options.assets.find(item => item.assetId === app.id && item.assetKind === app.kind);
    if (!project || !options.target.projectId) return;
    const head = options.sourceReady ? options.common.find(item => item.id === app.id && item.kind === app.kind) : undefined;
    const pinned = options.projectReady && !app.pinError && !project.pinError && !!project.card
        && Number.isSafeInteger(project.version) && Number(project.version) > 0 && !!project.manifest;
    const receiptsReady = options.receiptsReady && !!options.target.bindingId;
    const computer = receiptsReady ? currentInstallation(options.installations, options.target) : undefined;
    const job = latestAssetJob(options.jobs, options.target);
    return {
        head, project, computer, receiptsReady,
        catalogNewer: !!pinned && !!head && head.version > project.version!,
        computerDiffers: !!pinned && !!computer && (computer.version !== project.version || computer.manifest !== project.manifest),
        attention: !!app.pinError || !!project.pinError || isPending(job) || !!computer && !!pendingLocalJob(options.jobs, computer)
            || !!job && ['failed', 'cancelled', 'conflict'].includes(job.state),
    };
}

/** Фильтр предложений сохраняет незавершённые действия и путь восстановления. */
export const showProjectCatalogUpdate = (update: IProjectCatalogUpdate | undefined): boolean =>
    !!update && (update.catalogNewer || update.computerDiffers || update.attention);
