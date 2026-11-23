import { buildClientStackHint } from './clientStackHint';
import { reportClientError } from './reportClientError';

/**
 * AD-O5 (res-obs 6.11): глобальные обработчики ошибок SPA.
 *
 * window 'error' (runtime-исключения) + window 'unhandledrejection'.
 * В репорт уходят только allowlist-поля (reportClientError) — значения
 * исключений в текст не попадают.
 */

const onWindowError = (event: ErrorEvent): void => {
    reportClientError({
        kind: 'uncaught',
        // Ресурсная ошибка без Error-объекта — кадры отсутствуют (hint не строим).
        stackHint: event.error ? buildClientStackHint(event.error) ?? undefined : undefined,
    });
};

const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reportClientError({
        kind: 'rejection',
        stackHint: buildClientStackHint(event.reason) ?? undefined,
    });
};

/**
 * Ставит глобальные обработчики ошибок интерфейса.
 *
 * @returns {() => void} — снятие обработчиков
 */
export function installWindowHandlers(): () => void {
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
        window.removeEventListener('error', onWindowError);
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
}
