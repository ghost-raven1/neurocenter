'use strict';

/**
 * Quota AD-D4: единый enforcement-помощник per-project квот (projects.quota).
 *
 * used — только из accounting (catalog, epic-data entry 1); local-расчёт байтов
 * в enforcement-точке запрещён. Оценка операции консервативна (недооценка = дефект).
 * limit=0 ⇒ unlimited (семантика project-validation.ts — ратификация).
 * Отказ — фиксированное безопасное сообщение (без путей/URL), rejection-метрика
 * и safe-лог только с закрытыми метками и числами (паттерн capacity.cjs).
 */

const dimensions = ['current', 'retention', 'staging'];
const rejections = new Map();

/** Фиксированные сообщения: код отказа детерминирован, данные проекта не раскрываются. */
const exceededMessages = {
    current: 'Лимит объёма файлов проекта превышен. Операция не начата. Обратитесь к администратору.',
    retention: 'Лимит объёма базы знаний проекта превышен. Операция не начата. Обратитесь к администратору.',
    staging: 'Лимит объёма подготовки проекта превышен. Операция не начата. Обратитесь к администратору.',
};
const unavailableMessage = 'Лимиты проекта не подтверждены. Операция не начата. Обратитесь к администратору.';

/** Ошибка не содержит путей, строк соединения или диагностики каталога. */
class QuotaError extends Error {
    constructor(code, dimension) {
        super(code === 'QUOTA_EXCEEDED' ? exceededMessages[dimension] : unavailableMessage);
        this.code = code;
        this.dimension = dimension;
        this.statusCode = code === 'QUOTA_EXCEEDED' ? 507 : 503;
    }
}
function integer(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('Нужна безопасная неотрицательная величина в байтах.');
    }
    return value;
}

/**
 * Чистое решение: used + оценка vs limit. Единственный источник решения для всех
 * enforcement-точек (HTTP-проверка и in-process-проверка каталога).
 */
function decideQuota(request) {
    const used = integer(request.used);
    const limit = integer(request.limit);
    const estimateBytes = integer(request.estimateBytes);
    if (limit === 0) {
        return { allowed: true, unlimited: true, used, limit, estimateBytes };
    }
    return { allowed: used + estimateBytes <= limit, unlimited: false, used, limit, estimateBytes };
}

/**
 * Применение отказа: rejection-счётчик, safe-лог (только projectId, закрытые метки
 * и числа) и QuotaError. Всегда бросает исключение.
 */
function rejectQuota(dimension, reason, details = {}) {
    if (!dimensions.includes(dimension)) {
        throw new TypeError('Неизвестное измерение квоты.');
    }
    if (!['exceeded', 'unavailable'].includes(reason)) {
        throw new TypeError('Неизвестная причина отказа квоты.');
    }
    const key = dimension + ':' + reason;
    rejections.set(key, (rejections.get(key) || 0) + 1);
    const parts = [];
    if (typeof details.projectId === 'string' && details.projectId) {
        parts.push('project=' + details.projectId);
    }
    for (const [label, value] of [
        ['used', details.used],
        ['limit', details.limit],
        ['estimate', details.estimateBytes],
        ['status', details.status],
    ]) {
        if (Number.isSafeInteger(value) && value >= 0) {
            parts.push(label + '=' + value);
        }
    }
    console.warn('[quota-guard] quota rejection dimension=' + dimension + ' reason=' + reason + ' ' + parts.join(' '));
    throw new QuotaError(reason === 'exceeded' ? 'QUOTA_EXCEEDED' : 'QUOTA_UNAVAILABLE', dimension);
}

/**
 * HTTP-enforcement: used + limits читает из accounting каталога
 * (GET /internal/projects/:id/quota-usage, заголовок x-neurocenter-internal),
 * решение — decideQuota. fail-closed: недоступность, не-ok ответ или повреждённый
 * снимок → QuotaError 503 (запись не выполняется без подтверждения лимитов).
 */
async function checkQuota({
    projectId,
    dimension,
    estimateBytes,
    catalogUrl,
    internalToken,
    fetchImpl,
    timeoutMs = 5000,
} = {}) {
    if (typeof projectId !== 'string' || !projectId) {
        throw new TypeError('Нужен идентификатор проекта.');
    }
    if (!dimensions.includes(dimension)) {
        throw new TypeError('Неизвестное измерение квоты.');
    }
    estimateBytes = integer(estimateBytes);
    const base = (catalogUrl ?? process.env.CATALOG_SERVICE_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
    const token = internalToken ?? process.env.NEUROCENTER_INTERNAL_TOKEN ?? '';
    const fetch = fetchImpl ?? globalThis.fetch;
    if (typeof fetch !== 'function') {
        throw new TypeError('Нужна реализация fetch.');
    }
    let response;
    try {
        response = await fetch(`${base}/internal/projects/${encodeURIComponent(projectId)}/quota-usage`, {
            method: 'GET',
            headers: { 'x-neurocenter-internal': token },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        rejectQuota(dimension, 'unavailable', { projectId, estimateBytes });
    }
    let body;
    try {
        if (!response.ok) {
            rejectQuota(dimension, 'unavailable', { projectId, estimateBytes, status: response.status });
        }
        body = await response.json();
    } catch (error) {
        if (error instanceof QuotaError) {
            throw error;
        }
        rejectQuota(dimension, 'unavailable', { projectId, estimateBytes });
    }
    const used = body && body.used ? body.used[dimension] : undefined;
    const limit = body && body.limits ? body.limits[dimension] : undefined;
    if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit) || limit < 0) {
        rejectQuota(dimension, 'unavailable', { projectId, estimateBytes });
    }
    const decision = decideQuota({ used, limit, estimateBytes });
    if (!decision.allowed) {
        rejectQuota(dimension, 'exceeded', { projectId, used, limit, estimateBytes });
    }
    return { allowed: true, used, limit };
}

/** Счётчик отказов по измерению и причине (паттерн capacity-rejections). */
function renderQuotaMetrics() {
    const lines = [];
    for (const [key, value] of rejections) {
        const [dimension, reason] = key.split(':');
        lines.push('neurocenter_quota_rejections_total{dimension="' + dimension + '",reason="' + reason + '"} ' + value);
    }
    return lines.join('\n');
}

module.exports = {
    QuotaError,
    QUOTA_DIMENSIONS: Object.freeze(dimensions),
    decideQuota,
    rejectQuota,
    checkQuota,
    renderQuotaMetrics,
};
