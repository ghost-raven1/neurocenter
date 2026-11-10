/**
 * AD-19 (entry 10): error-body-политика gateway-прокси.
 *
 * Внешний body ошибки — фиксированный набор: машина-читаемый `code` + user-safe `message`.
 * Внутренние детали (hostname:port, body upstream-ошибки, текст exception) в body клиента
 * не уходят — только в server-лог (console.error). 4xx-доменные ответы (доменные тексты
 * allowlist'а) передаются как есть. Статус-коды домена не меняются.
 */

/** Транспортная ошибка upstream: не удалось установить соединение / DNS. */
export const UPSTREAM_UNAVAILABLE = {
    code: 'upstream-unavailable',
    message: 'Сервис временно недоступен. Повторите позже.',
} as const;

/** Транспортная ошибка upstream: превышен деадлайн. */
export const UPSTREAM_TIMEOUT = {
    code: 'upstream-timeout',
    message: 'Сервис не ответил вовремя. Повторите позже.',
} as const;

/** Upstream ответил 5xx: статус сохранён, body фиксированный (детали — только в log). */
export const UPSTREAM_ERROR = {
    code: 'upstream-error',
    message: 'Сервис временно недоступен. Повторите позже.',
} as const;

/** Shadowing-инцидент (AD-14): явный роут из таблицы entry 8 дошёл до catch-all. */
export const ROUTE_CONFIGURATION = {
    code: 'route-configuration-error',
    message: 'Маршрут временно недоступен из-за ошибки конфигурации. Повторите позже.',
} as const;

/**
 * Axios-транспортный таймаут (504), в остальном транспортном сбое — 502.
 * Отмена клиента (abort) не является ошибкой upstream — она обрабатывается до catch.
 * OQ1: клиентские retry по status 502/504 отсутствуют (проверено по frontend/src и mcp/).
 */
export function isTransportTimeout(error: unknown): boolean {
    const e = error as { code?: unknown; message?: unknown } | null | undefined;
    if (typeof e?.code === 'string' && ['ECONNABORTED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(e.code)) {
        return true;
    }
    return typeof e?.message === 'string' && /(^|\s)timeout of \d+ms exceeded|\bETIMEDOUT\b/.test(e.message);
}
