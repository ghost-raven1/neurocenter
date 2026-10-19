import type { IBridgeDevice, IBridgeInstallation, IBridgeJob } from './api';
import type { IInstallPlan } from './installPlanTypes';
import { runtimeCodes, type ILocalChangePlan, type IRuntimeProbe } from './operationTypes';
import { isPending, removalSelection } from './installationHelpers';
import { matchingInspection } from './InstallationInspectionStatus';
import { localFeatureBlocker } from './readiness';
import { latestConfigurationStatus } from './mcpConfiguration';

export const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const sameInstallation = (job: IBridgeJob, row: IBridgeInstallation): boolean => job.deviceId === row.deviceId && job.projectId === row.projectId
    && job.bindingId === row.bindingId && job.assetId === row.assetId && job.assetKind === row.assetKind;
export function pendingLocalJob(jobs: IBridgeJob[], row: IBridgeInstallation, except?: string): IBridgeJob | undefined {
    return jobs.find(job => job.id !== except && isPending(job) && (sameInstallation(job, row)
        || job.deviceId === row.deviceId && (job.kind === 'choose-root' || job.projectId === row.projectId
            && (['prepare-bind-project','bind-project'].includes(job.kind) || job.kind === 'open-local-recovery-folder' && job.bindingId === row.bindingId))));
}
export function localActionBlocker(row: IBridgeInstallation, items: IBridgeInstallation[], device: IBridgeDevice | undefined, jobs: IBridgeJob[],
    ready: boolean, canManage: boolean, feature: 'local-change-plan-v1' | 'runtime-probe-v1' | 'local-recovery-v1', except?: string): string {
    if (!canManage) { return 'Действие требует роли разработчика в проекте.'; }
    if (!removalSelection(row, items, device)) { return 'Установка или папка изменилась. Закройте окно и выберите текущую запись.'; }
    if (!ready) { return 'Дождитесь актуальных данных подключения, установок и очереди.'; }
    const common = localFeatureBlocker(device, feature); if (common) { return common; }
    if (!device?.report.bindings?.some(binding => binding.projectId === row.projectId && binding.bindingId === row.bindingId && uuid(binding.instanceId))) {
        return 'Подтвердите экземпляр папки в мастере на странице «Проекты».';
    }
    if (pendingLocalJob(jobs, row, except)) { return 'Дождитесь завершения другого действия с этой установкой.'; }
    return '';
}
export const installedTuple = (row: IBridgeInstallation) => ({ deviceId: row.deviceId, projectId: row.projectId, assetId: row.assetId,
    assetKind: row.assetKind, expectedManifest: row.manifest, expectedBindingId: row.bindingId! });

