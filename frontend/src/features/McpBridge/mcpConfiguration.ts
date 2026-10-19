import type { IBridgeDevice, IBridgeInstallation, IBridgeJob } from './api';
import type { IMcpConfigurationOpened, IMcpConfigurationPreparation, IMcpConfigurationStatus } from './mcpConfigurationTypes';
import { roleLevel } from '../UserBlock/roles';
import { hasCurrentBinding, removalSelection } from './installationHelpers';
import { pendingLocalJob, sameInstallation, sha, uuid } from './operationHelpers';
import { inspectionBlocker } from './readiness';

const tupleKeys = ['schemaVersion','projectId','bindingId','instanceId','assetId','assetKind','version','manifest','schemaDigest'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function matches(value: unknown, item: IBridgeInstallation, instanceId?: string): value is Record<string, unknown> {
    return record(value) && value.schemaVersion === 1 && item.assetKind === 'mcp' && value.assetKind === 'mcp'
        && value.projectId === item.projectId && value.bindingId === item.bindingId && uuid(value.instanceId)
        && (!instanceId || value.instanceId === instanceId) && value.assetId === item.assetId && value.version === item.version
        && value.manifest === item.manifest && sha(value.schemaDigest) && value.schemaDigest === item.configurationSchemaDigest;
}

/** Ответ с лишними полями не попадает в интерфейс: сервер не передаёт конфигурацию или её значения. */
export function matchingConfigurationStatus(value: unknown, item: IBridgeInstallation, instanceId?: string): IMcpConfigurationStatus | undefined {
    if (!matches(value,item,instanceId) || Object.keys(value).some(key => ![...tupleKeys,'ready','missingFieldIds','revision','checkedAt'].includes(key))
        || typeof value.ready !== 'boolean' || !Array.isArray(value.missingFieldIds) || value.missingFieldIds.length > 32
        || value.missingFieldIds.some(id => typeof id !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(id))
        || new Set(value.missingFieldIds).size !== value.missingFieldIds.length || value.ready !== (value.missingFieldIds.length === 0)
        || value.revision !== null && !uuid(value.revision) || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) { return undefined; }
    return value as unknown as IMcpConfigurationStatus;
}
export function matchingConfigurationPreparation(value: unknown, item: IBridgeInstallation, instanceId?: string, now = Date.now()): IMcpConfigurationPreparation | undefined {
    if (!matches(value,item,instanceId) || Object.keys(value).some(key => ![...tupleKeys,'preparationId','expiresAt'].includes(key))
        || !uuid(value.preparationId) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + 16 * 60000) { return undefined; }
    return value as unknown as IMcpConfigurationPreparation;
}
export function matchingConfigurationOpened(value: unknown, item: IBridgeInstallation, preparationId?: string, instanceId?: string): IMcpConfigurationOpened | undefined {
    if (!record(value) || value.opened !== true || value.preparationId !== preparationId
        || Object.keys(value).some(key => ![...tupleKeys,'preparationId','expiresAt','opened'].includes(key))) { return undefined; }
    const { opened: _opened, ...preparation } = value;
    return matchingConfigurationPreparation(preparation,item,instanceId) ? value as unknown as IMcpConfigurationOpened : undefined;
}

/** Статус переживает перезагрузку страницы, но не переносится между версиями и экземплярами папки. */
export function latestConfigurationStatus(item: IBridgeInstallation, jobs: IBridgeJob[], instanceId?: string): IMcpConfigurationStatus | undefined {
    const fromRow = matchingConfigurationStatus(item.configuration,item,instanceId);
    const invalidatedAt = Date.parse(item.configurationInvalidatedAt || '') || 0;
    const observedAt = Date.parse(item.configurationObservedAt || '') || 0;
    const latest = jobs.filter(job => job.kind === 'get-mcp-configuration-status' && ['succeeded','failed'].includes(job.state) && sameInstallation(job,item)
        && (Date.parse(job.startedAt || job.createdAt) || 0) >= invalidatedAt
        && (Date.parse(job.startedAt || job.createdAt) || 0) > observedAt
        && (matchingConfigurationStatus(job.result,item,instanceId) || job.state === 'failed' && Number(job.version) === item.version))
        .sort((a,b) => Date.parse(b.startedAt || b.createdAt)-Date.parse(a.startedAt || a.createdAt) || (a.id===b.id?0:a.id<b.id?1:-1))[0];
    // Одинаковый server startedAt оставляет authoritative installation, даже если ACK job пришёл позже.
    return latest ? matchingConfigurationStatus(latest.result,item,instanceId) : fromRow;
}

/** Чтение готовности доступно наблюдателю; открыть мастер может разработчик своего проекта. */
export function configurationBlocker(item: IBridgeInstallation, items: IBridgeInstallation[], device: IBridgeDevice | undefined,
    jobs: IBridgeJob[], ready: boolean, permitted: boolean, mutate: boolean, except?: string): string {
    if (!permitted) { return mutate ? 'Настройка требует роли разработчика в проекте.' : 'Для просмотра настройки нужен доступ к проекту.'; }
    if (item.assetKind !== 'mcp' || !sha(item.configurationSchemaDigest)) { return 'Для этой версии не предусмотрен локальный мастер настройки MCP.'; }
    if (!removalSelection(item,items,device) || !hasCurrentBinding(item,device)) { return 'Установка или папка изменилась. Выберите текущую запись.'; }
    if (!ready) { return 'Дождитесь актуальных данных подключения, установок и очереди.'; }
    const common = inspectionBlocker(device); if (common) { return common; }
    if (mutate && roleLevel(device?.role) < 2) { return 'Роль подключения моста не разрешает настройку. Переподключите компьютер с ролью разработчика.'; }
    if (!device?.report.capabilities?.includes('local-mcp-config-v1')) { return 'Обновите мост до версии 0.9 на странице «Начало работы» для локальной настройки.'; }
    if (!device.report.bindings?.some(binding => binding.projectId === item.projectId && binding.bindingId === item.bindingId && uuid(binding.instanceId))) {
        return 'Подтвердите экземпляр папки на странице «Проекты».';
    }
    return pendingLocalJob(jobs,item,except) ? 'Дождитесь завершения другого действия с этой установкой.' : '';
}

export function configurationRuntimeBlocker(item: IBridgeInstallation): string {
    if (!item.configurationSchemaDigest) { return ''; }
    return matchingConfigurationStatus(item.configuration,item)?.ready ? '' : 'Откройте локальную настройку MCP, заполните параметры и проверьте её готовность.';
}
