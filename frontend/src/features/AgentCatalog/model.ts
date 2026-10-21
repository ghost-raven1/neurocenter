import { bridgeOperationBlocker } from '../McpBridge/readiness';
import { roleLevel } from '../UserBlock/roles';
import type { IAgentCatalog, IAgentCatalogProps, IAgentConnectTarget, IAgentDefinition, IAgentOverrides, ICatalogAgent, IProjectAgent } from './types';

export const AGENT_PROMPT_MAX_BYTES = 64 * 1024;
export const AGENT_DESCRIPTION_MAX_BYTES = 1024;
export const agentModeLabels = { primary: 'Основной агент', subagent: 'Подагент', all: 'Основной и подагент' };
export const agentPermissionLabels: Record<string, string> = {
    read: 'Чтение файлов', edit: 'Изменение файлов', bash: 'Команды терминала', glob: 'Поиск файлов', grep: 'Поиск по содержимому',
    list: 'Просмотр папок', task: 'Вызов других агентов', external_directory: 'Файлы вне проекта', todowrite: 'Список задач',
    question: 'Вопросы пользователю', webfetch: 'Загрузка веб-страниц', websearch: 'Поиск в интернете', lsp: 'Анализ кода', doom_loop: 'Повторяющиеся действия', skill: 'Скиллы',
};
export const defaultAgentPermission = { read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'ask', bash: 'ask', task: 'ask', external_directory: 'ask' } as const;
export const agentSlugPattern = /^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const agentModelPattern = /^(?!.*:\/\/)[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const promptBytes = (value: string): number => new TextEncoder().encode(value).byteLength;
export const validAgentText = (value: string, multiline = false): boolean => !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)
    && new TextDecoder().decode(new TextEncoder().encode(value)) === value;

function definition(value: unknown): value is IAgentDefinition {
    if (!record(value) || typeof value.prompt !== 'string' || !value.prompt.trim() || !validAgentText(value.prompt, true) || promptBytes(value.prompt) > AGENT_PROMPT_MAX_BYTES
        || typeof value.description !== 'string' || !value.description.trim() || !validAgentText(value.description) || promptBytes(value.description) > AGENT_DESCRIPTION_MAX_BYTES
        || typeof value.mode !== 'string' || !own(agentModeLabels, value.mode) || !record(value.permission)) return false;
    return Object.entries(value.permission).every(([key, action]) => own(agentPermissionLabels, key) && ['allow', 'ask', 'deny'].includes(String(action)))
        && (value.model === undefined || typeof value.model === 'string' && value.model.length <= 200 && agentModelPattern.test(value.model))
        && (value.temperature === undefined || typeof value.temperature === 'number' && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2)
        && (value.topP === undefined || typeof value.topP === 'number' && Number.isFinite(value.topP) && value.topP >= 0 && value.topP <= 1)
        && (value.steps === undefined || Number.isSafeInteger(value.steps) && Number(value.steps) > 0 && Number(value.steps) <= 1000);
}
function card(value: unknown): value is ICatalogAgent {
    return record(value) && typeof value.id === 'string' && !!value.id && typeof value.name === 'string' && !!value.name.trim()
        && value.name.length <= 128 && validAgentText(value.name) && typeof value.slug === 'string' && value.slug.length <= 64 && agentSlugPattern.test(value.slug) && typeof value.description === 'string'
        && revision(value.version) && value.version > 0 && digest(value.manifest) && definition(value.definition)
        && value.description === value.definition.description && (value.archivedAt === null || typeof value.archivedAt === 'string');
}

/** Reject incomplete responses rather than turn unverified project assignments into an empty list. */
export function requireAgentCatalog(value: unknown): IAgentCatalog {
    const invalid = (): never => { throw new Error('Сервер вернул неполный каталог агентов. Повторите загрузку.'); };
    if (!record(value) || !Array.isArray(value.items) || !Array.isArray(value.assignments) || !Array.isArray(value.deliveries)
        || value.revision !== null && !revision(value.revision) || !value.items.every(card)
        || new Set(value.items.map(item => item.id)).size !== value.items.length) return invalid();
    if (!value.assignments.every(item => record(item) && card(item.card) && item.agentId === item.card.id && item.version === item.card.version
        && item.manifest === item.card.manifest && typeof item.enabled === 'boolean' && typeof item.removed === 'boolean'
        && !(item.removed && item.enabled) && record(item.overrides) && definition(item.effective))
        || new Set(value.assignments.map(item => item.agentId)).size !== value.assignments.length) return invalid();
    if (!value.deliveries.every(item => record(item) && typeof item.deviceId === 'string' && typeof item.bindingId === 'string'
        && typeof item.instanceId === 'string' && typeof item.jobId === 'string' && typeof item.state === 'string' && typeof item.message === 'string'
        && revision(item.revision) && digest(item.manifestSha256))) return invalid();
    return value as unknown as IAgentCatalog;
}

/** Archived templates stay available through active project pins or the administrator's archive filter. */
export function visibleAgents(catalog: IAgentCatalog, query: string, projectOnly: boolean, showArchive = false): ICatalogAgent[] {
    const assigned = new Map(catalog.assignments.map(item => [item.agentId, item]));
    const cards = new Map(catalog.items.map(item => [item.id, item]));
    for (const item of catalog.assignments) if (!cards.has(item.agentId)) cards.set(item.agentId, item.card);
    const needle = query.trim().toLocaleLowerCase('ru');
    return [...cards.values()].filter(item => {
        const pinned = assigned.get(item.id), active = !!pinned && !pinned.removed;
        return (showArchive || !item.archivedAt || active) && (!projectOnly || active)
            && (!needle || `${item.name} ${item.slug} ${item.description} ${active ? `${pinned.card.name} ${pinned.card.slug} ${pinned.effective.description}` : ''}`.toLocaleLowerCase('ru').includes(needle));
    });
}

