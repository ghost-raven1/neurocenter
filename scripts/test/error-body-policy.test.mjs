import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';

/**
 * AD-19 (entry 10): error-body-политика — фиксированные сообщения + нормализация proxy.
 * Матрица плана: PASSTHROUGH_GONE / UPSTREAM_5XX / DOMAIN_4XX / SDK_SPAWN /
 * STATIC_PASSTHROUGH / LOG_NO_SECRET / ALLOWLIST_DOC.
 * Требует свежих сборок: services/api-gateway npm run build,
 * mcp/neurocenter-asset-sync npm run build.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// AD-19 allowlist: единственные точки `message: error.message` во внешних body.
// Критерий: текст сформирован ДОМЕНОМ (shared/feature-client.cjs — имя фичи /
// фиксированное сообщение), а не транспортным exception (stack/hostname:port).
const PASSTHROUGH_ALLOWLIST = {
    'services/api-gateway/src/bridge/bridge.controller.ts': 'FeatureFlagError (feature-client.cjs)',
    'services/api-gateway/src/features/research-mcp/research-mcp.controller.ts': 'FeatureFlagError (feature-client.cjs)',
    'services/catalog-service/src/features/require-feature-enabled.ts': 'FeatureFlagError (feature-client.cjs)',
    'services/catalog-service/src/model-chat/chat-project-context.ts': 'FeatureFlagError (feature-client.cjs), 2 точки',
    'services/catalog-service/src/model-chat/chat-learning-context.ts': 'FeatureFlagError (feature-client.cjs)',
    'services/catalog-service/src/model-chat/chat-research-tools.ts': 'FeatureFlagError (feature-client.cjs)',
    'services/rag-sync-service/src/rag/rag-features.ts': 'FeatureFlagError (feature-client.cjs)',
    'services/skills-service/src/skills/feature-policy.guard.ts': 'FeatureFlagError (feature-client.cjs)',
};
// 1 + 1 + 1 + 2 + 1 + 1 + 1 + 1
const EXPECTED_PASSTHROUGH_MATCHES = 9;

/**
 * STATIC_PASSTHROUGH: grep-инвариант «no passthrough outside allowlist».
 * Доменные allowlist-тексты, не попадающие под grep-паттерн (failure.message-конструкторы,
 * интерполяция): source-client.ts (asset-source-client.cjs), gguf-import.capacity.ts
 * (capacity.cjs), installation-set.ts (данные пакета) — зафиксированы AD-19-комментариями.
 */
test('STATIC_PASSTHROUGH: passthrough error.message во внешних body — только allowlist', () => {
    const srcDirs = [
        ...fs.readdirSync(path.join(ROOT, 'services')).map((name) => path.join('services', name, 'src')),
        ...fs.readdirSync(path.join(ROOT, 'mcp')).map((name) => path.join('mcp', name, 'src')),
    ].filter((dir) => {
        try {
            return fs.statSync(path.join(ROOT, dir)).isDirectory();
        } catch {
            return false;
        }
    });
    let output = '';
    try {
        output = execFileSync(
            'grep',
            ['-rnE', 'message: *(error|err|e|failure)\\.message', ...srcDirs, '--include=*.ts'],
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 },
        );
    } catch (error) {
        if (error.status === 1) output = '';
        else throw error;
    }
    const lines = output.trim() ? output.trim().split('\n') : [];
    for (const line of lines) {
        const file = line.split(':')[0];
        assert.ok(
            Object.hasOwn(PASSTHROUGH_ALLOWLIST, file),
            `AD-19: passthrough error.message вне allowlist: ${line} (текст обязан быть фиксированным или из доменных данных)`,
        );
    }
    assert.equal(
        lines.length,
        EXPECTED_PASSTHROUGH_MATCHES,
        `Точек passthrough ${lines.length}, ожидается ${EXPECTED_PASSTHROUGH_MATCHES} — обновите AD-19-инвентарь`,
    );
});

const gatewayRequire = createRequire(path.join(ROOT, 'services/api-gateway/package.json'));
gatewayRequire('reflect-metadata');
const { ProxyService } = gatewayRequire('./dist/proxy/proxy.service.js');

const AUTH = {
    userId: 'u1',
    principalName: 'user',
    email: 'user@example.test',
    activeRole: 'Главный админ',
    policies: {},
    deviceId: undefined,
};

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

/** ProxyService со stub'ами DI; upstream — ответ http.request либо функция-бросатель. */
function makeService(upstream, auth = AUTH) {
    const configService = { get: () => undefined };
    const authGuard = { authenticate: async () => ({ ...auth }) };
    const live = { mutation() {}, bridge() {}, sections() {} };
    const service = new ProxyService(configService, authGuard, live);
    service.http = {
        post: async () => ({ status: 201, data: { allowed: true, claims: {} } }),
        request: typeof upstream === 'function' ? upstream : async () => upstream,
    };
    return service;
}

const reqFor = (method, p, body) => ({ method, path: p, headers: {}, query: {}, body, aborted: false });

async function withLogCapture(fn) {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
        await fn();
    } finally {
        console.error = original;
    }
    return lines;
}

