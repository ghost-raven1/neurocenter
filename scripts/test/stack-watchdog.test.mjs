/**
 * Stack-watchdog (epic-dr entry 8, AD-OP-8, OQ3/OQ4): офлайн-логика на fixture.
 * Случаи: down → attempt-restart (bounded); 2 сбоя подряд → только алерт;
 * data-driven список из environment-model (+1 сервис подхватывается);
 * /ready/dependencies 503 → diagnostic consumer (без restart gateway);
 * one-shot exited(0) → ok, exited(1) → алерт без restart; мониторинг absent → не проверяется.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    judgeService,
    parsePsNdjson,
    pruneAttempts,
    restartBudgetExhausted,
    runStackCheck,
} from '../production/stack-watchdog.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const WINDOW = 30 * 60 * 1000;

function model(services) {
    return {
        schema: 'neurocenter-environment-model-v1',
        compose: { base: 'compose.production.yml', overlays: ['compose.chat-storage.yml'] },
        services: Object.fromEntries(
            services.map((name) => [
                name,
                { image: 'neurocenter/' + name + ':test', networks: ['backend'], env: { PORT: '4000' } },
            ]),
        ),
    };
}
const BASE_SERVICES = ['postgres', 'catalog-service', 'api-gateway', 'frontend'];

function psLine(service, state, health, exitCode = 0) {
    return JSON.stringify({ Service: service, State: state, Health: health, ExitCode: exitCode });
}
function psNdjson(...lines) {
    return lines.join('\n') + '\n';
}

/** Фейк docker-раннера: ps → NDJSON, config → JSON, restart/exec — записи вызовов. */
function fakeRun({ psOutput, policies = {}, depsCode = 0, depsBody = '', restartFails = false, configCode = 0 }) {
    const calls = [];
    let restarts = 0;
    const run = async (args, opts) => {
        calls.push(args);
        if (args.slice(-3).join(' ') === 'ps --format json') {
            return { code: 0, stdout: psOutput, stderr: '' };
        }
        if (args.includes('config')) {
            if (configCode !== 0) return { code: configCode, stdout: '', stderr: 'env file not found' };
            return {
                code: 0,
                stdout: JSON.stringify({
                    services: Object.fromEntries(
                        Object.keys(policies).map((name) => [name, { restart_policy: { action: policies[name] } }]),
                    ),
                }),
                stderr: '',
            };
        }
        if (args.includes('restart')) {
            restarts += 1;
            return restartFails
                ? { code: 1, stdout: '', stderr: 'restart failed' }
                : { code: 0, stdout: '', stderr: '' };
        }
        if (args.includes('exec')) {
            return { code: depsCode, stdout: depsBody, stderr: depsCode === 1 ? 'unreachable' : '' };
        }
        throw new Error('неожиданная команда: ' + args.join(' '));
    };
    return { run, calls, count: (name) => calls.filter((args) => args.includes(name)).length };
}

const allHealthy = () =>
    psNdjson(...BASE_SERVICES.map((name) => psLine(name, 'running', name === 'postgres' ? 'healthy' : 'healthy')));
const policies = (extra = {}) =>
    Object.fromEntries([...BASE_SERVICES, ...Object.keys(extra)].map((name) => [name, 'unless-stopped']));

test('все сервисы healthy → ok, без restart и без алертов', async () => {
    const { run, count } = fakeRun({ psOutput: allHealthy(), policies: policies() });
    const report = await runStackCheck({
        directory: '/fixture',
        projectName: 'test',
        model: model(BASE_SERVICES),
        stateFile: undefined,
        alertFile: undefined,
        maxRestarts: 3,
        windowMs: WINDOW,
        restartWaitMs: 0,
        now: NOW,
        run,
    });
    assert.equal(report.ok, true);
    assert.equal(report.schema, 'neurocenter-stack-watchdog-report-v1');
    assert.equal(report.alerts, 0);
    assert.equal(count('restart'), 0);
    assert.equal(report.dependencies.ok, true);
});

