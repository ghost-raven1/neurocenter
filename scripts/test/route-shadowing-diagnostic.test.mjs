import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';

/**
 * AD-19 (entry 10): shadowing-диагностика. Catch-all `api/{*path}` получил запрос на роут,
 * который по таблице entry 8 (route-policy.ts) является ЯВНЫМ → server-лог обязан быть
 * actionable (route + pattern + expected controller), клиенту — фиксированный
 * actionable-текст без internal-деталей. Симуляция: прямой вызов ProxyService.forward.
 * Требует свежей сборки: services/api-gateway npm run build.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const gatewayRequire = createRequire(path.join(ROOT, 'services/api-gateway/package.json'));
gatewayRequire('reflect-metadata');
const { shadowingIncident } = gatewayRequire('./dist/proxy/shadowing-diagnostic.js');
const { ProxyService } = gatewayRequire('./dist/proxy/proxy.service.js');

function captureLog(fn) {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
        const result = fn();
        return { result, lines };
    } finally {
        console.error = original;
    }
}

test('SHADOWED_ROUTE: лог содержит route + pattern + expected (actionable)', () => {
    const { result, lines } = captureLog(() => shadowingIncident('POST', '/api/mcp-host/connect'));
    assert.equal(result, 'McpHostController.connect');
    assert.ok(
        lines.some(
            (line) =>
                line ===
                '[api-gateway] shadowing: route=POST /api/mcp-host/connect pattern=/{*path} expected=McpHostController.connect',
        ),
        `лог обязан быть actionable: ${lines.join(' | ')}`,
    );
});

test('SHADOWED_ROUTE: явный GET-роут bridge → expected BridgeController', () => {
    const { result, lines } = captureLog(() => shadowingIncident('GET', '/api/bridge/install.sh'));
    assert.equal(result, 'BridgeController.installScript');
    assert.ok(
        lines.some(
            (line) =>
                line ===
                '[api-gateway] shadowing: route=GET /api/bridge/install.sh pattern=/{*path} expected=BridgeController.installScript',
        ),
        `лог обязан быть actionable: ${lines.join(' | ')}`,
    );
});

test('Без инцидента: не-явный /api/* и proxy-подмаршруты — лог не пишут', () => {
    for (const [method, p] of [
        ['GET', '/api/other-route'],
        ['POST', '/api/device-channel/heartbeat'],
        ['GET', '/api/mcp-host/connect'], // явная строка — только POST
    ]) {
        const { result, lines } = captureLog(() => shadowingIncident(method, p));
        assert.equal(result, undefined, `${method} ${p} не обязан считаться инцидентом`);
        assert.deepEqual(lines, [], `${method} ${p} не обязан писать shadowing-лог`);
    }
});

test('Без инцидента: /api/-URL без зарегистрированного /api/-варианта (OQ3-нормализация канона — не инцидент)', () => {
    // /api/health, /api/ready, /api/ready/dependencies, /api/internal/*, /api/docs, /api/socket.io:
    // канонический паттерн матчит явную строку таблицы, но /api/-URL-вариант у роута не
    // зарегистрирован (AppController / /internal/* / postCreate) — URL легитимно в домене
    // catch-all (pre-2.10: проксирование в catalog), 500 route-configuration-error — нет.
    for (const [method, p] of [
        ['GET', '/api/health'],
        ['GET', '/api/ready'],
        ['GET', '/api/ready/dependencies'],
        ['POST', '/api/internal/research-mcp/list'],
        ['GET', '/api/docs'],
        ['WS', '/api/socket.io'],
    ]) {
        const { result, lines } = captureLog(() => shadowingIncident(method, p));
        assert.equal(result, undefined, `${method} ${p} не обязан считаться инцидентом`);
        assert.deepEqual(lines, [], `${method} ${p} не обязан писать shadowing-лог`);
    }
});

const makeRes = () => ({
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(body) {
        this.body = body;
        return this;
    },
    send(body) {
        this.body = body;
        return this;
    },
});

test('SHADOWED_ROUTE: клиент получает фиксированный actionable body без internal-деталей', async () => {
    const configService = { get: () => undefined };
    const authGuard = { authenticate: async () => undefined };
    const live = { mutation() {}, bridge() {}, sections() {} };
    const service = new ProxyService(configService, authGuard, live);
    const res = makeRes();
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
        await service.forward(
            { method: 'POST', path: '/api/mcp-host/connect', headers: {}, query: {}, body: {}, aborted: false },
            res,
        );
    } finally {
        console.error = original;
    }
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, {
        code: 'route-configuration-error',
        message: 'Маршрут временно недоступен из-за ошибки конфигурации. Повторите позже.',
    });
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('McpHostController'), 'expected controller не обязан уходить клиенту');
    assert.ok(!body.includes('{*path}'), 'внутренний паттерн не обязан уходить клиенту');
    assert.ok(
        lines.some(
            (line) =>
                line ===
                '[api-gateway] shadowing: route=POST /api/mcp-host/connect pattern=/{*path} expected=McpHostController.connect',
        ),
        'инцидент обязан остаться в server-логе',
    );
});

test('Без инцидента: GET /api/health — не 500 route-configuration-error, обычный proxy-flow', async () => {
    // Фикс false positive (2.13 K3.1): /api/-вариант у /health не зарегистрирован, URL
    // легитимно в домене catch-all — запрос идёт в обычный flow (auth → upstream).
    const configService = { get: () => undefined };
    const authGuard = { authenticate: async () => undefined };
    const live = { mutation() {}, bridge() {}, sections() {} };
    const service = new ProxyService(configService, authGuard, live);
    const res = makeRes();
    await service.forward(
        { method: 'GET', path: '/api/health', headers: {}, query: {}, body: {}, aborted: false },
        res,
    );
    assert.equal(res.statusCode, 401, 'unauthenticated-mock обязан дойти до auth-шага proxy-flow, а не до 500');
    assert.deepEqual(res.body, { error: 'unauthorized' });
});
