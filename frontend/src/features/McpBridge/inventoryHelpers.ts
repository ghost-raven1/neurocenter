import type { IBridgeDevice, IBridgeInstallation, IBridgeJob, IInstallPlan } from './api';
import { roleLevel } from '../UserBlock/roles';
import { isPending, removalSelection } from './installationHelpers';
import { matchingChangePlan, sha, uuid } from './operationHelpers';
import { inventoryReasons, localVariantReasons, type ILocalVariants, type IProjectInventory, type IProjectInventoryEntry, type TInventoryCapability } from './operationTypes';

const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const relative = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 1024
    && !/[\\:\x00-\x1f]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
export const projectBinding = (device: IBridgeDevice | undefined, projectId: string) => device?.report.bindings?.find(binding => binding.projectId === projectId);
export const inventoryScope = (device: IBridgeDevice | undefined, projectId: string): string => JSON.stringify([
    device?.id, device?.role, device?.requiresReconnect, device?.online, projectBinding(device,projectId),
]);

/** Наблюдатель сканирует только подтверждённый проект; запись требует отдельной capability и роли. */
export function projectInventoryBlocker(device: IBridgeDevice | undefined, projectId: string, jobs: IBridgeJob[], ready: boolean,
    permitted: boolean, capability: TInventoryCapability, except?: string, readOnly = capability === 'project-inventory-v1'): string {
    if (!permitted) { return readOnly ? 'Нет права чтения этого проекта.' : 'Действие требует роли разработчика в проекте.'; }
    if (!device) { return 'Выберите подключённый компьютер.'; }
    if (!ready) { return 'Дождитесь актуальных данных компьютера и очереди.'; }
    if (device.requiresReconnect) { return 'Подтвердите подключение компьютера заново.'; }
    if (!device.online) { return 'Включите компьютер и дождитесь подключения моста.'; }
    if (roleLevel(device.role) < (readOnly ? 1 : 2)) { return 'Роль подключения моста не разрешает это действие.'; }
    if (device.report.protocolVersion !== 2 || !['durable-completions','managed-installations','workspace-instance-v1',capability]
        .every(value => device.report.capabilities?.includes(value))) { return 'Обновите мост до версии 0.8 для поиска и принятия инструментов или восстановления локальных вариантов.'; }
    const binding = projectBinding(device,projectId);
    if (binding?.valid !== true || binding.identityStatus !== 'verified' || !sha(binding.bindingId) || !uuid(binding.instanceId)) {
        return 'Сначала подтвердите экземпляр папки проекта на странице «Проекты».';
    }
    if (jobs.some(job => job.id !== except && job.deviceId === device.id && isPending(job)
        && (job.kind === 'choose-root' || job.projectId === projectId))) { return 'Дождитесь завершения другого действия с проектом.'; }
    return '';
}
export function localVariantsBlocker(row: IBridgeInstallation, items: IBridgeInstallation[], device: IBridgeDevice | undefined,
    jobs: IBridgeJob[], ready: boolean, canView: boolean, except?: string): string {
    if (!removalSelection(row,items,device)) { return 'Установка или папка изменилась. Закройте окно и выберите текущую запись.'; }
    return projectInventoryBlocker(device,row.projectId,jobs,ready,canView,'local-recovery-v1',except,true);
}

/** Не принимает лишние поля с содержимым, абсолютные пути или ответы другого экземпляра. */
export function matchingInventory(value: unknown, projectId: string, device: IBridgeDevice | undefined): IProjectInventory | undefined {
    const result = value as IProjectInventory | undefined; const binding = projectBinding(device,projectId);
    if (!result || !exact(result,['schemaVersion','projectId','bindingId','instanceId','scanId','digest','checkedAt','expiresAt','complete','issues','entries'])
        || result.schemaVersion !== 1 || result.projectId !== projectId || result.bindingId !== binding?.bindingId || result.instanceId !== binding?.instanceId
        || !sha(result.bindingId) || !uuid(result.instanceId) || !uuid(result.scanId) || !sha(result.digest) || !date(result.checkedAt) || !date(result.expiresAt)
        || Date.parse(result.expiresAt)-Date.parse(result.checkedAt) !== 15*60000 || typeof result.complete !== 'boolean'
        || !Array.isArray(result.issues) || result.issues.length > 200 || result.issues.some(item => !inventoryReasons.includes(item))
        || !Array.isArray(result.entries) || result.entries.length > 200) { return undefined; }
    const ids = new Set<string>();
    for (const entry of result.entries) {
        if (!entry || !exact(entry,['candidateId','kind','path','state','reason']) || !uuid(entry.candidateId) || ids.has(entry.candidateId)
            || !['skill','mcp','plugin','unknown'].includes(entry.kind) || !relative(entry.path)
            || !['managed','unmanaged','damaged','unsafe','unreadable'].includes(entry.state) || !inventoryReasons.includes(entry.reason)) { return undefined; }
        ids.add(entry.candidateId);
    }
    return result;
}
export const inventoryExpired = (inventory: IProjectInventory, now = Date.now()) => Date.parse(inventory.expiresAt) <= now || Date.parse(inventory.checkedAt) > now+5000;
export function inventoryMutationBlocker(inventory:IProjectInventory,jobs:IBridgeJob[],deviceId:string|undefined):string {
    return jobs.some(job => job.deviceId === deviceId && job.projectId === inventory.projectId
        && ['install','uninstall','bind-project','apply-local-change','apply-adopt-installation','apply-local-restore'].includes(job.kind)
        && (isPending(job) || job.state === 'succeeded') && Date.parse(job.updatedAt) >= Date.parse(inventory.checkedAt))
        ? 'После поиска файлы или метаданные проекта изменились. Выполните поиск заново.' : '';
}
export function adoptionCandidateBlocker(inventory:IProjectInventory, entry:IProjectInventoryEntry, now=Date.now()):string {
    if (inventoryExpired(inventory,now)) { return 'Результат поиска устарел. Выполните поиск заново.'; }
    if (!inventory.complete) { return 'Для принятия требуется полный поиск без ошибок и пропущенных записей.'; }
    const observed=inventory.entries.find(value => value.candidateId === entry.candidateId);
    if (!observed || JSON.stringify(observed) !== JSON.stringify(entry) || entry.state !== 'unmanaged' || entry.kind === 'unknown') {
        return 'Эту запись нельзя безопасно принять под управление.';
    }
    return entry.reason === 'unknown-layout' ? 'Расположение не является каноническим. Принятие не переносит и не заменяет файлы.' : '';
}

