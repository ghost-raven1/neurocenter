/**
 * AD-O5 (res-obs 6.10): error visibility — shared crash-политика, file outbox
 * и SQL-функции error-store.
 *
 *  - buildStackHint: кадры + имена, без error.message, top-20, trunc 4 KB;
 *  - installCrashHandler: log → error-store (best-effort) → process.exit(1)
 *    всегда; timeout 2 s на зависший reportError; re-entrancy guard;
 *  - ErrorOutbox/deliverErrorEvents: доставка в catalog POST /internal/error-events,
 *    retry после «kill catalog», батчи ≤200;
 *  - insertErrorEvent/listErrorEvents: идемпотентность по id, фильтры, пагинация;
 *  - retention: error_events — 90d, batched-prune по ts.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const shared = (name) => require(path.join(root, 'services/shared', name));

const { buildStackHint, installCrashHandler } = shared('crash-handler.cjs');
const { ErrorOutbox, deliverErrorEvents } = shared('error-outbox.cjs');
const { withRequestContext } = shared('request-context.cjs');
const {
    buildRetentionPlan,
    pruneStatements,
    RETENTION_BATCH_LIMIT,
    MAINTENANCE_PRUNE_LOCATION,
} = await import('../production/retention-prune.mjs');
const { readFile } = await import('node:fs/promises');
const retentionResources = JSON.parse(await readFile(path.join(root, 'deploy/production/retention.json'), 'utf8'))
    .resources;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function errorWithStack(message, frames) {
    const error = new Error(message);
    error.stack = 'Error: ' + message + '\n' + frames.map((frame) => '    at ' + frame).join('\n');
    return error;
}

test('buildStackHint: кадры + имя/код ошибки, без первой строки (error.message)', () => {
    const error = errorWithStack('secret payload', ['outer() at app.js:10:5', 'inner() at lib.js:20:9']);
    const hint = buildStackHint(error);
    assert.ok(hint.startsWith('Error'), 'head — имя ошибки');
    assert.ok(hint.includes('outer() at app.js:10:5'));
    assert.ok(hint.includes('inner() at lib.js:20:9'));
    assert.ok(!hint.includes('secret payload'), 'error.message не уходит в hint');
});

test('buildStackHint: code-поле в head, top-20 кадров', () => {
    const error = new Error('boom');
    error.code = 'ENOENT';
    error.stack = 'Error: boom\n' + Array.from({ length: 30 }, (_, i) => `    at f${i}() at x.js:${i}:1`).join('\n');
    const hint = buildStackHint(error);
    assert.ok(hint.startsWith('Error (code=ENOENT)'));
    assert.ok(hint.includes('f0() at x.js:0:1'));
    assert.ok(hint.includes('f19() at x.js:19:1'));
    assert.ok(!hint.includes('f20() at x.js:20:1'), 'только top-20 кадров');
});

test('buildStackHint: trunc 4 KB с пометкой', () => {
    const frames = Array.from({ length: 20 }, (_, i) => `at frame_${'x'.repeat(300)}_${i}() at ${'y'.repeat(60)}.js:${i}:1`);
    const hint = buildStackHint(errorWithStack('long', frames));
    assert.ok(Buffer.byteLength(hint, 'utf8') <= 4096 + 20, 'hint не превышает 4 KB + пометка');
    assert.ok(hint.endsWith('…[truncated]'));
});

test('buildStackHint: не-Error причина — строка без раскрытия значений', () => {
    assert.equal(buildStackHint('plain reason'), 'Error: plain reason');
    assert.equal(buildStackHint(undefined), 'Error: unknown');
});

/**
 * Crash-прогон в дочернем процессе: installCrashHandler на реальном process,
 * реальный emit uncaughtException/unhandledRejection. Сторонние эффекты — в
 * sink-файл (строки "имя\tJSON"). stubExit=true → process.exit лишь фиксируется
 * (процесс живёт до конца сценария); false → реальный exit(1).
 */
import { spawnSync } from 'node:child_process';

