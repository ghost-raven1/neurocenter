// RES-01 e2e-драйвер: unit-тесты чистого ядра (parse/evaluate) + --check на
// fixture HTTP-сервере (127.0.0.1, ephemeral-порт). НЕ live-зависимый.
//
//   node --test scripts/test/res-01-e2e.test.mjs
//
// Покрывает: parseArgs, parsePromQuery/evaluateScrape (вкл. known-defect ff:4400),
// parseReadyBody/evaluateHealth/healthSemanticsFromSource, correlationEvaluate,
// parseAlertsJsonl/evaluateAlerts, evaluateCheck, buildReport (exit-code) и
// --check / --blocks scrape на живом fixture-сервере (async spawn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const driverPath = path.join(root, 'scripts', 'test', 'res-01-e2e.mjs');
const {
    parseArgs,
    parsePromQuery,
    evaluateScrape,
    parseReadyBody,
    evaluateHealth,
    healthSemanticsFromSource,
    correlationEvaluate,
    parseAlertsJsonl,
    evaluateAlerts,
    evaluateCheck,
    buildReport,
} = await import(driverPath);

// ────────────────────────────────────────────────────────────────────────────
// parseArgs.
// ────────────────────────────────────────────────────────────────────────────
test('parseArgs: блоки, check, expect, env-defaultы', () => {
    const a = parseArgs(['--blocks', 'scrape,alerts', '--expect', 'NeurocenterStackDown,X'], {
        NEURO_E2E_PROMETHEUS: 'http://p',
        NEURO_E2E_API: 'http://a',
        NEURO_E2E_ALERTS_FILE: '/x.jsonl',
    });
    assert.deepEqual(a.blocks, ['scrape', 'alerts']);
    assert.equal(a.check, false);
    assert.deepEqual(a.expect, ['NeurocenterStackDown', 'X']);
    assert.equal(a.prom, 'http://p');
    assert.equal(a.api, 'http://a');
    assert.equal(a.alertsFile, '/x.jsonl');
});

test('parseArgs: --check; дубликаты блоков схлопываются', () => {
    const a = parseArgs(['--check', '--blocks', 'scrape,scrape,health'], {});
    assert.equal(a.check, true);
    assert.deepEqual(a.blocks, ['scrape', 'health']);
});

test('parseArgs: unknown блок/аргумент — ошибка', () => {
    assert.throws(() => parseArgs(['--blocks', 'nope'], {}), /Неизвестный блок/);
    assert.throws(() => parseArgs(['--wat'], {}), /Неизвестный аргумент/);
});

test('parseArgs: NEURO_E2E_READY_TARGETS name=url', () => {
    const a = parseArgs([], { NEURO_E2E_READY_TARGETS: 'catalog=http://h:4100, rag=http://h:4300/ready' });
    assert.deepEqual(a.readyTargets, [
        { name: 'catalog', url: 'http://h:4100' },
        { name: 'rag', url: 'http://h:4300/ready' },
    ]);
    assert.throws(() => parseArgs([], { NEURO_E2E_READY_TARGETS: 'noequals' }), /name=url/);
});

// ────────────────────────────────────────────────────────────────────────────
// Scrape (в).
// ────────────────────────────────────────────────────────────────────────────
const promJson = (rows) => ({ status: 'success', data: { result: rows } });
const upRow = (instance) => ({ metric: { instance, job: 'neurocenter' }, value: [1, '1'] });
const downRow = (instance) => ({ metric: { instance, job: 'neurocenter' }, value: [1, '0'] });
const APP6 = [
    upRow('oauth2-bridge:22222'),
    upRow('api-gateway:4000'),
    upRow('catalog-service:4100'),
    upRow('skills-service:4200'),
    upRow('rag-sync-service:4300'),
    upRow('feature-flags-service:4400'),
];

test('parsePromQuery: все up', () => {
    const p = parsePromQuery(promJson(APP6));
    assert.equal(p.ok, true);
    assert.equal(p.targets.length, 6);
    assert.equal(p.allUp, true);
    assert.deepEqual(p.down, []);
    assert.equal(p.knownDefect.present, true);
    assert.equal(p.knownDefect.down, false);
});

