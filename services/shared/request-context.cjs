'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

/**
 * AD-O1/O2 (6.6): сквозной correlation id.
 *
 * - Middleware уважает входящий заголовок X-Request-ID (nginx $request_id) и лишь
 *   валидирует его; при отсутствии/невалидном значении генерирует UUID4 и
 *   повторяет в ответном заголовке. Контекст — AsyncLocalStorage: deep-код
 *   (repositories, workers) получает requestId без изменения сигнатур.
 * - Внутренние HTTP-вызовы обязаны нести заголовок: internalFetch/injectRequestContext
 *   подставляют текущий контекст либо новый UUID4 (заголовок никогда не отсутствует).
 * - Фоновые работы кладут jobId в то же поле через withRequestContext (jobId
 *   ограничена тем же форматом, что и заголовок).
 */
const storage = new AsyncLocalStorage();
const REQUEST_ID_HEADER = 'x-request-id';
// Только «безопасные для заголовка» символы: nginx $request_id (hex) и UUID4 проходят,
// job-имена ('job-catalog-rebuild', 'job-chat-<uuid>') тоже.
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$/i;
const BACKGROUND_REQUEST_ID = 'background';

function newRequestId() {
    return randomUUID();
}

function isRequestId(value) {
    return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** Middleware: X-Request-ID (нет/невалидный → UUID4) в ALS + ответный заголовок. */
function createRequestContextMiddleware(options = {}) {
    const generateId = options.generateId ?? newRequestId;
    return function requestContextMiddleware(req, res, next) {
        const value = req.headers ? req.headers[REQUEST_ID_HEADER] : undefined;
        const first = Array.isArray(value) ? value[0] : value;
        const id = isRequestId(first) ? first : generateId();
        res.setHeader(REQUEST_ID_HEADER, id);
        storage.run({ requestId: id }, () => next());
    };
}

/** Фоновая работа: jobId в поле requestId — строки тика группируются по работе. */
function withRequestContext(requestId, fn) {
    if (!isRequestId(requestId)) {
        throw new TypeError('withRequestContext: requestId не соответствует формату заголовка X-Request-ID.');
    }
    return storage.run({ requestId }, fn);
}

/** Текущий id контекста (undefined вне запроса/фоновой работы). */
function getRequestId() {
    const store = storage.getStore();
    return isRequestId(store && store.requestId) ? store.requestId : undefined;
}

/** Заголовок для внутреннего вызова: контекст либо новый UUID4 — всегда присутствует. */
function requestContextHeaders() {
    return { [REQUEST_ID_HEADER]: getRequestId() || newRequestId() };
}

/**
 * Обёртка fetch для внутренних HTTP-вызовов: подставляет X-Request-ID.
 * Plain-объекты headers остаются plain-объектами (без изменения контейнера);
 * Headers/массив нормализуются в Headers. Существующий x-request-id перекрывается.
 */
function injectRequestContext(fetchImpl) {
    const impl = fetchImpl || globalThis.fetch;
    return function fetchWithRequestContext(url, init) {
        const id = getRequestId() || newRequestId();
        const existing = init && init.headers;
        let headers;
        if (existing instanceof Headers || Array.isArray(existing)) {
            headers = new Headers(existing);
            headers.set(REQUEST_ID_HEADER, id);
        } else {
            headers = { ...(existing || {}), [REQUEST_ID_HEADER]: id };
        }
        return impl(url, { ...(init || {}), headers });
    };
}

/** Готовая обёртка глобального fetch (внутренние HTTP-вызовы сервисов). */
const internalFetch = (url, init) => injectRequestContext(globalThis.fetch)(url, init);

module.exports = {
    BACKGROUND_REQUEST_ID,
    REQUEST_ID_HEADER,
    createRequestContextMiddleware,
    getRequestId,
    injectRequestContext,
    internalFetch,
    isRequestId,
    newRequestId,
    requestContextHeaders,
    withRequestContext,
};
