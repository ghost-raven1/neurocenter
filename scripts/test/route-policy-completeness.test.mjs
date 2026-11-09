import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * AD-6 (route-политика): декларативная таблица services/api-gateway/src/proxy/route-policy.ts
 * обязана ПОКРЫТЬ собранное приложение и не дрейфовать от него:
 *
 *  1. Каждый (метод, маршрут) в router.stack собранного app обязан иметь строку таблицы
 *     (catch-all api/{*path} — default-строка; ровно один splat-маршрут).
 *  2. Методы строки таблицы обязаны существовать у соответствующего маршрута app
 *     (drift table→stack); postCreate-строки (/docs, /socket.io — монтируются после
 *     bootstrap, вне NestJS-модулей) обязаны НЕ быть в router.stack.
 *  3. Инвентарь special-forward'ов: matchPolicy по sample-маршрутам обязан вернуть строку
 *     с бюджетами, равными shared-константам (guard чистого переноса: значения не меняются).
 *  4. Default-строка: maxResponseBytes — конечный (Infinity/-1 запрещены, AD-6).
 *  5. Static-скан src/proxy/*.ts (кроме route-policy.ts): ни одного Infinity, ни одного
 *     литерального бюджета в timeout:/maxContentLength:/maxBodyLength:/limit: и ни одного
 *     литерального деадлайна setTimeout — бюджеты читаются только из таблицы.
 *
 * Канонический вид (OQ3): строки таблицы — без ведущего префикса `api/`; один
 * /bridge/*-набор покрывает и /bridge/*, и /api/bridge/*.
 * Требует свежей сборки: services/api-gateway npm run build.
 */