function runCrashScenario({ body, stubExit = true, exitDelayMs = 400 }) {
    const sink = path.join(tmpdir(), 'nc-crash-sink-' + Math.random().toString(16).slice(2) + '.txt');
    const script = `
        const fs = require('node:fs');
        const { installCrashHandler } = require(${JSON.stringify(path.join(root, 'services/shared/crash-handler.cjs'))});
        const { withRequestContext } = require(${JSON.stringify(path.join(root, 'services/shared/request-context.cjs'))});
        const sink = ${JSON.stringify(sink)};
        const record = (name, value) => fs.appendFileSync(sink, name + '\\t' + JSON.stringify(value) + '\\n');
        ${stubExit ? 'const realExit = process.exit; process.exit = (code) => record("exit", code);' : ''}
        const dispose = installCrashHandler({
            service: 'api-gateway',
            log: { error: (msg, fields) => record('log', { msg, errName: fields && fields.err ? fields.err.name : null, errStackHead: fields && fields.err && typeof fields.err.stack === 'string' ? String(fields.err.stack).slice(0, 40) : null }) },
            reportError: (event) => { record('report', event); return (${body.reportError}()); },
            record: (level) => record('metric', level),
        });
        global.withRequestContext = withRequestContext;
        (${body.trigger})();
        setTimeout(() => {
            record('done', dispose ? 'alive' : 'dead');
            ${stubExit ? 'process.exit = realExit;' : ''}
            process.exit(0);
        }, ${exitDelayMs});
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    return { result, sink };
}

async function readSink(sink) {
    const lines = (await readFile(sink, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    return lines.map((line) => {
        const tab = line.indexOf('\t');
        return [line.slice(0, tab), JSON.parse(line.slice(tab + 1))];
    });
}

test('crash: uncaughtException → log (safe) → reportError (critical) → exit(1)', async (t) => {
    const errorBody = `crashPoint() at app.js:7:3`;
    const { result, sink } = runCrashScenario({
        stubExit: true,
        body: {
            reportError: 'Promise.resolve',
            trigger: `() => { const err = new Error('must not appear'); err.stack = 'Error: must not appear\\n    at crashPoint() at app.js:7:3'; process.emit('uncaughtException', err) }`,
        },
    });
    t.after(async () => {
        await rm(sink, { force: true });
    });
    assert.equal(result.status, 0, 'сценарий завершён; ' + (result.stderr || ''));
    const sinkRows = await readSink(sink);
    const names = sinkRows.map(([name]) => name);
    assert.ok(names.indexOf('log') < names.indexOf('report'), 'сначала лог, потом error-store');
    assert.ok(names.indexOf('report') < names.indexOf('exit'), 'потом exit');
    const logRow = sinkRows.find(([name]) => name === 'log')[1];
    assert.equal(logRow.msg, 'crash.uncaughtException', 'фиксированный классификатор');
    assert.equal(logRow.errName, 'Error');
    const event = sinkRows.find(([name]) => name === 'report')[1];
    assert.match(event.id, UUID_RE);
    assert.equal(event.service, 'api-gateway');
    assert.equal(event.level, 'critical');
    assert.equal(event.requestId, null, 'вне контекста — null');
    assert.equal(event.message, 'crash.uncaughtException');
    assert.ok(event.stackHint.includes('crashPoint() at app.js:7:3'));
    assert.ok(!event.stackHint.includes('must not appear'), 'error.message не уходит');
    assert.deepEqual(sinkRows.filter(([name]) => name === 'exit').map(([, value]) => value), [1]);
});

test('crash: unhandledRejection + requestId из контекста + record-метрика', async (t) => {
    const { result, sink } = runCrashScenario({
        stubExit: true,
        body: {
            reportError: 'Promise.resolve',
            trigger: `async () => { await withRequestContext('req-123', async () => { process.emit('unhandledRejection', new TypeError('bad')) }) }`,
        },
    });
    t.after(async () => {
        await rm(sink, { force: true });
    });
    assert.equal(result.status, 0, (result.stderr || ''));
    const sinkRows = await readSink(sink);
    const event = sinkRows.find(([name]) => name === 'report')[1];
    assert.equal(event.message, 'crash.unhandledRejection');
    assert.equal(event.level, 'critical');
    assert.equal(event.requestId, 'req-123');
    assert.deepEqual(sinkRows.filter(([name]) => name === 'metric').map(([, value]) => value), ['critical']);
});

test('crash: повторный crash во время обработки — немедленный exit без вложенного report', async (t) => {
    const { result, sink } = runCrashScenario({
        stubExit: true,
        body: {
            reportError: 'Promise.resolve',
            trigger: `() => { process.emit('uncaughtException', new Error('first')); process.emit('uncaughtException', new Error('second')) }`,
        },
    });
    t.after(async () => {
        await rm(sink, { force: true });
    });
    assert.equal(result.status, 0, (result.stderr || ''));
    const sinkRows = await readSink(sink);
    assert.equal(sinkRows.filter(([name]) => name === 'report').length, 1, 'вложенный report не выполняется');
    assert.deepEqual(sinkRows.filter(([name]) => name === 'exit').length, 2, 'первый exit по завершению, второй — немедленный');
});

test('crash: зависший reportError не блокирует exit дольше 2 s', async (t) => {
    const { result, sink } = runCrashScenario({
        stubExit: true,
        exitDelayMs: 4000,
        body: {
            reportError: '() => new Promise(() => undefined)', // завис навсегда
            trigger: `() => { process.emit('uncaughtException', new Error('hang')) }`,
        },
    });
    t.after(async () => {
        await rm(sink, { force: true });
    });
    const sinkRows = await readSink(sink);
    const exits = sinkRows.filter(([name]) => name === 'exit');
    assert.ok(exits.length >= 1, 'exit произошёл');
    assert.equal(result.status, 0, (result.stderr || ''));
});

test('crash: реальный exit(1) — процесс завершается кодом 1, запись в error-store выполнена', async (t) => {
    const { result, sink } = runCrashScenario({
        stubExit: false,
        body: {
            reportError: 'Promise.resolve',
            trigger: `() => { process.emit('uncaughtException', new Error('fatal')) }`,
        },
    });
    t.after(async () => {
        await rm(sink, { force: true });
    });
    assert.equal(result.status, 1, '«catch и continue» запрещено: процесс завершается кодом 1');
    const sinkRows = await readSink(sink);
    assert.ok(sinkRows.some(([name, value]) => name === 'report' && value.message === 'crash.uncaughtException'));
    assert.ok(sinkRows.some(([name, value]) => name === 'log' && value.msg === 'crash.uncaughtException'));
    assert.ok(!sinkRows.some(([name]) => name === 'done'), 'процесс не дожил до завершения сценария');
});

test('crash: валидация параметров installCrashHandler', (t) => {
    const log = { error: () => undefined };
    assert.throws(() => installCrashHandler({ service: '', log, reportError: () => undefined }), TypeError);
    assert.throws(() => installCrashHandler({ service: 'x', log: {}, reportError: () => undefined }), TypeError);
    assert.throws(() => installCrashHandler({ service: 'x', log, reportError: 'nope' }), TypeError);
});

// ---------- ErrorOutbox / deliverErrorEvents ----------

const TOKEN = 'test-internal-token';
let serverMode = 'ok';
const receivedEvents = [];
let server;

async function waitFor(cond, timeoutMs = 5000) {
    const start = Date.now();
    for (;;) {
        if (await cond()) return;
        if (Date.now() - start > timeoutMs) throw new Error('timeout: ожидаемое состояние не наступило');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

test('error-outbox: доставка, retry после down-каталога, pending/stop', async (t) => {
    server = http.createServer((req, res) => {
        if (req.url === '/internal/error-events' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                if (req.headers['x-neurocenter-internal'] !== TOKEN) {
                    res.statusCode = 403;
                    res.end();
                    return;
                }
                if (serverMode === 'fail') {
                    res.statusCode = 500;
                    res.end('down');
                    return;
                }
                const data = JSON.parse(body);
                receivedEvents.push(data.events);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ received: data.events.length }));
            });
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = server.address().port;
    const previousUrl = process.env.CATALOG_SERVICE_URL;
    const previousToken = process.env.NEUROCENTER_INTERNAL_TOKEN;
    process.env.CATALOG_SERVICE_URL = `http://127.0.0.1:${port}`;
    process.env.NEUROCENTER_INTERNAL_TOKEN = TOKEN;
    const dir = await mkdtemp(path.join(tmpdir(), 'nc-error-outbox-'));
    t.after(async () => {
        process.env.CATALOG_SERVICE_URL = previousUrl;
        process.env.NEUROCENTER_INTERNAL_TOKEN = previousToken;
        await new Promise((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
    });

    const outbox = new ErrorOutbox(dir, deliverErrorEvents, { intervalMs: 30 });
    await outbox.start();
    // 1) доставка с токеном, файл удаляется после подтверждения.
    await outbox.append([
        { service: 'api-gateway', level: 'error', message: 'explicit.report', requestId: 'req-1', stackHint: null },
    ]);
    await waitFor(() => receivedEvents.length === 1);
    assert.equal(receivedEvents[0][0].service, 'api-gateway');
    assert.match(receivedEvents[0][0].id, UUID_RE, 'id прилагается автоматически');
    await waitFor(async () => (await outbox.pending()) === false);
    // 2) «kill catalog» (500): файл остаётся, после восстановления — retry без дубля.
    serverMode = 'fail';
    await outbox.append([
        { service: 'api-gateway', level: 'critical', message: 'crash.uncaughtException', requestId: null, stackHint: 'hint' },
    ]);
    await outbox.tryFlush();
    assert.equal(await outbox.pending(), true, 'событие ждёт доставки');
    assert.equal(receivedEvents.length, 1);
    serverMode = 'ok';
    await waitFor(() => receivedEvents.length === 2);
    await waitFor(async () => (await outbox.pending()) === false);
    assert.equal(receivedEvents[1][0].message, 'crash.uncaughtException');
    assert.equal(receivedEvents[1][0].level, 'critical');
    await outbox.stop();
});

test('deliverErrorEvents: батчи ≤200, валидация env', async (t) => {
    const previousUrl = process.env.CATALOG_SERVICE_URL;
    const previousToken = process.env.NEUROCENTER_INTERNAL_TOKEN;
    t.after(() => {
        process.env.CATALOG_SERVICE_URL = previousUrl;
        process.env.NEUROCENTER_INTERNAL_TOKEN = previousToken;
    });
    process.env.CATALOG_SERVICE_URL = 'http://127.0.0.1:1';
    process.env.NEUROCENTER_INTERNAL_TOKEN = TOKEN;
    await assert.rejects(
        () => deliverErrorEvents([{ service: 'x', level: 'error', message: 'm' }]),
        /Каталог не подтвердил|Некорректно/,
        'недоступный каталог — ошибка для retry',
    );
    delete process.env.NEUROCENTER_INTERNAL_TOKEN;
    await assert.rejects(
        () => deliverErrorEvents([{ service: 'x', level: 'error', message: 'm' }]),
        /NEUROCENTER_INTERNAL_TOKEN/,
    );
    process.env.CATALOG_SERVICE_URL = 'ftp://bad';
    process.env.NEUROCENTER_INTERNAL_TOKEN = TOKEN;
    await assert.rejects(() => deliverErrorEvents([{ service: 'x', level: 'error', message: 'm' }]), /Некорректно/);
    await assert.doesNotReject(() => deliverErrorEvents([]));
});

// ---------- SQL-функции error-store (fake pool) ----------

test('insertErrorEvent: ON CONFLICT (id) DO NOTHING, ts=now(), валидация UUID', async () => {
    const { insertErrorEvent } = await import(path.join(root, 'services/catalog-service/src/errors/error-events.ts'));
    const calls = [];
    const client = {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return { rows: [] };
        },
    };
    await insertErrorEvent(client, {
        id: 'AABBCCDD-1111-2222-3333-444455556666',
        service: 'oauth2-bridge',
        level: 'critical',
        message: 'crash.uncaughtException',
        requestId: 'req-9',
        stackHint: 'hint',
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].sql.includes('INSERT INTO error_events(id,service,ts,level,request_id,message,stack_hint)'));
    assert.ok(calls[0].sql.includes('now()'), 'ts — серверное время приёма');
    assert.ok(calls[0].sql.includes('ON CONFLICT (id) DO NOTHING'), 'повторная доставка не дублирует');
    assert.equal(calls[0].params[0], 'aabbccdd-1111-2222-3333-444455556666', 'UUID нормализуется в нижний регистр');
    // некорректный id → генерация нового, без броска.
    await insertErrorEvent(client, {
        id: 'not-a-uuid',
        service: 'skills-service',
        level: 'error',
        message: 'explicit.report',
    });
    assert.match(calls[1].params[0], UUID_RE);
});