test('UPSTREAM_5XX: upstream 5xx → статус сохранён, body фиксированный, детали — только в log', async () => {
    const internal = {
        statusCode: 500,
        message: 'connect ECONNREFUSED catalog-service:4100',
        error: 'Internal Server Error',
    };
    const service = makeService({ status: 500, headers: { 'content-type': 'application/json' }, data: internal });
    const res = makeRes();
    const logs = await withLogCapture(() => service.forward(reqFor('GET', '/api/projects'), res));
    assert.equal(res.statusCode, 500, 'статус upstream обязан сохраниться');
    assert.deepEqual(res.body, {
        code: 'upstream-error',
        message: 'Сервис временно недоступен. Повторите позже.',
    });
    assert.ok(!JSON.stringify(res.body).includes('catalog-service'), 'hostname:port не обязан уходить в body клиента');
    assert.ok(logs.some((line) => line.includes('catalog-service:4100')), 'hostname:port обязан остаться в server-логе');
});

test('DOMAIN_4XX: upstream 4xx с доменным текстом (allowlist) передаётся как есть', async () => {
    const domain = {
        statusCode: 409,
        message: 'Папка проекта изменилась. Повторите операцию с актуальным контекстом.',
        error: 'Conflict',
    };
    const service = makeService({ status: 409, headers: { 'content-type': 'application/json' }, data: domain });
    const res = makeRes();
    await withLogCapture(() => service.forward(reqFor('GET', '/api/projects/prj-1'), res));
    assert.equal(res.statusCode, 409, 'статус домена обязан сохраниться');
    assert.deepEqual(res.body, domain, 'доменный 4xx-текст обязан пройти без изменений');
});

test('PASSTHROUGH_GONE: axios ECONNREFUSED → 502 фикс, hostname:port только в log', async () => {
    const service = makeService(async () => {
        const error = new Error('connect ECONNREFUSED catalog-service:4100');
        error.code = 'ECONNREFUSED';
        throw error;
    });
    const res = makeRes();
    const logs = await withLogCapture(() => service.forward(reqFor('GET', '/api/projects'), res));
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, {
        code: 'upstream-unavailable',
        message: 'Сервис временно недоступен. Повторите позже.',
    });
    assert.ok(!JSON.stringify(res.body).includes('4100'), 'hostname:port не обязан уходить в body клиента');
    assert.ok(logs.some((line) => line.includes('catalog-service:4100')), 'hostname:port обязан остаться в server-логе');
});

test('OQ1: axios timeout → 504 фикс (client retry по 502/504 отсутствует)', async () => {
    const service = makeService(async () => {
        const error = new Error('timeout of 30000ms exceeded');
        error.code = 'ECONNABORTED';
        throw error;
    });
    const res = makeRes();
    await withLogCapture(() => service.forward(reqFor('GET', '/api/projects'), res));
    assert.equal(res.statusCode, 504);
    assert.deepEqual(res.body, {
        code: 'upstream-timeout',
        message: 'Сервис не ответил вовремя. Повторите позже.',
    });
});

test('device-channel: upstream 5xx → фиксированный body (секрет/детали не уходят)', async () => {
    const service = makeService(undefined, { ...AUTH, deviceId: 'device-1' });
    service.http.post = async () => ({
        status: 500,
        data: { message: 'pg: connection refused password=secret' },
    });
    const res = makeRes();
    const logs = await withLogCapture(() =>
        service.forward(reqFor('POST', '/api/device-channel/heartbeat', {}), res),
    );
    assert.equal(res.statusCode, 500, 'статус upstream обязан сохраниться');
    assert.deepEqual(res.body, {
        code: 'upstream-error',
        message: 'Сервис временно недоступен. Повторите позже.',
    });
    assert.ok(!JSON.stringify(res.body).includes('secret'), 'внутренние детали не обязаны уходить в body клиента');
    assert.ok(logs.some((line) => line.includes('device-channel')), 'инцидент обязан остаться в server-логе');
});

test('SDK_SPAWN: errMsg — инфраструктурные ошибки → фикс user-safe, доменный текст проходит', async () => {
    let stdio;
    try {
        stdio = await import(pathToFileURL(path.join(ROOT, 'mcp/neurocenter-asset-sync/dist/lib/stdio.js')).href);
    } catch (error) {
        throw new Error(
            'AD-19: dist mcp/neurocenter-asset-sync отсутствует — выполните npm run build в mcp/neurocenter-asset-sync',
            { cause: error },
        );
    }
    const { errMsg, infraErrorMessage } = stdio;
    const spawn = new Error('spawn opencode ENOENT');
    spawn.code = 'ENOENT';
    assert.equal(infraErrorMessage(spawn), 'Локальный исполняемый файл не найден. Обновите мост.');
    assert.equal(errMsg(spawn), 'Локальный исполняемый файл не найден. Обновите мост.');
    const missing = new Error("ENOENT: no such file or directory, open '/home/user/.local/bin/opencode'");
    missing.code = 'ENOENT';
    assert.equal(errMsg(missing), 'Файл или папка недоступны на этом компьютере. Проверьте доступ и повторите.');
    assert.ok(!errMsg(missing).includes('/home/user'), 'пути ФС не обязаны уходить в результат tool\'а');
    const refused = new Error('connect ECONNREFUSED catalog-service:4100');
    refused.code = 'ECONNREFUSED';
    assert.equal(errMsg(refused), 'Соединение с сервисом не установлено. Повторите позже.');
    const perm = new Error('spawn opencode EACCES');
    perm.code = 'EACCES';
    assert.equal(errMsg(perm), 'Недостаточно прав для этой операции. Проверьте права доступа и повторите.');
    // Доменные тексты (сформированы кодом моста) проходят без изменений.
    assert.equal(errMsg(new Error('Папка проекта недоступна.')), 'Папка проекта недоступна.');
    assert.equal(errMsg('Простой текст ошибки'), 'Простой текст ошибки');
    assert.equal(errMsg(null), 'неизвестная ошибка');
});