const gatewayRequire = createRequire(new URL('../../services/api-gateway/package.json', import.meta.url));
gatewayRequire('reflect-metadata');
const { NestFactory } = gatewayRequire('@nestjs/core');
const { AppModule } = gatewayRequire('./dist/app.module.js');
const { ROUTE_POLICY, CATCH_ALL_ROW, CATCH_ALL_PATH, matchPolicy, canonicalRoutePath } = gatewayRequire(
    './dist/proxy/route-policy.js',
);
const sharedRequire = createRequire(import.meta.url);
const { MODEL_CHAT_GATEWAY_TIMEOUT_MS } = sharedRequire('../../services/shared/model-chat-deadline.cjs');
const { TOOL_IMPORT_GATEWAY_TIMEOUT_MS, TOOL_IMPORT_ROUTE } = sharedRequire('../../services/shared/tool-import-deadline.cjs');
const { DISCUSSION_ATTACHMENT_MAX_BYTES } = sharedRequire('../../services/shared/discussion-attachment-route.cjs');
const { ASSET_SOURCE_ARCHIVE_MAX_BYTES } = sharedRequire('../../services/shared/asset-source-archive-route.cjs');
const { SNAPSHOT_CHUNK_BYTES } = sharedRequire('../../services/shared/project-snapshot.cjs');
const { CEILING } = sharedRequire('../../services/shared/runtime-artifacts.cjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KIB = 1024;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const UUID = '11111111-2222-4333-8444-555555555555';
const SHA = 'a'.repeat(64);

// Express 5: router — lazy getter на инстансе (в Express 4 это было `_router`).
const routerStack = (app) => {
    const instance = app.getHttpAdapter().getInstance();
    const router = instance._router || instance.router;
    return router.stack;
};

/** Методы маршрута из route.methods (Express 5: @All раскрывает все ключи; HEAD у GET не ключ). */
const routeMethodNames = (route) =>
    Object.keys(route.methods).filter((key) => key !== '_all' && key !== 'all');

/** @All-маршрут: либо _all/all-маркер (Express 4), либо раскрытые все методы (Express 5). */
const isAllRoute = (route) =>
    !!route.methods._all || !!route.methods.all || routeMethodNames(route).length >= 10;

/** Паттерн строки таблицы как в route-policy.ts: ':param' — один сегмент, остальное дословно. */
const rowPatternRe = (rowPath) =>
    new RegExp(
        '^' +
            rowPath
                .split('/')
                .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
                .join('/') +
            '$',
    );

// Auth-пир: 401 на /auth/me — тот же фикстур-паттерн, что и mcp-host-route-shadowing.test.mjs.
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
after(async () => {
    authPeer.closeAllConnections?.();
    await new Promise((resolve) => authPeer.close(resolve));
    await app.close();
});

const stackRoutes = () =>
    routerStack(app)
        .filter((layer) => layer.route)
        .map((layer) => ({ path: layer.route.path, methods: routeMethodNames(layer.route), all: isAllRoute(layer.route) }));

const routeRows = ROUTE_POLICY.filter(
    (row) => row.kind === 'route' && !row.postCreate && row.path !== CATCH_ALL_PATH,
);

test('AD-6: ровно один catch-all, и каждый (метод, маршрут) app покрыт строкой таблицы', () => {
    const routes = stackRoutes();
    const catchAlls = routes.filter((route) => route.path.includes('{*'));
    assert.equal(catchAlls.length, 1, 'в собранном app обязан быть ровно один splat-маршрут api/{*path}');
    assert.equal(catchAlls[0].path, '/api/{*path}');
    assert.ok(catchAlls[0].all, 'catch-all обязан принимать все методы (@All)');

    for (const route of routes) {
        if (route.path.includes('{*')) continue;
        const canonical = canonicalRoutePath(route.path);
        assert.ok(canonical !== undefined, `маршрут ${route.path} не канонизируется (OQ3)`);
        for (const method of route.methods) {
            const methodUpper = method.toUpperCase();
            const covering = routeRows.find(
                (row) =>
                    rowPatternRe(row.path).test(canonical) &&
                    (row.allowed.includes(methodUpper) || row.allowed.includes('ALL')),
            );
            assert.ok(
                covering,
                `маршрут ${methodUpper} ${route.path} (канон ${canonical}) не имеет строки в route-policy — ` +
                    `AD-6: таблица обязана покрывать собранное приложение`,
            );
        }
    }
});

test('AD-6: drift таблица→приложение: методы строк существуют у маршрутов, postCreate вне stack', () => {
    const routes = stackRoutes();
    for (const row of ROUTE_POLICY) {
        if (row.kind !== 'route' || row.path === CATCH_ALL_PATH) continue;
        if (row.postCreate) continue; // postCreate — ниже отдельной проверкой (вне router.stack)
        const matching = routes.filter((route) =>
            rowPatternRe(row.path).test(canonicalRoutePath(route.path) || ''),
        );
        assert.ok(
            matching.length > 0,
            `строка ${row.path} не матчит ни один маршрут собранного app — устаревшая или вымышленная строка`,
        );
        const probeMethods = row.allowed.includes('ALL')
            ? ['get', 'post']
            : row.allowed.filter((method) => method !== 'WS').map((method) => method.toLowerCase());
        for (const route of matching) {
            for (const method of probeMethods) {
                assert.ok(
                    route.all || route.methods.includes(method),
                    `строка ${row.path} декларирует ${method.toUpperCase()}, но маршрут ${route.path} его не имеет`,
                );
            }
        }
    }
    // postCreate: /docs (Swagger) и /socket.io монтируются после bootstrap — их нет в router.stack.
    const postCreates = ROUTE_POLICY.filter((row) => row.postCreate);
    assert.deepEqual(
        postCreates.map((row) => row.path).sort(),
        ['/docs', '/socket.io'],
        'postCreate-строки обязаны быть ровно /docs и /socket.io',
    );
    for (const row of postCreates) {
        const inStack = routes.some((route) => rowPatternRe(row.path).test(canonicalRoutePath(route.path) || ''));
        assert.ok(!inStack, `postCreate-маршрут ${row.path} обязан отсутствовать в router.stack`);
    }
});

// Инвентарь special-forward'ов: (метод, sample-путь) → ожидаемая строка и бюджеты = shared-константы.
const INVENTORY = [
    // Model inference (model-inference-forward.ts).
    { method: 'POST', path: `/api/model-chats/${UUID}/turns`, row: '/api/model-chats/:id/turns', expect: { timeoutMs: MODEL_CHAT_GATEWAY_TIMEOUT_MS, maxResponseBytes: 64 * MIB } },
    { method: 'POST', path: `/api/model-chats/${UUID}/turns/${UUID}/retry`, row: '/api/model-chats/:id/turns', expect: { timeoutMs: MODEL_CHAT_GATEWAY_TIMEOUT_MS, maxResponseBytes: 64 * MIB } },
    { method: 'POST', path: `/api/model-chats/${UUID}/attachments`, row: '/api/model-chats/:id/turns', expect: { timeoutMs: MODEL_CHAT_GATEWAY_TIMEOUT_MS, maxResponseBytes: 64 * MIB } },
    { method: 'POST', path: '/api/models/gpt-4/ollama/api/chat', row: '/api/models/:model/ollama/*', expect: { timeoutMs: 610000, maxResponseBytes: 8 * MIB } },
    { method: 'POST', path: '/api/models/gpt-4/ollama/api/embed', row: '/api/models/:model/ollama/*', expect: { timeoutMs: 610000, maxResponseBytes: 8 * MIB } },
    { method: 'POST', path: '/api/models/gpt-4/ollama/v1/chat/completions', row: '/api/models/:model/ollama/*', expect: { timeoutMs: 610000, maxResponseBytes: 8 * MIB } },
    { method: 'POST', path: '/api/models/gpt-4/ollama/v1/embeddings', row: '/api/models/:model/ollama/*', expect: { timeoutMs: 610000, maxResponseBytes: 8 * MIB } },
    // Tool import (tool-import-forward.ts).
    { method: 'POST', path: TOOL_IMPORT_ROUTE, row: '/api/tool-builds/imports', expect: { timeoutMs: TOOL_IMPORT_GATEWAY_TIMEOUT_MS } },
    // Tool supply/asset (tool-supply-stream.ts).
    { method: 'GET', path: `/api/tool-builds/${UUID}/supply`, row: '/api/tool-builds/:id/supply', expect: { timeoutMs: 300000, maxResponseBytes: CEILING.unpackedBytes } },
    { method: 'HEAD', path: `/api/tool-builds/${UUID}/supply`, row: '/api/tool-builds/:id/supply', expect: { timeoutMs: 300000, maxResponseBytes: CEILING.unpackedBytes } },
    { method: 'GET', path: `/api/tool-builds/${UUID}/asset`, row: '/api/tool-builds/:id/asset', expect: { timeoutMs: 300000, maxResponseBytes: 16 * MIB } },
    // Загрузки (source-upload-stream.ts / gguf-import-stream.ts).
    { method: 'PUT', path: `/api/tool-builds/uploads/${UUID}/content`, row: '/api/tool-builds/uploads/:id/content', expect: { timeoutMs: 600000, maxBodyBytes: 256 * MIB, maxResponseBytes: MIB } },
    { method: 'PUT', path: `/api/models/gguf-imports/${UUID}/content`, row: '/api/models/gguf-imports/:id/content', expect: { maxResponseBytes: MIB } },
    { method: 'POST', path: '/api/discussions/attachments', row: '/api/discussions/attachments', expect: { timeoutMs: 600000, maxBodyBytes: DISCUSSION_ATTACHMENT_MAX_BYTES, maxResponseBytes: MIB } },
    { method: 'GET', path: `/api/discussions/attachments/${UUID}/content`, row: '/api/discussions/attachments/:id/content', expect: { timeoutMs: 30000, maxResponseBytes: DISCUSSION_ATTACHMENT_MAX_BYTES } },
    { method: 'HEAD', path: `/api/discussions/attachments/${UUID}/content`, row: '/api/discussions/attachments/:id/content', expect: { timeoutMs: 30000, maxResponseBytes: DISCUSSION_ATTACHMENT_MAX_BYTES } },
    { method: 'PUT', path: `/api/projects/project-1/snapshot-uploads/${UUID}/blobs/${SHA}`, row: '/api/projects/:key/snapshot-uploads/:id/blobs/:sha', expect: { timeoutMs: 600000, maxBodyBytes: SNAPSHOT_CHUNK_BYTES, maxResponseBytes: MIB } },
    { method: 'PUT', path: '/api/asset-sources/archive', row: '/api/asset-sources/archive', expect: { timeoutMs: 600000, maxBodyBytes: ASSET_SOURCE_ARCHIVE_MAX_BYTES, maxResponseBytes: 64 * MIB } },
    // Скачивания (snapshot-stream.ts / backup-download-stream.ts / runtime-artifact-stream.ts).
    { method: 'GET', path: `/api/projects/project-1/versions/${UUID}/blobs/${SHA}`, row: '/api/projects/:key/versions/:id/blobs/:sha', expect: { timeoutMs: 120000, maxResponseBytes: SNAPSHOT_CHUNK_BYTES } },
    { method: 'HEAD', path: `/api/projects/project-1/versions/${UUID}/blobs/${SHA}`, row: '/api/projects/:key/versions/:id/blobs/:sha', expect: { timeoutMs: 120000, maxResponseBytes: SNAPSHOT_CHUNK_BYTES } },
    { method: 'GET', path: '/api/projects/project-1/backups/backup-1/download', row: '/api/projects/:key/backups/:id/download', expect: { timeoutMs: 30000, maxResponseBytes: CEILING.unpackedBytes } },
    { method: 'GET', path: `/api/device-channel/jobs/${UUID}/runtime/${SHA}`, row: '/api/device-channel/jobs/:id/runtime/:sha', expect: { timeoutMs: 30000, maxResponseBytes: 256 * MIB } },
    // Device-канал (device-channel-json.ts / proxy.service deviceEmbedding).
    { method: 'POST', path: '/api/device-channel/embedding', row: '/api/device-channel/embedding', expect: { timeoutMs: 115000, maxResponseBytes: 8 * MIB } },
    { method: 'POST', path: '/api/device-channel/identity', row: '/api/device-channel/*', expect: { timeoutMs: 30000, maxBodyBytes: 600 * KIB } },
    // Прочие catch-all подмаршруты (generic upstreamRequest).
    { method: 'POST', path: '/api/bridge-source/check', row: '/api/bridge-source/check', expect: { timeoutMs: 60000 } },
    { method: 'GET', path: '/api/tool-builds/repository', row: '/api/tool-builds/repository|npm', expect: { timeoutMs: 85000 } },
    { method: 'GET', path: '/api/tool-builds/npm', row: '/api/tool-builds/repository|npm', expect: { timeoutMs: 85000 } },
    { method: 'GET', path: `/api/model-chats/${UUID}`, row: '/api/model-chats/*', expect: { maxResponseBytes: 64 * MIB } },
    // OQ3: канонический вид без /api/ — один /bridge/*-набор покрывает оба префикса.
    { method: 'GET', path: '/bridge/config', row: '/bridge/config', kind: 'route', expect: { timeoutMs: 600000, maxResponseBytes: 128 * KIB } },
    { method: 'GET', path: '/api/bridge/config', row: '/bridge/config', kind: 'route', expect: { timeoutMs: 600000, maxResponseBytes: 128 * KIB } },
    { method: 'GET', path: '/api/bridge/install.sh', row: '/bridge/install.sh', kind: 'route', expect: { timeoutMs: 600000 } },
    { method: 'GET', path: '/api/bridge/runtime/neurocenter-asset-sync-linux-x64-1.2.3.tgz', row: '/bridge/runtime/:file', kind: 'route', expect: { timeoutMs: 600000, maxResponseBytes: GIB } },
    { method: 'POST', path: '/api/mcp-host/connect', row: '/mcp-host/connect', kind: 'route', expect: { timeoutMs: 15000, maxBodyBytes: 4 * MIB } },
];

test('AD-6: special-forward бюджеты = shared-константы (guard чистого переноса)', () => {
    for (const item of INVENTORY) {
        const row = matchPolicy(item.method, item.path);
        const label = `${item.method} ${item.path}`;
        assert.equal(row.path, item.row, `${label}: matchPolicy вернул строку ${row.path}, ожидаемо ${item.row}`);
        const kind = item.kind || 'proxy';
        assert.equal(row.kind, kind, `${label}: строка ${row.path} имеет kind ${row.kind}, ожидаемо ${kind}`);
        for (const [field, value] of Object.entries(item.expect)) {
            assert.equal(row[field], value, `${label}: ${row.path}.${field} = ${row[field]}, ожидаемо ${value}`);
        }
    }
});

test('AD-6: default-строка конечна и ловит всё некатегоризованное /api/*', () => {
    assert.ok(
        Number.isFinite(CATCH_ALL_ROW.maxResponseBytes) && CATCH_ALL_ROW.maxResponseBytes > 0,
        'AD-6: default maxResponseBytes обязан быть конечным положительным числом',
    );
    assert.equal(CATCH_ALL_ROW.path, CATCH_ALL_PATH);
    assert.equal(matchPolicy('GET', '/api/other-route'), CATCH_ALL_ROW);
    assert.equal(matchPolicy('POST', '/api/feature-flags/probe'), CATCH_ALL_ROW);
    assert.equal(matchPolicy('DELETE', '/api/projects/project-1/anything'), CATCH_ALL_ROW);
});

/** Последний аргумент вызова `fnName(...)` — со скобочным балансом, строками и комментариями. */
function lastCallArgs(source, fnName) {
    const results = [];
    const open = new RegExp('\\b' + fnName + '\\s*\\(', 'g');
    let match;
    while ((match = open.exec(source))) {
        let depth = 0,
            j = match.index + match[0].length - 1,
            inString = null,
            argStart = j + 1;
        for (; j < source.length; j++) {
            const ch = source[j];
            if (inString) {
                if (ch === '\\') j++;
                else if (ch === inString) inString = null;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') {
                inString = ch;
                continue;
            }
            if (ch === '/' && source[j + 1] === '/') {
                while (j < source.length && source[j] !== '\n') j++;
                continue;
            }
            if (ch === '/' && source[j + 1] === '*') {
                j += 2;
                while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
                j++;
                continue;
            }
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                if (depth === 0) break;
            } else if (ch === ',' && depth === 1) {
                argStart = j + 1;
            }
        }
        if (depth !== 0) continue;
        const arg = source.slice(argStart, j).trim();
        if (arg) results.push(arg);
    }
    return results;
}

