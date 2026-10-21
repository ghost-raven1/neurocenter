import type {IAuditEvent} from '../../core/api/interfaces';

const labels:Record<string,string>={
    'choose-root':'Выбор папки проектов','bind-project':'Привязка папки проекта','prepare-bind-project':'Проверка привязки папки',
    'install':'Установка инструмента','uninstall':'Удаление инструмента','inspect-installation':'Проверка установки',
    'scan-opencode-models':'Чтение моделей OpenCode','sync-rag':'Отправка знаний на сервер','restore-rag':'Скачивание знаний в проект',
    'scan-project-inventory':'Проверка инструментов проекта','connect-project-agents':'Подключение агентов проекта',
    'connect-hosted-rag-model':'Подключение модели к базе знаний','reindex-hosted-rag':'Переиндексация базы знаний',
    'open-rag-ui':'Открытие базы знаний','probe-runtime':'Проверка запуска инструмента',
};

/** A job UUID identifies an operation, not a computer or a tool name. */
export function operationAuditTitle(event:IAuditEvent):string|undefined {
    if(!['bridge','project'].includes(event.resourceType))return;
    const raw=event.details?.after??event.details?.before;
    const snapshot=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
    if(typeof snapshot.name==='string'&&snapshot.name.trim())return snapshot.name;
    if(event.resourceType==='bridge')return typeof snapshot.jobKind==='string'&&labels[snapshot.jobKind]||'Операция моста · название не сохранено';
    return !event.resourceId||/^prj-[a-f0-9-]{36}$/i.test(event.resourceId)?'Проект · название не сохранено':event.resourceId;
}