test('listErrorEvents: фильтры service/requestId/level/since, ORDER BY ts DESC, id DESC, пагинация', async () => {
    const { listErrorEvents } = await import(path.join(root, 'services/catalog-service/src/errors/error-events.ts'));
    const calls = [];
    const pool = {
        query: async (sql, params = []) => {
            calls.push({ sql, params });
            if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: 42 }] };
            return { rows: [{ id: 'e-1', service: 'api-gateway', ts: '2026-11-23T00:00:00Z', level: 'error', requestId: null, message: 'crash.uncaughtException', stackHint: null }] };
        },
    };
    const since = new Date('2026-11-01T00:00:00Z');
    const page = await listErrorEvents(pool, {
        service: 'api-gateway',
        requestId: 'req-1',
        level: 'error',
        since,
        page: 3,
        size: 10,
    });
    assert.equal(page.total, 42);
    assert.equal(page.page, 3);
    assert.equal(page.size, 10);
    assert.equal(page.items[0].message, 'crash.uncaughtException');
    const listCall = calls.find((call) => call.sql.startsWith('SELECT id,service,ts'));
    assert.ok(listCall.sql.includes('WHERE service = $1 AND request_id = $2 AND level = $3 AND ts >= $4'));
    assert.ok(listCall.sql.includes('ORDER BY ts DESC, id DESC'));
    assert.deepEqual(listCall.params.slice(-2), [10, 20], 'LIMIT/OFFSET: page 3, size 10');
    // без фильтров — WHERE отсутствует.
    await listErrorEvents(pool, { page: 1, size: 20 });
    const bare = calls[calls.length - 1];
    assert.ok(!bare.sql.includes('WHERE'));
});

