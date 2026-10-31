export type TTagColor = 'success' | 'processing' | 'error' | 'warning' | 'default' | 'blue' | 'purple';

export interface IStatusTagProps {
    /** Код статуса (например VERIFYING, RUNNING, ACTIVE). */
    status: string;
    /** Текстовая подпись; по умолчанию — сам статус. */
    label?: string;
}