/** Применение локального плана аннулирует прежнюю сверку и прежнюю диагностику запуска. */
export function latestInstallationReport(row: IBridgeInstallation, jobs: IBridgeJob[]): IBridgeInstallation {
    const probe = jobs.filter(job => job.kind === 'probe-runtime' && ['succeeded','failed'].includes(job.state) && sameInstallation(job,row))
        .sort((first,second) => Date.parse(second.startedAt || second.createdAt)-Date.parse(first.startedAt || first.createdAt)
            || (first.id===second.id?0:first.id<second.id?1:-1))[0];
    const observed = probe && matchingRuntime({...row,runtime:probe.result as unknown as IRuntimeProbe});
    const authoritativeAt = Date.parse(row.runtimeObservedAt || '') || 0;
    const probeAt = probe && (Date.parse(probe.startedAt || probe.createdAt) || 0);
    const newerProbe = !!probeAt && probeAt > authoritativeAt && (authoritativeAt > 0 || !row.runtime);
    const runtime = observed && newerProbe ? observed : row.runtime;
    const runtimeObservedAt = observed && newerProbe ? probe!.startedAt || probe!.createdAt : row.runtimeObservedAt;
    const invalidNewProbe = newerProbe && !observed && runtime;
    const changing = jobs.some(job => ['apply-local-change','apply-local-restore','apply-adopt-installation','install','uninstall'].includes(job.kind) && isPending(job) && sameInstallation(job,row));
    const changed = jobs.filter(job => ['apply-local-change','apply-local-restore','apply-adopt-installation'].includes(job.kind) && job.state === 'succeeded' && sameInstallation(job, row))
        .reduce((date, job) => Math.max(date, Date.parse(job.updatedAt) || 0), 0);
    const configuration = latestConfigurationStatus(row,jobs);
    const configurationChanged = !!row.configurationSchemaDigest && (!configuration?.ready
        || runtime?.configurationRevisions?.find(pin => pin.assetId === row.assetId && pin.manifest === row.manifest)?.revision !== configuration.revision);
    return { ...row, ...(row.inspection && (changing || changed > 0 && changed >= Date.parse(row.inspection.checkedAt)) ? { inspection: undefined } : {}),
        ...(row.configurationSchemaDigest ? {configuration} : {}),
        ...(runtimeObservedAt ? {runtimeObservedAt} : {}),
        ...(runtime ? {runtime:changing || invalidNewProbe || configurationChanged || changed > 0 && changed >= Date.parse(runtimeObservedAt || runtime.checkedAt) ? {...runtime,status:'stale'} : runtime} : {}) };
}
export function runtimeFileBlocker(row: IBridgeInstallation): string {
    const inspection = matchingInspection(row);
    return inspection?.state === 'checked' && inspection.status === 'synced' ? '' : 'Сначала проверьте файлы. Диагностика запуска доступна после полной сверки.';
}
export function matchingRuntime(row: IBridgeInstallation): IRuntimeProbe | undefined {
    const value = row.runtime;
    if (!value || value.schemaVersion !== 1 || !runtimeCodes.includes(value.code) || !['not_checked','passed','needs_configuration','failed','unsupported','stale','busy'].includes(value.status)
        || value.projectId !== row.projectId || value.bindingId !== row.bindingId || value.assetId !== row.assetId || value.assetKind !== row.assetKind
        || value.version !== row.version || value.manifest !== row.manifest || !sha(value.approvalManifest) || !Number.isFinite(Date.parse(value.checkedAt))
        || value.engineVersion !== '1.14.48' || !value.counts || Object.keys(value.counts).sort().join(',') !== 'files,mcp,packages,pluginsInitialized,prompts,resources,skills,tools'
        || Object.values(value.counts).some(count => !Number.isSafeInteger(count) || count < 0 || count > 20000)
        || value.counts.packages > 20 || value.counts.files > 200 || value.counts.skills + value.counts.mcp + value.counts.pluginsInitialized !== value.counts.packages
        || value.configurationRevisions !== undefined && (!Array.isArray(value.configurationRevisions) || value.configurationRevisions.length > 20
            || value.configurationRevisions.some(pin => !pin || Object.keys(pin).some(key => !['assetId','manifest','revision'].includes(key))
                || typeof pin.assetId !== 'string' || !pin.assetId || pin.assetId.length > 500 || /[\x00-\x1f]/.test(pin.assetId)
                || !sha(pin.manifest) || pin.revision !== null && !uuid(pin.revision))
            || new Set(value.configurationRevisions.map(pin => pin.assetId)).size !== value.configurationRevisions.length)
        || value.status === 'passed' && (value.code !== 'verified' || !sha(value.engineSha256))) { return undefined; }
    return value;
}
export function runtimeConsent(plan: IInstallPlan, row: IBridgeInstallation): string {
    if (plan.projectId !== row.projectId || plan.assetId !== row.assetId || plan.assetKind !== row.assetKind || plan.version !== row.version
        || plan.status !== 'approved' || !sha(plan.manifest)) { throw new Error('Для этой точной версии нужно действующее одобрение администратора проекта в каталоге.'); }
    if (plan.packages?.length ? !plan.packages.some(pkg => pkg.id === row.assetId && pkg.kind === row.assetKind && pkg.version === row.version && pkg.manifest === row.manifest)
        : plan.manifest !== row.manifest) { throw new Error('Одобрение относится к другому содержимому. Обновите установку и её план.'); }
    return plan.manifest;
}
/** Проверяет публичные метаданные до отображения; содержимое diff не приходит в браузер. */
export function matchingChangePlan(value: unknown, row: IBridgeInstallation, instanceId?: string): ILocalChangePlan | undefined {
    const plan = value as ILocalChangePlan | undefined;
    if (!plan || Object.keys(plan).some(key => !['schemaVersion','planId','revision','digest','projectId','bindingId','instanceId','assetId','assetKind','version','manifest','checkedAt','expiresAt','status','files','runtimeRepairRequired'].includes(key))
        || plan.runtimeRepairRequired !== undefined && plan.runtimeRepairRequired !== true
        || plan.schemaVersion !== 1 || plan.revision !== 1 || plan.status !== 'prepared' || !uuid(plan.planId) || !sha(plan.digest)
        || plan.projectId !== row.projectId || plan.bindingId !== row.bindingId || plan.instanceId !== instanceId || !uuid(plan.instanceId)
        || plan.assetId !== row.assetId || plan.assetKind !== row.assetKind || plan.version !== row.version || plan.manifest !== row.manifest
        || !Number.isFinite(Date.parse(plan.checkedAt)) || !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.parse(plan.checkedAt)
        || Date.parse(plan.expiresAt) - Date.parse(plan.checkedAt) > 15 * 60000 || !Array.isArray(plan.files) || plan.files.length > 512) { return undefined; }
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of plan.files) {
        if (!file || Object.keys(file).some(key => !['path','operation','beforeSha256','afterSha256','beforeBytes','afterBytes','binary'].includes(key))
            || typeof file.path !== 'string' || !file.path || file.path.length > 1024 || /[\\:\x00-\x1f]/.test(file.path)
            || file.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(file.path.toLowerCase().normalize('NFC'))
            || !['add','replace','remove'].includes(file.operation) || typeof file.binary !== 'boolean'
            || [file.beforeBytes,file.afterBytes].some(size => !Number.isSafeInteger(size) || size < 0 || size > 4 * 1048576)
            || file.beforeSha256 !== null && !sha(file.beforeSha256) || file.afterSha256 !== null && !sha(file.afterSha256)
            || file.operation === 'add' && (file.beforeSha256 !== null || file.beforeBytes !== 0 || file.afterSha256 === null)
            || file.operation === 'remove' && (file.afterSha256 !== null || file.afterBytes !== 0 || file.beforeSha256 === null)
            || file.operation === 'replace' && (file.beforeSha256 === null || file.afterSha256 === null)) { return undefined; }
        paths.add(file.path.toLowerCase().normalize('NFC'));
        bytes += file.beforeBytes + file.afterBytes;
    }
    return bytes <= 32 * 1048576 ? plan : undefined;
}