test('parsePromQuery: ff:4400 down → knownDefect.down', () => {
    const rows = APP6.map((r) => (r.metric.instance === 'feature-flags-service:4400' ? downRow(r.metric.instance) : r));
    const p = parsePromQuery(promJson(rows));
    assert.equal(p.allUp, false);
    assert.deepEqual(p.down, ['feature-flags-service:4400']);
    assert.equal(p.knownDefect.down, true);
});

test('parsePromQuery: не-success / пустой результат', () => {
    assert.equal(parsePromQuery({ status: 'error' }).ok, false);
    assert.equal(parsePromQuery(promJson([])).targets.length, 0);
});

test('evaluateScrape: green (все up)', () => {
    const ev = evaluateScrape(parsePromQuery(promJson(APP6)));
    assert.equal(ev.status, 'green');
    assert.match(ev.lines.join('\n'), /6\/6 up=1/);
});

test('evaluateScrape: flagged — единственный down = known-defect ff:4400', () => {
    const rows = APP6.map((r) => (r.metric.instance === 'feature-flags-service:4400' ? downRow(r.metric.instance) : r));
    const ev = evaluateScrape(parsePromQuery(promJson(rows)));
    assert.equal(ev.status, 'flagged');
    assert.match(ev.lines.join('\n'), /known-defect/);
});

test('evaluateScrape: red — down не-known-defect; red — нет таргетов', () => {
    const rows = APP6.map((r) => (r.metric.instance === 'catalog-service:4100' ? downRow(r.metric.instance) : r));
    assert.equal(evaluateScrape(parsePromQuery(promJson(rows))).status, 'red');
    assert.equal(evaluateScrape(parsePromQuery(promJson([]))).status, 'red');
    assert.equal(evaluateScrape(parsePromQuery({ status: 'error' })).status, 'red');
});

// ────────────────────────────────────────────────────────────────────────────
// Health (з).
// ────────────────────────────────────────────────────────────────────────────
test('parseReadyBody: ok:true / ok:false+checks / не-JSON', () => {
    assert.deepEqual(parseReadyBody('{"ok":true,"checks":{"gateway":"ready"}}'), { ok: true, checks: { gateway: 'ready' } });
    const down = parseReadyBody('{"ok":false,"checks":{"postgres":"unavailable"}}');
    assert.equal(down.ok, false);
    assert.deepEqual(down.checks, { postgres: 'unavailable' });
    assert.equal(parseReadyBody('not-json').parseError, true);
});

test('evaluateHealth: green (все 200 ok) / red (не-ok) / skipped (пусто)', () => {
    const good = evaluateHealth([
        { name: 'nginx', status: 200, body: '{"ok":true,"checks":{}}' },
        { name: 'catalog', status: 200, body: '{"ok":true,"checks":{"postgres":"ready"}}' },
    ]);
    assert.equal(good.status, 'green');
    const bad = evaluateHealth([{ name: 'catalog', status: 503, body: '{"ok":false,"checks":{"postgres":"unavailable"}}' }]);
    assert.equal(bad.status, 'red');
    assert.equal(evaluateHealth([]).status, 'skipped');
});

test('healthSemanticsFromSource: реальный readiness.cjs + gateway → green; битый → red', async () => {
    const readinessSrc = await readFile(path.join(root, 'services/shared/readiness.cjs'), 'utf8');
    const gatewaySrc = await readFile(path.join(root, 'services/api-gateway/src/app.controller.ts'), 'utf8');
    const good = healthSemanticsFromSource(readinessSrc, { 'api-gateway': gatewaySrc });
    assert.equal(good.status, 'green');
    assert.match(good.lines.join('\n'), /503/);
    const bad = healthSemanticsFromSource('function checkReadiness(){return {};} // no ok', { 'api-gateway': 'no state' });
    assert.equal(bad.status, 'red');
});

// ────────────────────────────────────────────────────────────────────────────
// Correlation (д).
// ────────────────────────────────────────────────────────────────────────────
test('correlationEvaluate: сквозной id nginx+gateway → green', () => {
    const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const ev = correlationEvaluate({
        requestId: id,
        logs: {
            nginx: ['{"requestId":"' + id + '","path":"/ready"}'],
            gateway: ['service=api-gateway requestId=' + id],
            service: ['service=catalog-service requestId=' + id],
        },
    });
    assert.equal(ev.status, 'green');
    assert.equal(ev.endToEnd, true);
    assert.equal(ev.serviceSeen, true);
});

