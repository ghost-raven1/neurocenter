interface SwaggerRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    credentials?: string;
}

/** Swagger executes requests as the current browser user, only against this site's origin. */
export function swaggerRequestInterceptor(request: SwaggerRequest): SwaggerRequest {
    const target = new URL(request.url, window.location.href);
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== window.location.origin || target.username || target.password) {
        throw new Error('Swagger выполняет запросы только к текущей площадке Нейроцентра.');
    }
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'x-neurocenter-request'));
    if (request.method?.toUpperCase() === 'POST' && /^\/api\/mcp-host\/m\/[^/]+\/?$/.test(target.pathname)) {
        for (const name of Object.keys(headers)) if (name.toLowerCase() === 'accept') delete headers[name];
        headers.Accept = 'application/json, text/event-stream';
    }
    request.headers = {...headers, 'x-neurocenter-request': '1'};
    request.credentials = 'same-origin';
    return request;
}

export const swaggerUiOptions = {
    url: '/api/docs/openapi.json',
    validatorUrl: null,
    queryConfigEnabled: false,
    persistAuthorization: false,
    withCredentials: true,
    filter: true,
    deepLinking: true,
    docExpansion: 'none',
    displayRequestDuration: true,
    requestInterceptor: swaggerRequestInterceptor,
};
