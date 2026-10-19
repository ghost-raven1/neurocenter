import type { IBridgeDevice, IBridgeInstallation, IBridgeJob, IBridgeJobInput } from './api';

export interface IInstallationTarget {
    deviceId?: string;
    projectId?: string;
    assetId: string;
    assetKind: string;
    bindingId?: string | null;
}
const matches = (
    item: {
        deviceId: string;
        projectId: string | null;
        assetId?: string;
        assetKind?: string;
        bindingId?: string | null;
    },
    target: IInstallationTarget,
): boolean =>
    !!target.deviceId &&
    !!target.projectId &&
    item.deviceId === target.deviceId &&
    item.projectId === target.projectId &&
    item.assetId === target.assetId &&
    item.assetKind === target.assetKind &&
    (target.bindingId === undefined || (item.bindingId ?? null) === target.bindingId);

/** Удаление и установка учитываются вместе, а разные проекты и компьютеры не смешиваются. */
export function latestAssetJob(
    jobs: IBridgeJob[],
    target: IInstallationTarget,
): IBridgeJob | undefined {
    const matching = jobs.filter(job => ['install', 'uninstall'].includes(job.kind) && matches(job, target));
    return matching.find(isPending) || matching[0];
}
export function currentInstallation(
    items: IBridgeInstallation[],
    target: IInstallationTarget,
): IBridgeInstallation | undefined {
    return items.find((item) => !item.bindingChanged && !item.legacyBinding && item.isCurrentBinding !== false && matches(item, target));
}
export const isPending = (job: IBridgeJob | undefined): boolean =>
    !!job && ['queued', 'running', 'reconciling'].includes(job.state);

/** Ключ различает старую и текущую папки и не зависит от разделителей внутри ID. */
export const installationIdentity = (item: IInstallationTarget): string =>
    JSON.stringify([item.deviceId, item.projectId, item.bindingId ?? null, item.assetKind, item.assetId]);

export function latestInspectionJob(jobs: IBridgeJob[], target: IInstallationTarget): IBridgeJob | undefined {
    const matching = jobs.filter(job => job.kind === 'inspect-installation' && matches(job, target));
    return matching.find(isPending) || matching[0];
}

/** История неизвестной или прежней привязки остаётся видимой, но не разрешает действия. */
export function hasCurrentBinding(item: IBridgeInstallation, device: IBridgeDevice | undefined): boolean {
    if (!device || item.deviceId !== device.id || !item.bindingId || item.legacyBinding || item.bindingChanged || item.isCurrentBinding === false) { return false; }
    return Boolean(device.report.bindings?.some(binding => binding.projectId === item.projectId && binding.valid !== false && binding.bindingId === item.bindingId));
}

/** Подтверждение удаления повторно сверяет исходную версию и привязку с последними данными. */
export function removalSelection(selected: IBridgeInstallation | undefined, items: IBridgeInstallation[], device: IBridgeDevice | undefined): IBridgeInstallation | undefined {
    if (!selected || !hasCurrentBinding(selected, device)) { return undefined; }
    return items.find(item => installationIdentity(item) === installationIdentity(selected) && item.version === selected.version
        && item.manifest === selected.manifest && hasCurrentBinding(item, device));
}

export function installationRequest(kind: 'uninstall' | 'inspect-installation', item: IBridgeInstallation, requestKey: string): IBridgeJobInput {
    if (!item.bindingId || item.legacyBinding || item.bindingChanged || item.isCurrentBinding === false) { throw new Error('Установка относится к прежней или неизвестной папке. Обновите список установок.'); }
    return {kind, deviceId: item.deviceId, projectId: item.projectId, assetId: item.assetId, assetKind: item.assetKind,
        expectedManifest: item.manifest, expectedBindingId: item.bindingId, requestKey};
}
