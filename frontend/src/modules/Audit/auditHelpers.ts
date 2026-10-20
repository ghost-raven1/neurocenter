import type { IAuditEvent } from '../../core/api/interfaces';

const ACTION_LABELS: Record<string, string> = {
    install: 'Установка', delete: 'Удаление', release: 'Выпуск', sync: 'Синхронизация',
    restore: 'Восстановление', create: 'Создание', update: 'Обновление', upload: 'Загрузка',
    verify: 'Проверка', transfer: 'Передача', move: 'Перемещение', cleanup: 'Очистка',
    import: 'Импорт', publish: 'Публикация', activate: 'Возврат версии',
};
const ACTION_COLORS: Record<string, string> = {
    install: 'green', delete: 'red', release: 'geekblue', sync: 'purple', restore: 'volcano', create: 'blue', update: 'cyan',
};
const RESOURCE_LABELS: Record<string, string> = {
    skill: 'Скилл', plugin: 'MCP / плагин', mcp: 'MCP-сервер', project: 'Проект', quota: 'Квоты',
    backup: 'Резервная копия', snapshot: 'Снимок', rag: 'База знаний', package: 'Пакет',
    profile: 'Профиль', asset: 'Инструмент', catalog: 'Каталог',
    bridge:'Мост', maintenance:'Обслуживание', user:'Пользователь', feature_flag:'Функция платформы',
};

/** Переводит реальные коды operations, сохраняя неизвестное действие без догадок. */
export function describeAuditAction(action: string): { label: string; color: string } {
    const normalized = action?.toLowerCase() || '';
    if (normalized === 'skill.dependencies.preserve') { return { label: 'История зависимостей', color: 'orange' }; }
    if (normalized === 'skill.directory.create') { return { label: 'Создание папки', color: 'blue' }; }
    if (normalized === 'project.settings.update') { return { label: 'Настройки проекта', color: 'cyan' }; }
    if (normalized === 'project.member.add') { return { label: 'Доступ выдан', color: 'blue' }; }
    if (normalized === 'project.member.update') { return { label: 'Роль изменена', color: 'cyan' }; }
    if (normalized === 'project.member.remove') { return { label: 'Доступ отозван', color: 'red' }; }
    if (normalized === 'project.asset.add') { return { label: 'Добавлен в проект', color: 'blue' }; }
    if (normalized === 'project.asset.remove') { return { label: 'Убран из проекта', color: 'red' }; }
    if (normalized === 'maintenance.policy.update') { return {label:'Настройки обслуживания',color:'cyan'}; }
    if (normalized === 'feature_flag.update') { return {label:'Переключение функции',color:'blue'}; }
    if (normalized === 'maintenance.external.verified') { return {label:'Внешняя копия проверена',color:'green'}; }
    if (normalized === 'maintenance.run.failed') { return {label:'Ошибка полной копии',color:'red'}; }
    if (normalized === 'quota.project') { return { label: 'Изменение квот', color: 'cyan' }; }
    if (normalized === 'backup.catalog') { return { label: 'Резервное копирование', color: 'geekblue' }; }
    const verb = normalized.split('.').pop() || '';
    return { label: ACTION_LABELS[verb] ?? (action || 'Действие не указано'), color: ACTION_COLORS[verb] ?? 'default' };
}

export function auditResourceLabel(type: string): string { return RESOURCE_LABELS[type] ?? (type || 'Ресурс не указан'); }

/** Старое техническое значение admin не выдаётся за подтверждённую почту пользователя. */
export function auditActorLabel(actor: string): string {
    if (!actor || actor === 'admin') { return 'Служебная запись'; }
    return ({ 'builtin-catalog': 'Встроенный каталог', 'skills-service': 'Сервис скиллов' } as Record<string, string>)[actor] || actor;
}

/** Флаговый аудит раскрывает только подтверждённое булево состояние. */
export function featureFlagAuditChanges(details:IAuditEvent['details']):{label:string;before:string;after:string}[] {
    const enabled=(value:unknown):unknown=>value&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>).enabled:undefined;
    const before=enabled(details?.before),after=enabled(details?.after);
    if(typeof before!=='boolean'||typeof after!=='boolean'||before===after)return [];
    return [{label:'Состояние',before:before?'Включено':'Выключено',after:after?'Включено':'Выключено'}];
}

export function formatAuditTime(value: string | null): string {
    if (!value || !Number.isFinite(Date.parse(value))) { return 'Дата не указана'; }
    return new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
}

/** API отдаёт страницу без фильтров: поиск применяется явно только к её записям. */
export function filterAuditPage(events: IAuditEvent[], search: string, outcome: string): IAuditEvent[] {
    const query = search.trim().toLocaleLowerCase('ru-RU');
    return events.filter(event => {
        if (outcome !== 'all' && event.outcome !== outcome) { return false; }
        if (!query) { return true; }
        const names = [event.details?.before, event.details?.after].flatMap(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) { return []; }
            const name = (value as Record<string, unknown>).name;
            return typeof name === 'string' ? [name] : [];
        });
        return [ event.action, describeAuditAction(event.action).label, event.resourceType,
            auditResourceLabel(event.resourceType), event.resourceId, event.actor, auditActorLabel(event.actor),
            event.correlationId, event.id, ...names ]
            .join(' ').toLocaleLowerCase('ru-RU').includes(query);
    });
}

/** Показывает только известные несекретные настройки обслуживания. */
export function maintenanceAuditChanges(details:IAuditEvent['details']):{label:string;before:string;after:string}[] {
    const state=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
    const before=state(state(details?.before).policy);const after=state(state(details?.after).policy);
    const labels:Record<string,string>={enabled:'Расписание',timeZone:'Часовой пояс',schedule:'Дни и время',windows:'Допустимые окна',maxPauseMinutes:'Максимальная пауза, мин',localCopies:'Локальных комплектов',externalRetentionDays:'Внешнее хранение, дней',rpoMinutes:'RPO, мин',rtoMinutes:'RTO, мин'};
    const names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    const days=(value:unknown)=>Array.isArray(value)?value.map(day=>names[Number(day)-1]||'?').join(', '):'';
    const format=(key:string,value:unknown):string=>{
        if(value===undefined||value===null){return 'Не задано';}
        if(key==='enabled'){return value?'Включено':'Выключено';}
        if(key==='schedule'){const item=state(value);return `${days(item.days)} · ${String(item.time||'')}`;}
        if(key==='windows'&&Array.isArray(value)){return value.map(item=>{const row=state(item);return `${days(row.days)} ${String(row.start||'')}–${String(row.end||'')}`;}).join('; ');}
        return String(value);
    };
    return Object.entries(labels).filter(([key])=>JSON.stringify(before[key])!==JSON.stringify(after[key])).map(([key,label])=>({label,before:format(key,before[key]),after:format(key,after[key])}));
}
