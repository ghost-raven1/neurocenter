#!/usr/bin/env node
/**
 * AD-OP-8: host-level stack-watchdog (systemd, User=neurocenter-operator, ~5 min).
 *
 * Список сервисов — data-driven из deploy/production/environment-model.json (AD-OP-1):
 * новые compose-сервисы (prometheus/alertmanager — ep6 entry 12) подхватываются
 * автоматически, без правки watchdog. Мониторинг absent-tolerant: нет в модели = не проверяется.
 *
 * Проверки:
 *  - `docker compose ps` (health каждого сервиса; compose healthchecks ходят на /ready);
 *  - /ready/dependencies (api-gateway) — consumer (контракт ep6 entry 9: решение
 *    «удалить, если к концу эпика 4 не подключён» закрыто этим подключением);
 *    формат ответа не меняется (ep6 e9 Never).
 *
 * Сбой = алерт (journal + alerts.jsonl — паттерн доставки ep6 entry 13; механизм
 * alerting не дублируется — AD-O6) + bounded attempt-restart по политике compose
 * (не более N попыток за окно; бюджет исчерпан = только алерт, эскалация оператору).
 * One-shot-сервисы (restart: 'no') не перезапускаются — только алерт.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const REPORT_SCHEMA = 'neurocenter-stack-watchdog-report-v1';

/** Коды exec /ready/dependencies: 0 — ok, 2 — 503 (зависимости деградировали), 1 — недоступен. */
const DEPS_EXEC_CODE =
    'const http=require("http");' +
    'http.get("http://127.0.0.1:"+(process.env.PORT||"4000")+"/ready/dependencies",r=>{' +
    'let b="";r.on("data",d=>b+=d);' +
    'r.on("end",()=>{process.stdout.write(b);process.exit(r.statusCode===200?0:r.statusCode===503?2:1);});' +
    '}).on("error",()=>process.exit(1));';

/** Спавн docker-команды с захватом вывода; ненулевой код — результат, не исключение. */
export function dockerRun(args, { timeoutMs = 120000, environment = process.env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, {
            cwd: repositoryRoot,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(
                new Error('Docker: команда ' + args.slice(0, 3).join(' ') + ' не завершилась за ' + timeoutMs + ' ms'),
            );
        }, timeoutMs);
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', () => {
            clearTimeout(timer);
            reject(new Error('Не удалось запустить Docker'));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}

/** `docker compose ps --format json` (v5+: NDJSON — по объекту на строку). */
export function parsePsNdjson(text) {
    const out = new Map();
    for (const line of String(text).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const row = JSON.parse(trimmed);
        if (typeof row?.Service === 'string') out.set(row.Service, row);
    }
    return out;
}

/**
 * Вердикт сервиса: 'ok' | 'starting' | 'down' | 'failed'.
 * 'down' — требует действия (restart по политике или алерт); 'failed' — one-shot завершился с ошибкой.
 */
export function judgeService(live, restartPolicy) {
    if (!live) return restartPolicy === 'no' ? 'ok' : 'down';
    switch (live.State) {
        case 'running':
            if (live.Health === 'unhealthy' || live.Health === 'restarting') return 'down';
            return 'ok';
        case 'exited':
            return Number(live.ExitCode) === 0 ? 'ok' : 'failed';
        default:
            return 'down';
    }
}

/** Попытки restart'а за окно (массив меток времени); старые записи удаляются. */
export function pruneAttempts(attempts, now, windowMs) {
    const out = {};
    for (const [service, stamps] of Object.entries(attempts || {})) {
        const kept = (Array.isArray(stamps) ? stamps : []).filter((ts) => now - Number(ts) < windowMs);
        if (kept.length) out[service] = kept;
    }
    return out;
}

export function restartBudgetExhausted(attempts, service, now, windowMs, maxRestarts) {
    return (attempts?.[service] || []).filter((ts) => now - Number(ts) < windowMs).length >= maxRestarts;
}

function composeArgs(files, projectName) {
    const args = ['compose'];
    for (const file of files) args.push('-f', file);
    args.push('--project-name', projectName);
    return args;
}

async function readState(file) {
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        return { version: 1, attempts: parsed?.attempts && typeof parsed.attempts === 'object' ? parsed.attempts : {} };
    } catch {
        return { version: 1, attempts: {} };
    }
}

async function writeState(file, state) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.tmp';
    await writeFile(temporary, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
    await rename(temporary, file);
}

