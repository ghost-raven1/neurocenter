import type { IAuditEvent } from '../../core/api/interfaces';
import { auditResourceLabel } from './auditHelpers';
import { agentAuditSummary, agentAuditTitle, isAgentAudit } from './agentAudit';

interface IPublicationSnapshot {
    name?: string;
    kind?: string;
    origin?: string;
    revision?: string;
    contentHash?: string;
    version?: number;
    filesCount?: number;
}
export interface IAuditChange { label: string; before: string; after: string; }

const publicationActions = new Set(['plugin.create', 'plugin.update', 'plugin.activate', 'plugin.delete']);
const origins: Record<string, string> = { npm: 'npm', upload: 'Файлы', git: 'Git', github: 'GitHub', builtin: 'Встроенный каталог' };

/** Для старых событий без снимка сохраняем честный ID вместо выдуманного названия. */
function snapshot(value: unknown): IPublicationSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
    const input = value as Record<string, unknown>;
    const result: IPublicationSnapshot = {};
    for (const key of ['name', 'kind', 'origin', 'revision', 'contentHash'] as const) {
        if (typeof input[key] === 'string' && input[key]) { result[key] = input[key]; }
    }
    for (const key of ['version', 'filesCount'] as const) {
        if (Number.isSafeInteger(input[key]) && Number(input[key]) >= 0) { result[key] = Number(input[key]); }
    }
    return result;
}

/** Использует название из события, в том числе после удаления карточки. */
export function auditResourceTitle(event: IAuditEvent): string {
    const agent = agentAuditTitle(event); if (agent) return agent;
    if (publicationActions.has(event.action)) {
        return snapshot(event.details?.after).name || snapshot(event.details?.before).name || event.resourceId || 'Название не сохранено';
    }
    return event.resourceId || 'Ресурс не указан';
}

/** Различает MCP и плагин по сохранённому типу публикации. */
export function auditResourceKind(event: IAuditEvent): string {
    if (isAgentAudit(event)) return 'Агент OpenCode';
    if (publicationActions.has(event.action)) {
        const kind = snapshot(event.details?.after).kind || snapshot(event.details?.before).kind;
        if (kind === 'plugin') { return 'Плагин OpenCode'; }
        if (kind === 'mcp') { return 'MCP-сервер'; }
    }
    return auditResourceLabel(event.resourceType);
}

/** Изменения берём из сохранённых снимков, а не из текущей версии инструмента. */
export function publicationAuditChanges(event: IAuditEvent): IAuditChange[] {
    if (!publicationActions.has(event.action)) { return []; }
    const before = snapshot(event.details?.before), after = snapshot(event.details?.after);
    const changes: IAuditChange[] = [];
    const fields = [
        ['name', 'Название'], ['version', 'Версия'], ['filesCount', 'Файлов в комплекте'],
        ['origin', 'Источник'], ['revision', 'Ревизия источника'],
    ] as const;
    for (const [key, label] of fields) {
        if (before[key] === after[key] || (before[key] === undefined && after[key] === undefined)) { continue; }
        const format = (value: string | number | undefined): string => value === undefined ? 'Не сохранено'
            : key === 'origin' ? origins[String(value)] || String(value) : String(value);
        changes.push({ label, before: format(before[key]), after: format(after[key]) });
    }
    if (before.contentHash && after.contentHash && before.contentHash !== after.contentHash) {
        changes.push({ label: 'Содержимое и настройки комплекта', before: 'Предыдущая версия', after: 'Изменены' });
    }
    return changes;
}

/** Краткая сводка подтверждённых изменений для строки журнала. */
export function auditEventSummary(event: IAuditEvent): string | undefined {
    if (isAgentAudit(event)) return agentAuditSummary(event);
    if (!publicationActions.has(event.action)) { return undefined; }
    const before = snapshot(event.details?.before), after = snapshot(event.details?.after);
    if (!Object.keys(before).length && !Object.keys(after).length) { return undefined; }
    if (event.action === 'plugin.create') { return `Добавлен в общий каталог${after.version === undefined ? '' : ` · версия ${after.version}`}`; }
    if (event.action === 'plugin.delete') { return `Удалён из общего каталога${before.version === undefined ? '' : ` · версия ${before.version}`}`; }
    const changes = publicationAuditChanges(event);
    return changes.filter(change => !['Название', 'Ревизия источника'].includes(change.label)).slice(0, 2)
        .map(change => change.label === 'Содержимое и настройки комплекта'
            ? 'Содержимое или настройки изменены' : `${change.label}: ${change.before} → ${change.after}`).join(' · ')
        || (changes.some(change => change.label === 'Ревизия источника') ? 'Обновлена ревизия источника' : 'Обновлена запись в общем каталоге');
}
