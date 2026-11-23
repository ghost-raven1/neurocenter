/**
 * 6.6 (AD-O1/O2): тесты единого лог-схема и correlation id.
 *
 * node --test scripts/test/logging.test.mjs
 *
 * Покрывает:
 * - logging.cjs: схема строки (ts RFC3339 / level / service / requestId / msg),
 *   маркер 'background', err-allowlist AD-O8 (без message), скалярные поля, child().
 * - request-context.cjs: UUID4-генерация, валидация формата, middleware
 *   (honor / regenerate / invalid), requestContextHeaders(), injectRequestContext()
 *   и internalFetch (пропагация заголовка через глобальный fetch).
 * - drift: console.(log|error|warn|info) в src всех сервисов = 0 (allowlist + strip комментов).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createLogger, BACKGROUND_REQUEST_ID } = await import(
    path.join(root, 'services', 'shared', 'logging.cjs')
);
const {
    createRequestContextMiddleware,
    getRequestId,
    injectRequestContext,
    internalFetch,
    isRequestId,
    newRequestId,
    requestContextHeaders,
    withRequestContext,
} = await import(path.join(root, 'services', 'shared', 'request-context.cjs'));

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Логгер, пишущий строки в массив (write резолвится в конструкторе — перехват работает). */
function captureLogger(service, options = {}) {
    const lines = [];
    const logger = createLogger(service, { write: (line) => lines.push(line), ...options });
    return { lines, logger };
}

test('logging: схема строки — ts RFC3339 UTC, level, service, requestId, msg', () => {
    const { lines, logger } = captureLogger('catalog-service', { now: () => '2026-11-23T08:15:30.123Z' });
    logger.info('привет', { status: 200, ok: true, ratio: 0.5 });
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.match(line.ts, RFC3339);
    assert.equal(line.ts, '2026-11-23T08:15:30.123Z');
    assert.equal(line.level, 'info');
    assert.equal(line.service, 'catalog-service');
    assert.equal(line.msg, 'привет');
    assert.equal(line.status, 200);
    assert.equal(line.ok, true);
    assert.equal(line.ratio, 0.5);
    assert.equal(line.requestId, BACKGROUND_REQUEST_ID);
    assert.ok(BACKGROUND_REQUEST_ID, 'маркер background должен быть непустым');
});

test('logging: msg приводится к строке', () => {
    const { lines, logger } = captureLogger('s');
    logger.warn(42);
    assert.equal(JSON.parse(lines[0]).msg, '42');
});

test('logging: вне контекста requestId === "background" (поле никогда не отсутствует)', () => {
    const { lines, logger } = captureLogger('s');
    logger.error('x');
    const line = JSON.parse(lines[0]);
    assert.equal(line.requestId, 'background');
    assert.ok('requestId' in line);
});

test('logging: err — только allowlist AD-O8 (name/code/causeCode), message не уходит', () => {
    const { lines, logger } = captureLogger('s');
    const cause = Object.assign(new Error('deep'), { code: 'ECONNREFUSED' });
    const err = Object.assign(new TypeError('тайный текст'), { code: 'ERR_BAD_GATEWAY', cause });
    logger.error('упало', { err });
    const line = JSON.parse(lines[0]);
    assert.deepEqual(line.err, { name: 'TypeError', code: 'ERR_BAD_GATEWAY', causeCode: 'ECONNREFUSED' });
    assert.ok(!JSON.stringify(line).includes('тайный текст'));
    assert.ok(!JSON.stringify(line).includes('deep'));
});

test('logging: err без code/cause — только name; не-Error объект и примитив', () => {
    const { lines, logger } = captureLogger('s');
    logger.error('a', { err: new Error('plain') });
    assert.deepEqual(JSON.parse(lines[0]).err, { name: 'Error' });
    logger.error('b', { err: { name: 'AxiosError', code: 502 } });
    assert.deepEqual(JSON.parse(lines[1]).err, { name: 'AxiosError', code: '502' });
    logger.error('c', { err: 'network down' });
    assert.deepEqual(JSON.parse(lines[2]).err, { name: 'Error' });
});

test('logging: err: null — поле err отсутствует', () => {
    const { lines, logger } = captureLogger('s');
    logger.info('ok', { err: null });
    assert.ok(!('err' in JSON.parse(lines[0])));
});

