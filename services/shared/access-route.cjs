'use strict';

/** Авторизация и фильтр ответа сравнивают один декодированный путь; upstream получает исходный URL. */
function canonicalAccessRoute(value) {
    if (typeof value !== 'string') { return undefined; }
    try {
        const route = decodeURIComponent(value).replace(/\/+$/, '');
        return route.includes('..') || route.includes('\\') ? undefined : route;
    } catch { return undefined; }
}

module.exports = { canonicalAccessRoute };
