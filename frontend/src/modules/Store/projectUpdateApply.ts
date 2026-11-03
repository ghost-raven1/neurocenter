import type { IStoreApp } from '../../features/Catalog/interfaces';
import type { IProjectAsset } from '../../core/api/interfaces';
import { currentInstallation, isPending, type IInstallationTarget } from '../../features/McpBridge/installationHelpers';
import type { IBridgeInstallation, IBridgeJob } from '../../features/McpBridge/api';

export interface IApplyUpdateTarget {
    head: IStoreApp;
    ref: IProjectAsset;
}
export interface IApplyUpdateOptions {
    applyEnabled: boolean;
    selected: boolean;
    canManage: boolean;
    targetProjectId?: string;
    catalogReady: boolean;
    common: readonly IStoreApp[];
    assets: readonly IProjectAsset[];
}

/**
 * Карточка предлагает «Применить обновление», когда общий каталог новее закрепления проекта
 * и точная новая редакция известна. pinError и неизвестные состояния остаются на прежних действиях.
 */
export function projectUpdateApplyTarget(app: IStoreApp, options: IApplyUpdateOptions): IApplyUpdateTarget | undefined {
    if (!options.applyEnabled || !options.selected || !options.canManage || !options.targetProjectId) return;
    if (!options.catalogReady || app.pinError) return;
    const head = options.common.find((item) => item.id === app.id && item.kind === app.kind);
    const ref = options.assets.find((item) => item.assetId === app.id && item.assetKind === app.kind);
    if (!head || !ref || !(head.version > app.version)) return;
    return { head, ref };
}

export interface IAutoInspectCandidate {
    job: IBridgeJob;
    row: IBridgeInstallation;
    target: IInstallationTarget;
}
export interface IAutoInspectOptions {
    projectId?: string;
    bindingId?: string | null;
    deviceReady: boolean;
    /** Идентификаторы установок, по которым сверка уже была поставлена в этой сессии. */
    already: ReadonlySet<string>;
}

/**
 * Успешная установка текущего проекта и папки даёт одну автоматическую сверку файлов:
 * задание установило именно актуальную редакцию, активная или более свежая сверка с тем же
 * манифестом уже есть либо отсутствует, и повтор в этой сессии ещё не отправлялся.
 */
export function autoInspectCandidates(
    jobs: readonly IBridgeJob[],
    installations: IBridgeInstallation[],
    options: IAutoInspectOptions,
): IAutoInspectCandidate[] {
    if (!options.deviceReady || !options.projectId) return [];
    const found: IAutoInspectCandidate[] = [];
    for (const job of jobs) {
        if (job.kind !== 'install' || job.state !== 'succeeded' || options.already.has(job.id)) continue;
        if (job.projectId !== options.projectId || (job.bindingId ?? null) !== options.bindingId) continue;
        if (!job.assetId || !job.assetKind) continue;
        const target: IInstallationTarget = {
            deviceId: job.deviceId,
            projectId: job.projectId,
            bindingId: options.bindingId ?? null,
            assetId: job.assetId,
            assetKind: job.assetKind,
        };
        const row = currentInstallation(installations, target);
        // Без активной привязки сверка невозможна: installationRequest бросит синхронно.
        if (!row || !row.bindingId) continue;
        // Сверка относится к актуальному состоянию: установка поставила именно текущую редакцию.
        if (job.version == null || Number(job.version) !== row.version) continue;
        const inspections = jobs.filter(
            (item) =>
                item.kind === 'inspect-installation' &&
                item.deviceId === job.deviceId &&
                item.projectId === job.projectId &&
                (item.bindingId ?? null) === (job.bindingId ?? null) &&
                item.assetId === job.assetId &&
                item.assetKind === job.assetKind,
        );
        if (inspections.some((item) => isPending(item))) continue;
        const done = inspections
            .filter((item) => !isPending(item))
            .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
        if (done && done.expectedManifest === row.manifest && done.createdAt >= job.createdAt) continue;
        found.push({ job, row, target });
    }
    return found;
}
