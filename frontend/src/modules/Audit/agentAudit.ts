import type { IAuditEvent } from '../../core/api/interfaces';
import type { IAuditChange } from './auditPresentation';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const integer = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
export const isAgentAudit = (event: IAuditEvent): boolean => event.action.startsWith('agent.') || event.action.startsWith('project.agent.') || event.action === 'project.agents.connect'
    || ['asset.archive', 'asset.restore'].includes(event.action) && [event.details?.before, event.details?.after].some(value => object(value).kind === 'agent');

/** Read only allowlisted metadata; prompt text and arbitrary operation payloads never enter the journal. */
export function agentAuditTitle(event: IAuditEvent): string | undefined {
    if (!isAgentAudit(event)) return;
    return text(object(event.details?.after).name) || text(object(event.details?.before).name) || (event.action === 'project.agents.connect' ? 'Агенты проекта' : undefined);
}
export function agentAuditProject(event: IAuditEvent): string | undefined {
    if (!isAgentAudit(event)) return;
    const before = object(event.details?.before), after = object(event.details?.after);
    return text(after.projectName) || text(before.projectName) || (text(after.projectId)||text(before.projectId)?'Название проекта не сохранено':undefined);
}
export function agentAuditChanges(event: IAuditEvent): IAuditChange[] {
    if (!isAgentAudit(event)) return [];
    const before = object(event.details?.before), after = object(event.details?.after);
    const changes: IAuditChange[] = [];
    for (const [key, label] of [['name', 'Название'], ['slug', 'Имя OpenCode'], ['projectName', 'Проект']] as const) {
        const old = text(before[key]), current = text(after[key]);
        if (old !== current && (old || current)) changes.push({ label, before: old || 'Не сохранено', after: current || 'Не сохранено' });
    }
    for (const [key, label] of [['version', 'Версия шаблона'], ['revision', 'Ревизия настроек']] as const) {
        const old = integer(before[key]), current = integer(after[key]);
        if (old !== current && (old !== undefined || current !== undefined)) changes.push({ label, before: old === undefined ? 'Не сохранено' : String(old), after: current === undefined ? 'Не сохранено' : String(current) });
    }
    for (const [key, label, yes, no] of [['enabled', 'В проекте сохранено', 'Включён', 'Отключён'], ['removed', 'Подключение проекта', 'Удалено', 'Сохранено'], ['archived', 'Общий каталог', 'В архиве', 'Доступен'], ['overridden', 'Настройки проекта', 'Собственные', 'Из шаблона']] as const) {
        if (typeof after[key] === 'boolean' && before[key] !== after[key]) changes.push({ label, before: typeof before[key] === 'boolean' ? before[key] ? yes : no : 'Не сохранено', after: after[key] ? yes : no });
    }
    if (text(before.promptSha256) && text(after.promptSha256) && before.promptSha256 !== after.promptSha256) changes.push({ label: 'Промпт', before: 'Предыдущая версия', after: 'Изменён; текст в журнале не хранится' });
    return changes;
}
export function agentAuditSummary(event: IAuditEvent): string | undefined {
    if (!isAgentAudit(event)) return;
    if (event.action === 'project.agents.connect') return 'Настройки переданы мосту; применение подтверждается отдельно для выбранной папки.';
    if (event.action === 'project.agent.remove') return 'Удаление сохранено в проекте. Файлы OpenCode удаляются после подтверждения моста.';
    if (event.action === 'project.agent.assign') return 'Добавлен в проект в отключённом состоянии; шаблон закреплён точной версией.';
    if (event.action === 'agent.create') return 'Добавлен общий шаблон агента.';
    if (event.action === 'agent.update') return 'Обновлён общий шаблон. Закреплённые версии проектов сохраняются.';
    return agentAuditChanges(event).filter(change => ['В проекте сохранено', 'Ревизия настроек', 'Промпт', 'Общий каталог'].includes(change.label))
        .map(change => `${change.label}: ${change.after}`).join(' · ') || 'Изменены сохранённые настройки агента.';
}
