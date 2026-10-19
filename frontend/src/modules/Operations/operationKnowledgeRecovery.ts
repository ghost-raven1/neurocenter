import type { IOperation } from '../../core/api/interfaces';

const LEGACY_PLAN_ERROR = 'Синхронизация требует проверки плана в MCP. Изменения не подтверждены.';
const LEGACY_CONTRACT_ERROR = 'Задание создано прежней версией моста. Индекс не подтверждён. Обновите мост и повторите действие для выбранной папки.';

/** Точные прежние отказы нельзя повторять без выбора актуальной привязки. */
export function requiresKnowledgeResync(operation: IOperation): boolean {
    return operation.resourceType === 'bridge' && operation.type === 'SYNC' && operation.state === 'FAILED'
        && [LEGACY_PLAN_ERROR, LEGACY_CONTRACT_ERROR].includes(operation.error || '');
}

/** Прежняя передача требует нового задания для выбранной папки, а не повтора старой квитанции. */
export function operationKnowledgeRecovery(operation: IOperation): { href: string; reason: string } | undefined {
    if (!requiresKnowledgeResync(operation)
        || !operation.projectId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(operation.projectId)) { return; }
    return {
        href: `/projects/${encodeURIComponent(operation.projectId)}?tab=rag`,
        reason: operation.error === LEGACY_PLAN_ERROR
            ? 'Прежний мост остановил большую передачу на предварительном плане. Обновите мост и запустите синхронизацию во вкладке «База знаний».'
            : 'Прежнее задание не подтверждает индекс выбранной папки. Обновите мост и запустите синхронизацию во вкладке «База знаний».',
    };
}
