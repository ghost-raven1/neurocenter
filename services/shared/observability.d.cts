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