test('сервис down (unhealthy) → attempt-restart → recovered (bounded)', async () => {
    let tick = 0;
    const { run, count } = fakeRun({
        policies: policies(),
        depsCode: 0,
        depsBody: JSON.stringify({ ok: true, checks: {} }),
    });
    // Первый ps: catalog down; после restart (второй ps) — healthy.
    const original = run;
    const seqRun = async (args, opts) => {
        if (args.slice(-3).join(' ') === 'ps --format json') {
            tick += 1;
            return {
                code: 0,
                stdout:
                    tick === 1
                        ? psNdjson(
                              psLine('postgres', 'running', 'healthy'),
                              psLine('catalog-service', 'running', 'unhealthy'),
                              psLine('api-gateway', 'running', 'healthy'),
                              psLine('frontend', 'running', 'healthy'),
                          )
                        : allHealthy(),
                stderr: '',
            };
        }
        return original(args, opts);
    };
    const report = await runStackCheck({
        directory: '/fixture',
        projectName: 'test',
        model: model(BASE_SERVICES),
        alertFile: undefined,
        maxRestarts: 3,
        windowMs: WINDOW,
        restartWaitMs: 0,
        now: NOW,
        run: seqRun,
    });
    assert.equal(report.ok, true, 'после успешного restart-рекавери отчёт ok');
    assert.equal(report.services['catalog-service'].action, 'restart-recovered');
    assert.equal(count('restart'), 1);
});

