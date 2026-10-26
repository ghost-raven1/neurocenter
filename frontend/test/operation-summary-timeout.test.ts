import http from 'node:http';
import { once } from 'node:events';
import { isAxiosError } from 'axios';
import { afterEach, expect, it } from 'vitest';

import base from '../src/core/api/base';
import bff from '../src/core/api/bff';

const originalBase = base.defaults.baseURL;
afterEach(() => { base.defaults.baseURL = originalBase; });

it('зависшее чтение сводки прекращает HTTP ожидание за 30 секунд и позволяет следующий GET', async () => {
    let received!: () => void;
    const seen = new Promise<void>(resolve => { received = resolve; });
    const requests: string[] = [];
    const resultPage = { items: [], page: 1, size: 1, total: 0, activeCount: 0 };
    const server = http.createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`); request.resume();
        if (requests.length === 1) { received(); return; }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(resultPage));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base.defaults.baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const started = Date.now();
        const result = bff.listOperations({ page: 1, size: 1 }).catch(error => error);
        await seen;
        const failure = await result;
        expect(isAxiosError(failure)).toBe(true);
        expect(failure.code).toBe('ECONNABORTED');
        expect(Date.now() - started).toBeGreaterThanOrEqual(29000);
        expect(await bff.listOperations({ page: 1, size: 1 })).toEqual(resultPage);
        expect(requests).toEqual(['GET /api/operations?page=1&size=1', 'GET /api/operations?page=1&size=1']);
    } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
}, 40000);
