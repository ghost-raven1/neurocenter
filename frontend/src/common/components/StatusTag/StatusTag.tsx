import { Tag } from 'antd';
import { FC } from 'react';

type TTagColor = 'success' | 'processing' | 'error' | 'warning' | 'default' | 'blue' | 'purple';

/**
 * Соответствие статусов цвета AntD Tag.
 */
const T_STATUS_COLOR: Record<string, TTagColor> = {
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
const T_STATUS_LABEL: Record<string, string> = {
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

interface IStatusTagProps {
    /** Код статуса (например VERIFYING, RUNNING, ACTIVE). */
    status: string;
    /** Текстовая подпись; по умолчанию — сам статус. */
    label?: string;
}

/**
 * Цветная метка статуса (единая карта статусов всего приложения).
 *
 * @component
 * @param {string} props.status - код статуса
 * @param {string} [props.label] - подпись
 * @returns JSX-элемент Tag
 */
const StatusTag: FC<IStatusTagProps> = ({ status, label }) => (
    <Tag color={T_STATUS_COLOR[status] ?? 'default'}>{label ?? T_STATUS_LABEL[status] ?? status}</Tag>
);

export default StatusTag;