test('correlationEvaluate: нет id в nginx → red', () => {
    const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const ev = correlationEvaluate({ requestId: id, logs: { nginx: ['другой id'], gateway: ['requestId=' + id], service: [] } });
    assert.equal(ev.status, 'red');
    assert.equal(ev.endToEnd, false);
});

test('correlationEvaluate: D8 — id только в nginx (2xx: success-логи gateway/service отсутствуют) → green', () => {
    const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const ev = correlationEvaluate({
        requestId: id,
        logs: { nginx: ['{"time":"2026-11-24T00:00:00.000Z","requestId":"' + id + '","method":"GET","path":"/ready","status":200,"duration":0.001}'], gateway: [], service: [] },
    });
    assert.equal(ev.status, 'green');
    assert.equal(ev.endToEnd, true);
    assert.equal(ev.serviceSeen, false);
});

test('correlationEvaluate: сырой ticket в логах → red (CRIT)', () => {
    const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const ticket = 'eyJhbGciOiJub25lIn0.c2VjcmV0';
    const ev = correlationEvaluate({
        requestId: id,
        ticket,
        logs: { nginx: ['requestId=' + id + ' path=/api/mcp-host/m/' + ticket], gateway: ['requestId=' + id], service: [] },
    });
    assert.equal(ev.status, 'red');
    assert.equal(ev.ticketLeaked, true);
});

test('correlationEvaluate: ticket замаскирован (REDACTED) → не leak', () => {
    const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const ticket = 'eyJhbGciOiJub25lIn0.c2VjcmV0';
    const ev = correlationEvaluate({
        requestId: id,
        ticket,
        logs: { nginx: ['requestId=' + id + ' path=/api/mcp-host/m/REDACTED'], gateway: ['requestId=' + id], service: [] },
    });
    assert.equal(ev.ticketLeaked, false);
    assert.equal(ev.ticketMasked, true);
    assert.equal(ev.status, 'green');
});

test('correlationEvaluate: error.message в access-строке → red', () => {
    const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const ev = correlationEvaluate({
        requestId: id,
        logs: {
            nginx: ['requestId=' + id],
            gateway: ['requestId=' + id + ' ' + new Error('boom').message],
            service: [],
        },
    });
    // Сам по себе текст сообщения не passthrough; проверяем явный err.message-паттерн.
    const ev2 = correlationEvaluate({
        requestId: id,
        logs: { nginx: ['requestId=' + id], gateway: ['requestId=' + id + ' error.message=oops'], service: [] },
    });
    assert.equal(ev2.errorMessageLeaked, true);
    assert.equal(ev2.status, 'red');
    assert.equal(ev.status, 'green'); // просто текст сообщения без passthrough-паттерна — не leak
});

// ────────────────────────────────────────────────────────────────────────────
// Alerts (г).
// ────────────────────────────────────────────────────────────────────────────
const alertLine = (name, status, severity = 'critical') =>
    JSON.stringify({ ts: '2026-11-23T00:00:00.000Z', source: 'alertmanager', status, alertname: name, severity, labels: { alertname: name, severity } });

test('parseAlertsJsonl: firing/resolved + malformed', () => {
    const text = [alertLine('A', 'firing'), alertLine('B', 'resolved'), 'не-json', JSON.stringify({ status: 'weird', alertname: 'C' }), JSON.stringify({ status: 'firing' })].join('\n');
    const p = parseAlertsJsonl(text);
    assert.equal(p.lines.length, 2);
    assert.equal(p.malformed.length, 3);
    assert.match(p.malformed[0].reason, /не-JSON/);
});

test('evaluateAlerts: ожидаемые имена есть/нет + resolve', () => {
    const p = parseAlertsJsonl([alertLine('NeurocenterStackDown', 'firing'), alertLine('NeurocenterStackDown', 'resolved')].join('\n'));
    const ok = evaluateAlerts(p, ['NeurocenterStackDown']);
    assert.equal(ok.status, 'green');
    assert.equal(ok.hasResolve, true);
    assert.deepEqual(ok.missing, []);
    const miss = evaluateAlerts(p, ['NeurocenterDiskSpaceLow']);
    assert.equal(miss.status, 'red');
    assert.deepEqual(miss.missing, ['NeurocenterDiskSpaceLow']);
});

