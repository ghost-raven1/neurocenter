import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

/**
 * AD-14 (route shadowing): catch-all прокси `ProxyController` (`api/{*path}`) не должен
 * поглощать явные роуты контроллеров ProxyModule. Express матчит роуты по порядку
 * регистрации в router.stack, поэтому тест проверяет СОБРАННЫЙ app (полный AppModule),
 * а не per-controller изолированный (анти-паттерн mcp-host-access-http.test.mjs —
 * там ProxyController отсутствует и shadowing невидим).
 *
 * Метод (OQ плана): интроспекция Express router.stack собранного app — для каждого
 * явного роута первый matching layer обязан быть явным handler'ом; плюс live-запросы
 * smoke: явные роуты отвечают явными handler'ами, а не-явный /api/* — catch-all прокси.
 * Требует свежей сборки: services/api-gateway npm run build.
 *
 * Нюансы сборки: Nest 11 регистрирует роуты в init(), который отложен до первого
 * listen() — интроспекция только после listen; Express 5 несёт роуты в `inst.router`
 * (lazy getter; `_router` — только в Express 4), layer матчит через `layer.match(path)`,
 * а `@All()` хранится в `route.methods._all`.
 */
const gatewayRequire = createRequire(new URL('../../services/api-gateway/package.json', import.meta.url));
gatewayRequire('reflect-metadata');
const { NestFactory } = gatewayRequire('@nestjs/core');
const { AppModule } = gatewayRequire('./dist/app.module.js');

// Явные роуты контроллеров ProxyModule (src/proxy/proxy.module.ts).
const EXPLICIT_ROUTES = [
    {
        controller: 'McpHostController',
        routePath: '/api/mcp-host/connect',
        method: 'POST',
        url: '/api/mcp-host/connect',
    },
    {
        controller: 'McpHostController',
        routePath: '/api/mcp-host/m/:ticket',
        method: 'GET',
        url: '/api/mcp-host/m/ticket-1',
    },
    {
        controller: 'McpHostController',
        routePath: '/api/mcp-host/m/:ticket',
        method: 'POST',
        url: '/api/mcp-host/m/ticket-1',
    },
    {
        controller: 'ResearchMcpController',
        routePath: '/internal/research-mcp/list',
        method: 'POST',
        url: '/internal/research-mcp/list',
    },
    {
        controller: 'ResearchMcpController',
        routePath: '/internal/research-mcp/call',
        method: 'POST',
        url: '/internal/research-mcp/call',
    },
    {
        controller: 'SystemRoleMcpGatewayController',
        routePath: '/internal/system-role-mcp/execute',
        method: 'POST',
        url: '/internal/system-role-mcp/execute',
    },
    {
        controller: 'SystemRoleMcpGatewayController',
        routePath: '/internal/system-role-mcp/close',
        method: 'POST',
        url: '/internal/system-role-mcp/close',
    },
];
const isCatchAll = (routePath) => typeof routePath === 'string' && routePath.includes('{*');

// Express 5: router — lazy getter на инстансе (в Express 4 это было `_router`).
const routerStack = (app) => {
    const instance = app.getHttpAdapter().getInstance();
    const router = instance._router || instance.router;
    return router.stack;
};

/** Диспетчеризация как в Express: первый слой stack, чьи path-паттерн и method совпадают с запросом. */
const firstMatchingLayer = (stack, method, url) => {
    const normalized = method.toLowerCase();
    for (const layer of stack) {
        const route = layer.route;
        if (!route) continue;
        if (!route.methods._all && !route.methods.all && !route.methods[normalized]) continue;
        if (layer.match && layer.match(url)) return layer;
        if (layer.regexp && layer.regexp.exec(url)) return layer;
    }
    return null;
};

