import type { IErrorEvent } from '../../core/api/interfaces';

/**
 * AD-O5 (res-obs 6.11): safe-представление error-событий. API отдаёт только
 * safe-поля (AD-O8); UI не запрашивает «больше» и не показывает сырой stack —
 * stackHint показывается как кадры.
 */

/** Человекочитаемые подписи известных фиксированных классификаторов. */
const MESSAGE_LABELS: Record<string, string> = {
    'client-render-error': 'Ошибка интерфейса (render)',
    'client-uncaught-error': 'Неперехваченная ошибка',
    'client-unhandled-rejection': 'Необработанное исключение (rejection)',
    'crash.uncaughtException': 'Сбой сервиса (uncaught exception)',
    'crash.unhandledRejection': 'Сбой сервиса (unhandled rejection)',
};

/** Подпись фиксированного классификатора; неизвестный — как есть (без догадок). */
export function describeErrorMessage(message: string): string {
    return MESSAGE_LABELS[message] ?? (message || 'Классификатор не указан');
}

/** Уровень записи: error / critical. */
export function describeErrorLevel(level: IErrorEvent['level']): { label: string; color: string } {
    return level === 'critical' ? { label: 'Критическая', color: 'volcano' } : { label: 'Ошибка', color: 'red' };
}

/** Дата записи error-события. */
export function formatErrorTime(value: string | null): string {
    if (!value || !Number.isFinite(Date.parse(value))) {
        return 'Дата не указана';
    }
    return new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
}

/**
 * Кадры stack-hint: по одному на строку, без пустых. В hint нет значений
 * переменных (AD-O8) — строки безопасны для показа.
 */
export function errorStackFrames(stackHint: string | null): string[] {
    if (!stackHint) {
        return [];
    }
    return stackHint
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * Ссылка на историю действий с тем же requestId (correlation, entry 6/14):
 * Audit открывает поиск по строке — оператор находит связанную запись.
 */
export function auditLinkForRequestId(requestId: string): string {
    return `/audit?search=${encodeURIComponent(requestId)}`;
}
