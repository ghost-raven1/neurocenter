import type { IncomingMessage, ServerResponse } from 'node:http';

interface IObservabilityOptions {
    service:
        | 'oauth2-bridge'
        | 'api-gateway'
        | 'catalog-service'
        | 'skills-service'
        | 'rag-sync-service'
        | 'feature-flags-service';
    token?: () => string | undefined;
    now?: () => bigint;
}

/** Метрики HTTP и процесса без пользовательских идентификаторов; endpoint требует отдельный секрет. */
export function createObservability(options: IObservabilityOptions): {
    middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
    render: () => string;
    recordAuthFailure: () => void;
};

/** Счётчик отказов аутентификации по имени сервиса (только фиксированные метки, AD-O3). */
export function recordAuthFailure(service: string): void;

/**
 * Счётчик error-событий по имени сервиса и уровню (AD-O5): рендер
 * neurocenter_error_events_total{service,level}. Вызывается crash-handler'ом
 * и явными report-точками.
 */
export function recordErrorEvent(service: string, level: 'error' | 'critical'): void;