// Auth-пир: 401 на /auth/me — аутентификация не проходит, но и не падает (503),
// поэтому явные handler'ы и прокси отвечают различимыми body.
const authPeer = http.createServer((req, res) => {
    res.statusCode = req.url === '/auth/me' ? 401 : 404;
    res.end();
});
authPeer.listen(0, '127.0.0.1');
await once(authPeer, 'listening');
process.env.NODE_ENV = 'production';
process.env.AUTH_SERVICE_URL = 'http://127.0.0.1:' + authPeer.address().port;
const app = await NestFactory.create(AppModule, { logger: false });
// Nest 11: роуты регистрируются в init(), отложенном до первого listen().
await app.listen(0, '127.0.0.1');
const base = 'http://127.0.0.1:' + app.getHttpServer().address().port;
after(async () => {
    authPeer.closeAllConnections?.();
    await new Promise((resolve) => authPeer.close(resolve));
    await app.close();
});

test('AD-14: явные роуты ProxyModule не поглощены catch-all api/{*path}', () => {
    const stack = routerStack(app);
    const catchAlls = stack.filter((layer) => layer.route && isCatchAll(layer.route.path));
    assert.equal(catchAlls.length, 1, 'в собранном app обязан быть ровно один catch-all api/{*path}');
    const catchAllIndex = stack.indexOf(catchAlls[0]);

    for (const route of EXPLICIT_ROUTES) {
        const winner = firstMatchingLayer(stack, route.method, route.url);
        assert.ok(winner, `роут ${route.method} ${route.url} не матчит ни один layer собранного app`);
        assert.ok(
            !isCatchAll(winner.route.path),
            `РОУТ ПОГЛОЩЁН CATCH-ALL: ${route.method} ${route.url} первым матчит ${winner.route.path}. ` +
                `AD-14: явные контроллеры ProxyModule (${route.controller}) должны регистрироваться до ProxyController`,
        );
        assert.equal(
            winner.route.path,
            route.routePath,
            `${route.method} ${route.url} обязан матчить явный роут ${route.routePath} (${route.controller}), ` +
                `а матчит ${winner.route.path}`,
        );
        assert.ok(
            stack.indexOf(winner) < catchAllIndex,
            `catch-all зарегистрирован раньше явного роута ${route.routePath} (${route.controller}) — AD-14: ` +
                `в proxy.module.ts ProxyController обязан быть последним в controllers`,
        );
    }

    // Поведение catch-all сохранено: не-явный /api/* всё ещё идёт в прокси.
    const fallthrough = firstMatchingLayer(stack, 'GET', '/api/other-route');
    assert.ok(
        fallthrough && isCatchAll(fallthrough.route.path),
        'GET /api/other-route (не явный) обязан матчить catch-all api/{*path} — прокси /api/* сохранён',
    );
});

test("AD-14: live-запросы на собранном app отвечают явными handler'ами, а не proxy-forward", async () => {
    // Явный handler: McpHostController.connect (auth отсутствует → 401 с доменным сообщением).
    // При shadowing ответил бы прокси: 401 { error: 'unauthorized' }.
    const connect = await fetch(base + '/api/mcp-host/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10000),
    });
    assert.equal(connect.status, 401, 'POST /api/mcp-host/connect обязан матчить McpHostController.connect');
    assert.equal(
        (await connect.json()).message,
        'MCP не подключён или доступ отозван.',
        'POST /api/mcp-host/connect ответил как прокси (proxy-forward), а не McpHostController',
    );

    // Явный handler: McpHostController.channel (билет невалиден → jsonrpc 401, upstream не задет).
    const channel = await fetch(base + '/api/mcp-host/m/bogus-ticket', { signal: AbortSignal.timeout(10000) });
    assert.equal(channel.status, 401, 'GET /api/mcp-host/m/:ticket обязан матчить McpHostController.channel');
    const channelBody = await channel.json();
    assert.equal(
        channelBody.error?.code,
        -32001,
        'GET /api/mcp-host/m/:ticket ответил как прокси (proxy-forward), а не McpHostController.channel',
    );

    // Catch-all жив: не-явный /api/* проходит в прокси (auth отсутствует → 401 прокси-подписи).
    const fallthrough = await fetch(base + '/api/other-route', { signal: AbortSignal.timeout(10000) });
    assert.equal(fallthrough.status, 401, 'GET /api/other-route обязан матчить catch-all прокси');
    assert.deepEqual(
        await fallthrough.json(),
        { error: 'unauthorized' },
        'GET /api/other-route не ответил как прокси — catch-all api/{*path} недоступен',
    );
});