const literalBudget = (value) => /^[0-9"'`I]/.test(value);

test('AD-6: static-скан src/proxy/*.ts — литеральные бюджеты запрещены', async () => {
    const proxyDir = path.join(repoRoot, 'services/api-gateway/src/proxy');
    const files = (await fs.readdir(proxyDir)).filter((file) => file.endsWith('.ts') && file !== 'route-policy.ts');
    assert.ok(files.length > 0, 'src/proxy/*.ts не найден — структура изменилась');
    for (const file of files) {
        const source = await fs.readFile(path.join(proxyDir, file), 'utf8');
        assert.ok(!source.includes('Infinity'), `${file}: Infinity запрещён (AD-6: бюджеты только из таблицы)`);
        for (const [index, line] of source.split('\n').entries()) {
            const found = /\b(timeout|maxContentLength|maxBodyLength|limit)\s*:\s*([^\s,})\]]*)/.exec(line);
            if (found && literalBudget(found[2])) {
                assert.fail(`${file}:${index + 1}: бюджет "${found[1]}" обязан читаться из route-policy, ` +
                    `а не литералом: "${line.trim()}"`);
            }
        }
        for (const deadline of lastCallArgs(source, 'setTimeout')) {
            assert.ok(
                !literalBudget(deadline),
                `${file}: деадлайн setTimeout обязан читаться из route-policy, а не литералом: "${deadline}"`,
            );
        }
    }
});
