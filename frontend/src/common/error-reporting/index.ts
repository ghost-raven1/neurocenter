import ErrorBoundary from './ErrorBoundary';
import { installWindowHandlers } from './windowHandlers';

export { ErrorBoundary, installWindowHandlers };
export { reportClientError, flushClientErrorReport, CLIENT_ERROR_MESSAGES } from './reportClientError';
export type { IClientErrorInput, TClientErrorKind } from './reportClientError';
export { buildClientStackHint, sanitizeClientStackHint, truncateToBytes } from './clientStackHint';

/**
 * Установка всего client-репортинга (AD-O5, res-obs 6.11):
 * глобальные обработчики window.onerror / unhandledrejection.
 *
 * @returns {() => void} — снятие обработчиков
 */
export function installErrorReporting(): () => void {
    return installWindowHandlers();
}
