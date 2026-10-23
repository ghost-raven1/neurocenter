import { formatBytes } from '../../common/utils/format';
import type { IOperation, TOperationState } from '../../core/api/interfaces';

export const operationStateOptions: { value: TOperationState; label: string }[] = [
    { value: 'QUEUED', label: 'В очереди' },
    { value: 'RUNNING', label: 'Выполняется' },
    { value: 'SUCCEEDED', label: 'Успешно' },
    { value: 'FAILED', label: 'Ошибка' },
    { value: 'CANCELLED', label: 'Отменено' },
    { value: 'CONFLICT', label: 'Конфликт' },
];

const operationTypes: Record<string, string> = {
    INSTALL: 'Установка', DELETE: 'Удаление', CATALOG: 'Каталог', PROJECT: 'Проект', BUILD: 'Упаковка инструмента', MODEL: 'Хостинг модели',
    DOWNLOAD: 'Скачивание', RELEASE: 'Публикация', UPLOAD: 'Загрузка', VERIFY: 'Проверка',
    SYNC: 'Синхронизация', TRANSFER: 'Передача', MOVE: 'Перемещение', CLEANUP: 'Очистка', RESTORE: 'Восстановление',
};
const resourceTypes: Record<string, string> = {
    'system-role': 'Системный агент', bridge: 'Мост', snapshot: 'Снимок', profile: 'Профиль', skill: 'Скилл',
    package: 'Пакет', rag: 'RAG-индекс', project: 'Проект', catalog: 'Каталог', 'tool-build': 'MCP или плагин', model: 'Модель',
};
const logLevels: Record<string, { label: string; color?: string }> = {
    INFO: { label: 'Инфо', color: 'processing' },
    WARN: { label: 'Внимание', color: 'warning' },
    ERROR: { label: 'Ошибка', color: 'error' },
    DEBUG: { label: 'Отладка' },
};
const dateTime = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const clock = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const operationTypeLabel = (type: string): string => operationTypes[type] ?? type;
export const operationResourceLabel = (type: string): string => resourceTypes[type] ?? type;
export const operationLogLevel = (level: string) => logLevels[level.toUpperCase()] ?? { label: level };
export const shortOperationId = (id: string): string => id.length > 22 ? `${id.slice(0, 12)}…` : id;

/** Показывает полученный процент, не вычисляя завершение или оставшееся время по статусу. */
export function operationProgressPercent(percent: number): number {
    return Number.isFinite(percent) ? Math.round(Math.max(0, Math.min(100, percent))) : 0;
}

/** Отсутствующее время не подменяется временем создания или текущими часами. */
export function formatOperationTime(value: string | null, onlyTime = false): string {
    if (!value) { return '—'; }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : (onlyTime ? clock : dateTime).format(date);
}

export function operationTransfer(operation: Pick<IOperation, 'bytesDone' | 'bytesTotal'>): string | null {
    if (!operation.bytesDone && !operation.bytesTotal) { return null; }
    const bytes = (value: number): string => value < 1000 ? `${value} Б` : formatBytes(value);
    return operation.bytesTotal > 0
        ? `${bytes(operation.bytesDone)} / ${bytes(operation.bytesTotal)}`
        : `${bytes(operation.bytesDone)} передано`;
}