// ---------- retention: error_events 90d ----------

test('retention: error_events — 90d по ts, batched-prune, FK-порядок', () => {
    const plan = buildRetentionPlan(retentionResources);
    const entry = plan.catalog.find((item) => item.table === 'error_events');
    assert.ok(entry, 'error_events в плане maintenance-тика');
    assert.equal(entry.interval, '90 days');
    assert.equal(entry.column, 'ts');
    const [statement] = pruneStatements(entry);
    assert.ok(
        statement.includes("DELETE FROM error_events WHERE ts < now() - interval '90 days'"),
        'fixture >90d снимается по ts',
    );
    assert.ok(statement.includes(`LIMIT ${RETENTION_BATCH_LIMIT}`));
    assert.ok(statement.endsWith('RETURNING 1) SELECT count(*) FROM deleted;'));
    // error_events не имеет входящих FK — гард не требуется; место в FK-порядке зафиксировано.
    const order = JSON.stringify(plan.catalog.map((item) => item.table));
    assert.ok(order.includes('security_events') && order.includes('error_events'));
    assert.equal(entry.resource, 'error_events');
    const retentionEntry = retentionResources.find((item) => item.resource === 'error_events');
    assert.equal(retentionEntry.pruneLocation, MAINTENANCE_PRUNE_LOCATION);
});