/** Принимается только выбранный пользователем точный одобренный пакет, без совпадений по имени. */
export function approvedAdoptionTarget(plan: IInstallPlan, selected: {assetId:string;assetKind:string;version:number}) {
    if (plan.assetId !== selected.assetId || plan.assetKind !== selected.assetKind || plan.version !== selected.version
        || plan.status !== 'approved' || !sha(plan.manifest) || !Number.isSafeInteger(plan.revision) || plan.revision < 1) {
        throw new Error('Для выбранной точной версии требуется действующее одобрение администратора проекта.');
    }
    const root = plan.packages?.find(pkg => pkg.id === selected.assetId && pkg.kind === selected.assetKind && pkg.version === selected.version);
    const manifest = plan.packages?.length ? root?.manifest : plan.manifest;
    if (!sha(manifest)) { throw new Error('Одобрение не содержит выбранный пакет. Обновите каталог.'); }
    return {manifest,approvalManifest:plan.manifest};
}
export function matchingVariants(value: unknown, row: IBridgeInstallation, instanceId: string | undefined): ILocalVariants | undefined {
    const result = value as ILocalVariants | undefined;
    if (!result || !exact(result,['schemaVersion','projectId','bindingId','instanceId','assetId','assetKind','version','manifest','checkedAt','complete','entries'])
        || result.schemaVersion !== 1 || result.projectId !== row.projectId || result.bindingId !== row.bindingId || result.instanceId !== instanceId
        || !uuid(result.instanceId) || result.assetId !== row.assetId || result.assetKind !== row.assetKind || result.version !== row.version
        || result.manifest !== row.manifest || !date(result.checkedAt) || typeof result.complete !== 'boolean' || !Array.isArray(result.entries) || result.entries.length > 100) { return undefined; }
    const ids = new Set<string>();
    for (const entry of result.entries) {
        if (!entry || !exact(entry,['recoveryId','createdAt','files','eligible','reason']) || !uuid(entry.recoveryId) || ids.has(entry.recoveryId)
            || !date(entry.createdAt) || !Number.isSafeInteger(entry.files) || entry.files < 0 || entry.files > 512 || typeof entry.eligible !== 'boolean'
            || !localVariantReasons.includes(entry.reason) || entry.eligible && (entry.reason !== 'ready' || entry.files === 0)) { return undefined; }
        ids.add(entry.recoveryId);
    }
    return result;
}
/** Принятие разрешает только квитанции и реестр, а не скрытое изменение исполняемых файлов или конфигурации. */
export function matchingAdoptionPlan(value: unknown, row: IBridgeInstallation, instanceId: string) {
    const plan=matchingChangePlan(value,row,instanceId);
    return plan && plan.files.every(file => file.operation !== 'remove' && (file.path === '.opencode/neurocenter/installations.json'
        || /^\.opencode\/neurocenter\/receipts\/[a-f0-9]{24}\.json$/.test(file.path))) ? plan : undefined;
}
export const variantReasonLabels: Record<typeof localVariantReasons[number],string> = {
    ready:'Доступен просмотр восстановления', 'legacy-unverified':'Старая копия без подтверждённого происхождения',
    'different-installation':'Копия относится к другой установке', 'different-instance':'Копия относится к другому экземпляру папки',
    'shared-dependency':'Общая зависимость используется другими инструментами', 'no-restorable-files':'Нет подходящих файлов для восстановления',
    'invalid-backup':'Копия повреждена или недоступна', 'limit-exceeded':'Превышен допустимый объём проверки',
};
export const inventoryReasonLabels: Record<typeof inventoryReasons[number],string> = {
    'managed-receipt':'Квитанция и файлы подтверждены', 'managed-project-learning':'Сборщик опыта проекта', 'unmanaged-files':'Файлы пока не приняты под управление',
    'unmanaged-config':'Подключение пока не принято под управление', 'receipt-invalid':'Квитанция или реестр повреждены',
    'receipt-missing':'Не найдена подтверждённая квитанция', 'file-mismatch':'Файлы отличаются от сохранённого пакета',
    'config-mismatch':'Подключение отличается от сохранённого', 'config-invalid':'Не удалось однозначно прочитать конфигурацию',
    'unsafe-path':'Ссылка или неподдерживаемый путь', 'read-failed':'Не удалось прочитать запись', 'read-limit':'Превышен лимит чтения',
    'snapshot-changed':'Файлы изменились во время проверки', 'entry-limit':'Достигнут лимит 200 записей',
    'project-busy':'Папка занята другой операцией', 'binding-changed':'Привязка папки изменилась', 'unknown-layout':'Расположение не является каноническим для управляемой установки',
};
