import { TTagColor } from "./interfaces";

/**
 * Соответствие статусов цвета AntD Tag.
 */
export const T_STATUS_COLOR: Record<string, TTagColor> = {
    VERIFYING: 'processing',
    VERIFIED: 'success',
    REJECTED: 'error',
    DELETING: 'warning',
    DELETED: 'default',
    QUEUED: 'default',
    RUNNING: 'processing',
    SUCCEEDED: 'success',
    FAILED: 'error',
    CANCELLED: 'default',
    CONFLICT: 'warning',
    ACTIVE: 'success',
    ARCHIVED: 'default',
    LOCKED: 'warning',
    PUBLISHED: 'success',
    DEPRECATED: 'default',
};

/**
 * Русские подписи статусов (ключ — код статуса).
 */
export const T_STATUS_LABEL: Record<string, string> = {
    VERIFYING: 'Проверка',
    VERIFIED: 'Проверено',
    REJECTED: 'Отклонено',
    DELETING: 'Удаляется',
    DELETED: 'Удалено',
    QUEUED: 'В очереди',
    RUNNING: 'Выполняется',
    SUCCEEDED: 'Успешно',
    FAILED: 'Ошибка',
    CANCELLED: 'Отменено',
    CONFLICT: 'Конфликт',
    ACTIVE: 'Активен',
    ARCHIVED: 'Архив',
    LOCKED: 'Заблокирован',
    PUBLISHED: 'Опубликован',
    DEPRECATED: 'Устарел',
};