test('logging: нескалярное поле — TypeError; зарезервированные ключи не переопределяются', () => {
    const { lines, logger } = captureLogger('s');
    assert.throws(() => logger.info('x', { body: { nested: true } }), TypeError);
    assert.throws(() => logger.info('x', { status: Infinity }), TypeError);
    assert.equal(lines.length, 0, 'брошенная строка в лог не пишется');
    logger.info('x', { level: 'debug', extra: 1 });
    const line = JSON.parse(lines[0]);
    assert.equal(line.level, 'info');
    assert.equal(line.extra, 1);
});

test('logging: child() — фиксированные bindings, наследование и проверка', () => {
    const { lines, logger } = captureLogger('s');
    const child = logger.child({ scope: 'db' });
    child.info('строка');
    const line = JSON.parse(lines[0]);
    assert.equal(line.scope, 'db');
    assert.throws(() => logger.child({ level: 'info' }), TypeError);
    assert.throws(() => logger.child({ scope: [1] }), TypeError);
    // field-значение переопределяет binding на уровне вызова
    child.info('строка', { scope: 'rag' });
    assert.equal(JSON.parse(lines[1]).scope, 'rag');
});

test('logging: createLogger требует непустое имя сервиса', () => {
    assert.throws(() => createLogger(''), TypeError);
    assert.throws(() => createLogger(undefined), TypeError);
});

test('request-context: newRequestId — UUID4; isRequestId — допустимые форматы', () => {
    for (let i = 0; i < 50; i++) assert.match(newRequestId(), UUID4);
    assert.ok(isRequestId(newRequestId()));
    assert.ok(isRequestId('6a2c1f0e9d8b7c6a5f4e3d2c1b0a9f8e'), 'nginx $request_id (hex) проходит');
    assert.ok(isRequestId('job-catalog-rebuild'), 'job-имена проходят');
    assert.ok(isRequestId('job-chat-' + newRequestId()));
    assert.ok(!isRequestId(''));
    assert.ok(!isRequestId('a'), 'минимум 2 символа');
    assert.ok(!isRequestId('x'.repeat(129)), 'максимум 128');
    assert.ok(isRequestId('x'.repeat(128)));
    assert.ok(!isRequestId('bad id'), 'пробел');
    assert.ok(!isRequestId('id!'));
    assert.ok(!isRequestId('_leading'));
    assert.ok(!isRequestId(42));
});

test('request-context: withRequestContext — jobId в контекст, невалидный id — TypeError', async () => {
    await withRequestContext('job-skills-outbox', async () => {
        assert.equal(getRequestId(), 'job-skills-outbox');
        assert.equal(requestContextHeaders()['x-request-id'], 'job-skills-outbox');
    });
    assert.equal(getRequestId(), undefined);
    assert.throws(() => withRequestContext('BAD ID', () => {}), TypeError);
});

function expressLikeMiddlewareRun(mw, headers) {
    const req = { headers };
    const setHeaders = {};
    const res = { setHeader: (k, v) => (setHeaders[k] = v) };
    let nextStore;
    const next = () => {
        nextStore = { headers: setHeaders, requestId: getRequestId() };
    };
    mw(req, res, next);
    return nextStore;
}

test('middleware: валидный входящий X-Request-ID уважается (nginx $request_id)', () => {
    const mw = createRequestContextMiddleware();
    const nginx = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const ctx = expressLikeMiddlewareRun(mw, { 'x-request-id': nginx });
    assert.equal(ctx.headers['x-request-id'], nginx);
    assert.equal(ctx.requestId, nginx);
});

test('middleware: без заголовка — UUID4, ответный заголовок совпадает с контекстом', () => {
    const mw = createRequestContextMiddleware();
    const ctx = expressLikeMiddlewareRun(mw, {});
    assert.match(ctx.headers['x-request-id'], UUID4);
    assert.equal(ctx.requestId, ctx.headers['x-request-id']);
});

test('middleware: невалидный заголовок — регенерация UUID4 (защита от спуфинга)', () => {
    const mw = createRequestContextMiddleware();
    const ctx = expressLikeMiddlewareRun(mw, { 'x-request-id': 'evil id!!\r\n' });
    assert.match(ctx.headers['x-request-id'], UUID4);
    assert.equal(ctx.requestId, ctx.headers['x-request-id']);
});

test('middleware: кастомный generateId (детерминированные тесты сервисов)', () => {
    const mw = createRequestContextMiddleware({ generateId: () => 'fixed-id-123' });
    const ctx = expressLikeMiddlewareRun(mw, {});
    assert.equal(ctx.headers['x-request-id'], 'fixed-id-123');
    assert.equal(ctx.requestId, 'fixed-id-123');
});

