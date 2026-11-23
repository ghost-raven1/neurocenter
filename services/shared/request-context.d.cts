import type { IncomingMessage, ServerResponse } from 'node:http';

type TRequestId = string;

interface IRequestContextMiddlewareOptions {
    /** Точка генерации UUID4 (тесты); по умолчанию node:crypto randomUUID. */
    generateId?: () => TRequestId;
}

export const BACKGROUND_REQUEST_ID: 'background';
export const REQUEST_ID_HEADER: 'x-request-id';

/** Express-middleware: X-Request-ID (нет/невалидный → UUID4) в ALS + ответный заголовок. */
export function createRequestContextMiddleware(
    options?: IRequestContextMiddlewareOptions,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** Фоновая работа: jobId в поле requestId (формат как у заголовка X-Request-ID). */
export function withRequestContext<T>(requestId: TRequestId, fn: () => T): T;

/** Текущий id контекста; undefined вне запроса/фоновой работы. */
export function getRequestId(): TRequestId | undefined;

/** Заголовок для внутреннего вызова: контекст либо новый UUID4 — всегда присутствует. */
export function requestContextHeaders(): { 'x-request-id': TRequestId };

/** Обёртка fetch: подставляет X-Request-ID (контекст или новый UUID4). */
export function injectRequestContext(fetchImpl?: typeof fetch): (url: string | URL, init?: RequestInit) => Promise<Response>;
/** Готовая обёртка глобального fetch для внутренних HTTP-вызовов. */
export function internalFetch(url: string | URL, init?: RequestInit): Promise<Response>;

/** Валидный requestId (формат заголовка: [A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]). */
export function isRequestId(value: unknown): value is TRequestId;

/** UUID4-генератор requestId. */
export function newRequestId(): TRequestId;