const same = (left: unknown, right: unknown): boolean => {
    const normalize = (value: unknown): unknown => record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};
/** Optional null clears a pinned model/parameter; an absent key inherits the exact pinned template. */
export function agentOverrides(base: IAgentDefinition, effective: IAgentDefinition): IAgentOverrides {
    const result: IAgentOverrides = {};
    for (const key of ['description', 'prompt', 'mode', 'permission'] as const) if (!same(base[key], effective[key])) Object.assign(result, { [key]: effective[key] });
    for (const key of ['model', 'temperature', 'topP', 'steps'] as const) if (!same(base[key], effective[key])) Object.assign(result, { [key]: effective[key] ?? null });
    return result;
}

/** Read-only users may inspect a confirmed configuration even when their bridge cannot mutate it. */
export function selectedAgentTarget({bridge, projectId}: Pick<IAgentCatalogProps, 'bridge' | 'projectId'>): IAgentConnectTarget | undefined {
    if (!projectId || !bridge.devicesReady || !bridge.device || bridge.device.requiresReconnect) return;
    const binding = bridge.device.report.bindings?.find(item => item.projectId === projectId && item.valid !== false);
    if (binding?.bindingId && binding.instanceId) return { deviceId: bridge.device.id, expectedBindingId: binding.bindingId, expectedInstanceId: binding.instanceId };
}

export function agentConnection(props: Pick<IAgentCatalogProps, 'bridge' | 'projectId'>): { target?: IAgentConnectTarget; reason: string } {
    if (!props.projectId) return { reason: 'Выберите проект для подключения агента.' };
    const { bridge } = props;
    if (!bridge.devicesReady) return { reason: bridge.errors.devices || 'Дождитесь проверки компьютера.' };
    const common = bridgeOperationBlocker(bridge.device);
    if (common) return { reason: common };
    if (roleLevel(bridge.device!.role) < 3) return { reason: 'Подключите мост с ролью администратора для настройки агентов.' };
    if (!bridge.device!.report.capabilities?.includes('project-agents-v2')) return { reason: 'Обновите мост для подключения агентов OpenCode.' };
    const target = selectedAgentTarget(props);
    if (!target) return { reason: 'Свяжите папку проекта с OpenCode на выбранном компьютере.' };
    if (!bridge.jobsReady) return { reason: bridge.errors.jobs || 'Дождитесь загрузки заданий компьютера.' };
    return { target, reason: '' };
}

export interface IAgentStatus { key: 'pending' | 'error' | 'enabled' | 'disabled' | 'removed' | 'unapplied'; label: string; detail: string; busy: boolean }
function receiptMatches(catalog: IAgentCatalog, result: Record<string, unknown>): boolean {
    if (result.schemaVersion!==2||!digest(result.compiledManifestSha256)||!Array.isArray(result.agents)) return false;
    const agents = result.agents;
    const expected = catalog.assignments.filter(item => !item.removed);
    return agents.length === expected.length && expected.every(item => agents.some(value => record(value)
        && value.id === item.agentId && value.slug === item.card.slug && value.version === item.version && value.enabled === item.enabled && digest(value.sha256)));
}
/** A server checkbox is desired state. Only an exact current-folder receipt confirms OpenCode configuration. */
export function projectAgentStatus(catalog: IAgentCatalog, assignment: IProjectAgent, target?: IAgentConnectTarget): IAgentStatus {
    const matches = catalog.deliveries.filter(item => target && item.deviceId === target.deviceId && item.bindingId === target.expectedBindingId && item.instanceId === target.expectedInstanceId && item.revision === catalog.revision);
    const pending = matches.find(item => ['queued', 'running', 'reconciling'].includes(item.state));
    if (pending) return { key: 'pending', label: 'Применяем настройки', detail: pending.message, busy: true };
    const delivery = matches[0];
    if (delivery?.state === 'succeeded' && delivery.result?.readiness === 'configured' && delivery.result.revision === catalog.revision
        && delivery.result.bindingId === target?.expectedBindingId && delivery.result.instanceId === target?.expectedInstanceId
        && delivery.result.manifestSha256 === delivery.manifestSha256 && receiptMatches(catalog, delivery.result)) return assignment.removed
        ? { key: 'removed', label: 'Удалён из OpenCode', detail: 'Управляемый файл удалён на выбранном компьютере.', busy: false }
        : { key: assignment.enabled ? 'enabled' : 'disabled', label: assignment.enabled ? 'Настроен в OpenCode' : 'Отключён в настройках', detail: 'Настройки подтверждены мостом. OpenCode прочитает их при следующем запуске.', busy: false };
    if (delivery && ['failed', 'cancelled', 'conflict'].includes(delivery.state)) return { key: 'error', label: 'Настройки не применены', detail: delivery.message || 'Проверьте компьютер и повторите применение.', busy: false };
    return { key: 'unapplied', label: assignment.removed ? 'Ожидает удаления из OpenCode' : 'Нужно применить в OpenCode', detail: assignment.removed ? 'Удаление сохранено в проекте; управляемый файл пока не подтверждён как удалённый.' : `В проекте сохранено: ${assignment.enabled ? 'включён' : 'отключён'}. Подтверждения компьютера ещё нет.`, busy: false };
}