test('requestContextHeaders: контекст → его id; вне контекста → новый UUID4 (всегда присутствует)', () => {
    assert.match(requestContextHeaders()['x-request-id'], UUID4);
    withRequestContext('job-asset-self-heal', () => {
        assert.deepEqual(requestContextHeaders(), { 'x-request-id': 'job-asset-self-heal' });
    });
});

test('injectRequestContext: подставляет X-Request-ID и сохраняет остальные headers', async () => {
    const calls = [];
    const stub = async (url, init) => {
        calls.push({ url, init });
        return new Response('ok');
    };
    const fetchWith = injectRequestContext(stub);

    const headerOf = (init) => new Headers(init.headers).get('x-request-id');

    await withRequestContext('job-chat-abc', () => fetchWith('http://svc/x', { headers: { 'content-type': 'application/json' } }));
    assert.equal(headerOf(calls[0].init), 'job-chat-abc');
    assert.equal(new Headers(calls[0].init.headers).get('content-type'), 'application/json');
    assert.equal(calls[0].url, 'http://svc/x');
    // plain-объект остаётся plain-объектом (контейнер не меняется)
    assert.ok(!(calls[0].init.headers instanceof Headers));
    assert.equal(calls[0].init.headers['content-type'], 'application/json');

    await fetchWith('http://svc/y');
    assert.match(headerOf(calls[1].init), UUID4);

    // Headers-контейнер нормализуется, чужой заголовок перекрывается
    await fetchWith('http://svc/h', { headers: new Headers({ 'x-request-id': 'forged' }) });
    assert.ok(calls[2].init.headers instanceof Headers);
    assert.notEqual(headerOf(calls[2].init), 'forged');

    // существующий заголовок в plain-объекте перекрывается контекстом (анти-спуфинг)
    await withRequestContext('job-catalog-rebuild', () =>
        fetchWith('http://svc/z', { headers: { 'x-request-id': 'forged' } }),
    );
    assert.equal(headerOf(calls[3].init), 'job-catalog-rebuild');
});

test('internalFetch: обёртка глобального fetch (заголовок передаётся реальному fetch)', async () => {
    const original = globalThis.fetch;
    let received;
    globalThis.fetch = async (url, init) => {
        received = { url, headers: init.headers };
        return new Response('ok');
    };
    try {
        await withRequestContext('job-asset-self-heal', () => internalFetch('http://catalog/x'));
        assert.equal(received.url, 'http://catalog/x');
        assert.equal(new Headers(received.headers).get('x-request-id'), 'job-asset-self-heal');
        await internalFetch('http://catalog/y');
        assert.match(new Headers(received.headers).get('x-request-id'), UUID4);
    } finally {
        globalThis.fetch = original;
    }
});

test('drift: console.(log|error|warn|info) в services/*/src = 0 (allowlist + strip комментов)', async function _test() {
    const servicesDir = path.join(root, 'services');
    const services = await readdir(servicesDir);
    let checked = 0;
    const offenders = [];
    const pattern = /console\.(?:log|error|warn|info)\(/;
    for (const svc of services) {
        const srcDir = path.join(servicesDir, svc, 'src');
        const st = await stat(srcDir).catch(() => null);
        if (!st || !st.isDirectory()) continue;
        for await (const file of walkTs(srcDir)) {
            const name = path.basename(file);
            const rel = path.relative(root, file);
            if (
                name.endsWith('.cli.ts') ||
                name.endsWith('.test.ts') ||
                name.endsWith('.spec.ts') ||
                rel.split(path.sep).includes('tests')
            )
                continue;
            checked += 1;
            const source = await readFile(file, 'utf8');
            const stripped = stripComments(source);
            const lines = stripped.split('\n');
            lines.forEach((line, i) => {
                if (pattern.test(line)) offenders.push(`${rel}:${i + 1}`);
            });
        }
    }
    assert.ok(checked > 100, `проверено файлов: ${checked} — подозрительно мало`);
    assert.deepEqual(offenders, [], `console.* в src (вне allowlist): ${offenders.join(', ')}`);
});

async function* walkTs(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkTs(full);
        else if (entry.name.endsWith('.ts')) yield full;
    }
}

/** Удаляет блок-комментарии и //-комментарии (кроме :// в URL), чтобы комментарии не считались drift. */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(?<!:)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}