test('evaluateAlerts: malformed → red; пустой файл → green (без expect)', () => {
    const p = parseAlertsJsonl('мусор\n');
    assert.equal(evaluateAlerts(p, []).status, 'red');
    assert.equal(evaluateAlerts(parseAlertsJsonl(''), []).status, 'green');
});

// ────────────────────────────────────────────────────────────────────────────
// evaluateCheck + buildReport.
// ────────────────────────────────────────────────────────────────────────────
test('evaluateCheck: все доступны → green; часть нет → red', () => {
    const green = evaluateCheck([
        { name: 'prom', reachable: true },
        { name: 'api', reachable: true },
        { name: 'file', reachable: true },
    ]);
    assert.equal(green.status, 'green');
    const red = evaluateCheck([{ name: 'prom', reachable: false, detail: 'fetch failed' }]);
    assert.equal(red.status, 'red');
});

test('buildReport: red-блок → exit 1; все green → exit 0; check-mode', () => {
    const red = buildReport([{ block: 'scrape', status: 'red', lines: ['down'] }]);
    assert.equal(red.exitCode, 1);
    assert.match(red.text, /RED/);
    const green = buildReport([
        { block: 'scrape', status: 'green', lines: ['6/6 up=1'] },
        { block: 'alerts', status: 'flagged', lines: ['x'] },
    ]);
    assert.equal(green.exitCode, 0);
    const check = buildReport([{ block: 'check', status: 'green', lines: ['ok'] }], { check: true });
    assert.equal(check.exitCode, 0);
    assert.match(check.text, /check-режим/);
});

// ────────────────────────────────────────────────────────────────────────────
// Live-wiring на fixture HTTP-сервере (127.0.0.1, ephemeral-порт) — --check и --blocks scrape.
// ────────────────────────────────────────────────────────────────────────────
function startFixtureServer(handler) {
    const server = http.createServer(handler);
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function spawnDriver(args, env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [driverPath, ...args], { cwd: root, env: { ...process.env, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('driver --check: fixture prom+api+file → exit 0, все доступны', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'res01-e2e '));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const alertsFile = path.join(dir, 'alerts.jsonl');
    await writeFile(alertsFile, alertLine('A', 'firing') + '\n');
    const fixture = await startFixtureServer((req, res) => {
        const url = (req.url || '').split('?')[0];
        if (url === '/api/v1/query') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(promJson([upRow('api-gateway:4000')])));
        } else if (url === '/ready') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true,"checks":{}}');
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    t.after(() => new Promise((r) => fixture.server.close(() => r())));
    const base = 'http://127.0.0.1:' + fixture.port;
    const result = await spawnDriver(['--check'], { NEURO_E2E_PROMETHEUS: base, NEURO_E2E_API: base, NEURO_E2E_ALERTS_FILE: alertsFile });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /все эндпоинты доступны/);
});

test('driver --blocks scrape: fixture Prometheus (все up) → exit 0, green', async (t) => {
    const fixture = await startFixtureServer((req, res) => {
        if ((req.url || '').startsWith('/api/v1/query')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(promJson(APP6)));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    t.after(() => new Promise((r) => fixture.server.close(() => r())));
    const result = await spawnDriver(['--blocks', 'scrape'], { NEURO_E2E_PROMETHEUS: 'http://127.0.0.1:' + fixture.port });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /GREEN/);
    assert.match(result.stdout, /6\/6 up=1/);
});

test('driver --blocks scrape: fixture Prometheus (catalog down) → exit 1, red', async (t) => {
    const rows = APP6.map((r) => (r.metric.instance === 'catalog-service:4100' ? downRow(r.metric.instance) : r));
    const fixture = await startFixtureServer((req, res) => {
        if ((req.url || '').startsWith('/api/v1/query')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(promJson(rows)));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    t.after(() => new Promise((r) => fixture.server.close(() => r())));
    const result = await spawnDriver(['--blocks', 'scrape'], { NEURO_E2E_PROMETHEUS: 'http://127.0.0.1:' + fixture.port });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /RED/);
});