/** Алерт в journal (stderr) + alerts.jsonl (паттерн доставки ep6 entry 13). */
async function emitAlert({ alertFile, project, severity, service, event, detail }) {
    const record = {
        ts: new Date().toISOString(),
        source: 'stack-watchdog',
        project,
        severity,
        service: service || undefined,
        event,
        detail: detail || undefined,
    };
    console.error('[stack-watchdog] ' + severity + (service ? ' ' + service : '') + ': ' + event);
    if (alertFile) {
        await mkdir(path.dirname(alertFile), { recursive: true, mode: 0o700 });
        const { appendFile } = await import('node:fs/promises');
        await appendFile(alertFile, JSON.stringify(record) + '\n', { mode: 0o600 });
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Полный цикл проверки.
 * options: { directory, projectName, model, stateFile, alertFile, maxRestarts, windowMs,
 *            restartWaitMs, now, run, noRestart }
 * run: async (args, opts?) => {code, stdout, stderr} — инъекция для офлайн-тестов.
 */
export async function runStackCheck(options) {
    const {
        directory,
        projectName,
        model,
        stateFile,
        alertFile,
        maxRestarts,
        windowMs,
        restartWaitMs,
        now = Date.now(),
        noRestart = false,
    } = options;
    const run = options.run || dockerRun;
    const composeFiles = [model.compose.base, ...(model.compose.overlays || [])].map((f) => path.join(directory, f));
    const base = composeArgs(composeFiles, projectName);
    const services = Object.keys(model.services).sort();
    const state = stateFile ? await readState(stateFile) : { version: 1, attempts: {} };
    state.attempts = pruneAttempts(state.attempts, now, windowMs);
    const report = {
        schema: REPORT_SCHEMA,
        ts: new Date(now).toISOString(),
        project: projectName,
        ok: true,
        services: {},
        dependencies: null,
        alerts: 0,
    };
    const alert = (severity, service, event, detail) => {
        report.alerts += 1;
        return emitAlert({ alertFile, project: projectName, severity, service, event, detail });
    };

    const [ps, config] = await Promise.all([
        run([...base, 'ps', '--format', 'json']),
        run([...base, 'config', '--format', 'json'], { timeoutMs: 120000 }),
    ]);
    if (ps.code !== 0) throw new Error('docker compose ps не выполнена: ' + (ps.stderr || '').slice(0, 400));
    const live = parsePsNdjson(ps.stdout);
    const policies = new Map();
    let policiesKnown = true;
    try {
        const parsed = JSON.parse(config.stdout);
        for (const [name, svc] of Object.entries(parsed?.services || {}))
            policies.set(name, svc?.restart_policy?.action === 'no' ? 'no' : 'unless-stopped');
    } catch (error) {
        policiesKnown = false;
        await alert('warning', undefined, 'compose-config-unreadable', error.message);
    }

    for (const service of services) {
        const verdict = judgeService(live.get(service), policies.get(service));
        const entry = {
            state: live.get(service)?.State,
            health: live.get(service)?.Health || undefined,
            verdict,
            action: 'none',
        };
        if (verdict === 'ok') {
            report.services[service] = entry;
            continue;
        }
        report.ok = false;
        if (verdict === 'failed') {
            // One-shot (restart: 'no'): compose не перезапускает — только алерт.
            entry.action = 'alert';
            await alert('critical', service, 'one-shot-failed', 'ExitCode=' + live.get(service)?.ExitCode);
            report.services[service] = entry;
            continue;
        }
        if (!policiesKnown) {
            // compose config недоступна — restart-политика неизвестна: автономный restart запрещён.
            entry.action = 'alert';
            await alert('critical', service, 'service-down', 'restart-политика неизвестна: только алерт');
            report.services[service] = entry;
            continue;
        }
        if (policies.get(service) === 'no') {
            entry.action = 'alert';
            await alert('critical', service, 'service-down', 'restart-policy=no: перезапуск не выполняется');
            report.services[service] = entry;
            continue;
        }
        if (noRestart) {
            entry.action = 'alert';
            await alert('critical', service, 'service-down', 'restart отключён (--no-restart)');
            report.services[service] = entry;
            continue;
        }
        if (restartBudgetExhausted(state.attempts, service, now, windowMs, maxRestarts)) {
            entry.action = 'budget-exhausted';
            await alert(
                'critical',
                service,
                'restart-budget-exhausted',
                'попыток за окно: ' + maxRestarts + ' — эскалация оператору',
            );
            report.services[service] = entry;
            continue;
        }
        const restarted = await run([...base, 'restart', service], { timeoutMs: 300000 });
        (state.attempts[service] ||= []).push(now);
        if (restarted.code !== 0) {
            entry.action = 'restart-failed';
            await alert('critical', service, 'restart-failed', (restarted.stderr || '').slice(0, 300));
            report.services[service] = entry;
            continue;
        }
        await sleep(restartWaitMs);
        const after = parsePsNdjson((await run([...base, 'ps', '--format', 'json'])).stdout);
        const recovered = judgeService(after.get(service), policies.get(service)) !== 'down';
        entry.action = recovered ? 'restart-recovered' : 'restart-still-down';
        if (recovered) {
            await alert('warning', service, 'restart-recovered', 'сервис восстановлен attempt-restart');
        } else {
            report.ok = false;
            await alert('critical', service, 'restart-still-down', 'attempt-restart не восстановил сервис');
        }
        report.services[service] = entry;
    }

    // Consumer /ready/dependencies (ep6 entry 9): диагностика 5 upstream'ов из gateway.
    const gateway = model.services['api-gateway'];
    if (gateway && live.get('api-gateway')?.State === 'running') {
        const result = await run([...base, 'exec', '-T', 'api-gateway', 'node', '-e', DEPS_EXEC_CODE], {
            timeoutMs: 60000,
        });
        let checks = null;
        try {
            checks = JSON.parse(result.stdout);
        } catch {
            checks = null;
        }
        if (result.code === 0) {
            report.dependencies = { ok: true, upstreams: checks?.checks || null };
        } else if (result.code === 2) {
            report.ok = false;
            const bad = Object.entries(checks?.checks || {})
                .filter(([, v]) => v !== 'ready')
                .map(([k, v]) => k + '=' + v);
            report.dependencies = { ok: false, upstreams: checks?.checks || null };
            await alert(
                'warning',
                'api-gateway',
                'dependencies-degraded',
                '/ready/dependencies 503: ' + (bad.join(', ') || 'body не распознан'),
            );
        } else {
            report.dependencies = { ok: false, upstreams: null };
            await alert('warning', 'api-gateway', 'dependencies-unreachable', (result.stderr || '').slice(0, 300));
        }
    }

    // Итог: ok, если нет неразрешённых сбоев (успешный attempt-restart снимает сбой).
    const unresolved = Object.values(report.services).some(
        (s) => s.verdict === 'failed' || (s.verdict === 'down' && s.action !== 'restart-recovered'),
    );
    report.ok = !unresolved && !(report.dependencies && report.dependencies.ok === false);

    if (stateFile) await writeState(stateFile, state);
    return report;
}

async function main() {
    process.umask(0o077);
    const args = process.argv.slice(2);
    const values = {};
    if (args.shift() !== 'check') {
        throw new Error(
            'Команда: check --directory <repository> --project-name <stack> [--state-file <path>] [--alert-file <path>] [--max-restarts <n>] [--window-ms <ms>] [--restart-wait-ms <ms>] [--no-restart]',
        );
    }
    const names = {
        '--directory': 'directory',
        '--project-name': 'projectName',
        '--state-file': 'stateFile',
        '--alert-file': 'alertFile',
        '--max-restarts': 'maxRestarts',
        '--window-ms': 'windowMs',
        '--restart-wait-ms': 'restartWaitMs',
    };
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--no-restart') {
            values.noRestart = true;
            continue;
        }
        const key = names[args[i]];
        if (!key || !args[i + 1]) throw new Error('Некорректный параметр watchdog');
        values[key] = Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : args[i + 1];
        i += 1;
    }
    const directory = path.resolve(values.directory || repositoryRoot);
    const model = JSON.parse(await readFile(path.join(directory, 'deploy/production/environment-model.json'), 'utf8'));
    const report = await runStackCheck({
        directory,
        projectName: values.projectName || 'neurocenter-production',
        model,
        stateFile: values.stateFile,
        alertFile: values.alertFile,
        maxRestarts: values.maxRestarts ?? 3,
        windowMs: values.windowMs ?? 30 * 60 * 1000,
        restartWaitMs: values.restartWaitMs ?? 60000,
        noRestart: values.noRestart === true,
    });
    console.log(JSON.stringify(report, null, 1));
    if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error('stack-watchdog не завершён: ' + error.message);
        process.exitCode = 1;
    });
}