test('2 сбоя подряд (N=2) → бюджет исчерпан: дальше только алерт, без restart', async () => {
    const { run } = fakeRun({
        psOutput: psNdjson(
            psLine('postgres', 'running', 'healthy'),
            psLine('catalog-service', 'running', 'unhealthy'),
            psLine('api-gateway', 'running', 'healthy'),
            psLine('frontend', 'running', 'healthy'),
        ),
        policies: policies(),
    });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-watchdog-'));
    const stateFile = path.join(directory, 'state.json');
    const options = {
        directory: '/fixture',
        projectName: 'test',
        model: model(BASE_SERVICES),
        stateFile,
        alertFile: path.join(directory, 'alerts.jsonl'),
        maxRestarts: 2,
        windowMs: WINDOW,
        restartWaitMs: 0,
        now: NOW,
        run,
    };
    // Цикл 1 и 2 — attempt-restart (бюджет 2), сервис не поднимается; цикл 3 — только алерт.
    const first = await runStackCheck(options);
    assert.equal(first.services['catalog-service'].action, 'restart-still-down');
    const second = await runStackCheck({ ...options, now: NOW + 60000 });
    assert.equal(second.services['catalog-service'].action, 'restart-still-down');
    const third = await runStackCheck({ ...options, now: NOW + 120000 });
    assert.equal(third.services['catalog-service'].action, 'budget-exhausted');
    assert.equal(third.ok, false);
    const alerts = (await fs.readFile(options.alertFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(alerts.filter((a) => a.event === 'restart-still-down').length, 2);
    assert.ok(alerts.some((a) => a.event === 'restart-budget-exhausted' && a.severity === 'critical'));
    assert.ok(alerts.every((a) => a.source === 'stack-watchdog' && a.service === 'catalog-service'));
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.attempts['catalog-service'].length, 2, 'в бюджете ровно N попыток за окно');
});

test('data-driven: новый сервис в модели подхватывается без правки watchdog', async () => {
    const services = [...BASE_SERVICES, 'prometheus'];
    const { run } = fakeRun({
        psOutput: psNdjson(
            ...BASE_SERVICES.map((name) => psLine(name, 'running', 'healthy')),
            psLine('prometheus', 'running', 'healthy'),
        ),
        policies: policies({ prometheus: 'unless-stopped' }),
    });
    const report = await runStackCheck({
        directory: '/fixture',
        projectName: 'test',
        model: model(services),
        maxRestarts: 3,
        windowMs: WINDOW,
        restartWaitMs: 0,
        now: NOW,
        run,
    });
    assert.ok(report.services['prometheus'], 'новый сервис из модели в списке проверок');
    assert.equal(report.services['prometheus'].verdict, 'ok');
    assert.equal(report.ok, true);
});

test('мониторинг absent (нет в модели) → не проверяется (OQ4 absent-tolerant)', async () => {
    const { run } = fakeRun({ psOutput: allHealthy(), policies: policies() });
    const report = await runStackCheck({
        directory: '/fixture',
        projectName: 'test',
        model: model(BASE_SERVICES), // prometheus/alertmanager в модели нет
        maxRestarts: 3,
        windowMs: WINDOW,
        restartWaitMs: 0,
        now: NOW,
        run,
    });
    assert.equal(report.ok, true, 'absent-мониторинг — не сбой watchdog');
    assert.equal('prometheus' in report.services, false);
});

test('/ready/dependencies 503 → diagnostic consumer (warning), gateway не перезапускается', async () => {
    const { run, count } = fakeRun({
        psOutput: allHealthy(),
        policies: policies(),
        depsCode: 2,
        depsBody: JSON.stringify({ ok: false, checks: { catalog: 'ready', rag: 'unavailable', auth: 'ready' } }),
    });
    const report = await runStackCheck({
        directory: '/fixture',
        projectName: 'test',
        model: model(BASE_SERVICES),
        alertFile: undefined,
        maxRestarts: 3,
        windowMs: WINDOW,
        restartWaitMs: 0,
        now: NOW,
        run,
    });
    assert.equal(report.dependencies.ok, false);
    assert.equal(report.dependencies.upstreams.rag, 'unavailable');
    assert.equal(count('restart'), 0, 'деградация зависимостей не означает restart gateway');
    assert.equal(report.ok, false, 'degraded-зависимости фиксируются как сбой диагностики');
});

test('one-shot exited(0) → ok; exited(1) → critical-алерт без restart', async () => {
    const { run, count } = fakeRun({
        psOutput: psNdjson(
            psLine('database-init', 'exited', '', 0),
            psLine('bootstrap-admin', 'exited', '', 1),
            ...BASE_SERVICES.map((name) => psLine(name, 'running', 'healthy')),
        ),
        policies: { ...policies(), 'database-init': 'no', 'bootstrap-admin': 'no' },
    });
    const report = await runStackCheck({
        directory: '/fixture',
        projectName: 'test',
        model: model([...BASE_SERVICES, 'database-init', 'bootstrap-admin']),
        alertFile: undefined,
        maxRestarts: 3,
        windowMs: WINDOW,
        restartWaitMs: 0,
        now: NOW,
        run,
    });
    assert.equal(report.services['database-init'].verdict, 'ok');
    assert.equal(report.services['bootstrap-admin'].verdict, 'failed');
    assert.equal(report.services['bootstrap-admin'].action, 'alert');
    assert.equal(count('restart'), 0, 'one-shot не перезапускается (restart: no)');
    assert.equal(report.ok, false);
});

test('compose config недоступна → политика неизвестна: только алерт, без автономного restart', async () => {
    const { run, count } = fakeRun({
        psOutput: psNdjson(
            psLine('postgres', 'running', 'healthy'),
            psLine('catalog-service', 'running', 'unhealthy'),
            psLine('api-gateway', 'running', 'healthy'),
            psLine('frontend', 'running', 'healthy'),
        ),
        policies: policies(),
        configCode: 1,
    });
    const report = await runStackCheck({
        directory: '/fixture',
        projectName: 'test',
        model: model(BASE_SERVICES),
        alertFile: undefined,
        maxRestarts: 3,
        windowMs: WINDOW,
        restartWaitMs: 0,
        now: NOW,
        run,
    });
    assert.equal(report.services['catalog-service'].action, 'alert');
    assert.equal(count('restart'), 0, 'без известных политик restart запрещён');
    assert.equal(report.ok, false);
});

test('judgeService: маппинг состояний', () => {
    assert.equal(judgeService({ State: 'running', Health: 'healthy' }, 'unless-stopped'), 'ok');
    assert.equal(judgeService({ State: 'running', Health: 'starting' }, 'unless-stopped'), 'ok');
    assert.equal(judgeService({ State: 'running', Health: 'unhealthy' }, 'unless-stopped'), 'down');
    assert.equal(judgeService({ State: 'running', Health: '' }, 'unless-stopped'), 'ok');
    assert.equal(judgeService({ State: 'exited', ExitCode: 0 }, 'no'), 'ok');
    assert.equal(judgeService({ State: 'exited', ExitCode: 1 }, 'no'), 'failed');
    assert.equal(judgeService(undefined, 'no'), 'ok', 'one-shot отсутствующий контейнер в покое — не сбой');
    assert.equal(judgeService(undefined, 'unless-stopped'), 'down');
    assert.equal(judgeService({ State: 'dead', Health: '' }, 'unless-stopped'), 'down');
});

test('parsePsNdjson: NDJSON-строки, пустые игнорируются', () => {
    const map = parsePsNdjson(psLine('a', 'running', 'healthy') + '\n\n' + psLine('b', 'exited', '', 0) + '\n');
    assert.deepEqual([...map.keys()], ['a', 'b']);
    assert.equal(map.get('b').ExitCode, 0);
});

test('budget: pruneAttempts и restartBudgetExhausted', () => {
    const attempts = { a: [NOW - 1000, NOW - 1000], old: [NOW - 2 * WINDOW] };
    const pruned = pruneAttempts(attempts, NOW, WINDOW);
    assert.deepEqual(pruned, { a: [NOW - 1000, NOW - 1000] });
    assert.equal(restartBudgetExhausted(pruned, 'a', NOW, WINDOW, 2), true);
    assert.equal(restartBudgetExhausted(pruned, 'a', NOW, WINDOW, 3), false);
    assert.equal(restartBudgetExhausted(pruned, 'other', NOW, WINDOW, 1), false);
});
