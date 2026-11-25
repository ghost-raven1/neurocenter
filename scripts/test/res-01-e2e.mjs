#!/usr/bin/env node
// RES-01 (epic-res-obs 6.15) — e2e-драйвер: автоматизируемые блоки live-приёмки.
//
//   node scripts/test/res-01-e2e.mjs --blocks scrape,health,correlation,alerts
//   node scripts/test/res-01-e2e.mjs --check
//
// Автоматизируемое (без HITL, Design Notes «Автоматизируемое vs HITL»):
//   scrape      (в)  Prometheus /api/v1/query up{job="neurocenter"} → все таргеты up=1;
//                    ff:4400 — отдельно как known-defect, если таргет существует.
//   health      (з)  GET /ready на scrape-таргетах → 200 при up; SEMANTICS: 503 + body
//                    c checks при down (down-ветка проверяется статически по коду
//                    shared ready-бюджетов, если live-down невозможен — HITL).
//   correlation (д)  запрос через nginx с X-Request-ID → grep логов на сквозной id
//                    nginx→gateway→сервис + ассерт: нет ticket-сегмента (REDACTED) и нет
//                    error.message в access/error-строках.
//   alerts      (г)  чтение alerts.jsonl → формат строк (firing/resolved), наличие
//                    ожидаемых alertname (--expect), resolve-строки.
//
// Без живого стека: `--check` → проверка доступности эндпоинтов + понятный отчёт чего
// нет (не падает криво).
//
// Env:
//   NEURO_E2E_PROMETHEUS   (default http://localhost:9090)
//   NEURO_E2E_API          (default http://localhost:8443)
//   NEURO_E2E_ALERTS_FILE  (default /var/log/neurocenter/alerts.jsonl)
//   NEURO_E2E_READY_TARGETS  (опц.) name=url,name=url — прямые /ready URL таргетов
//   NEURO_E2E_CORRELATION_ID (опц.) — id для correlation (иначе генерируется)
//   NEURO_E2E_CORRELATION_PATH (опц.) — путь запроса (default /ready)
//   NEURO_E2E_CORRELATION_TICKET (опц.) — ticket для проверки маски m/:ticket
//   NEURO_E2E_COMPOSE_PROJECT (опц.) — compose-проект для docker logs (default neurocenter-production)
//   NEURO_E2E_COMPOSE_ENV_FILE (опц.) — путь к .env для `compose logs` (интерполяция
//                    required-переменных, напр. NEUROCENTER_RELEASE; без него на live-стенде
//                    correlation не найдёт сервисов и/nginx-логи)
//
// Чистое ядро (parse/evaluate) экспортируется и покрывается unit-тестом
// res-01-e2e.test.mjs (node:test, fixture HTTP-сервер, НЕ live-зависимый).
// Live-провожирование (fetch/docker) — тонкая обёртка.
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULTS = Object.freeze({
    prom: 'http://localhost:9090',
    api: 'http://localhost:8443',
    alertsFile: '/var/log/neurocenter/alerts.jsonl',
});

// known-defect таргет (I/O-матрица: ff:4400 отдельно). Если существует и down — флаг,
// а не generic-red: это зафиксированный дефект, не регрессия данного прогона.
const KNOWN_DEFECT_INSTANCE = 'feature-flags-service:4400';

// ────────────────────────────────────────────────────────────────────────────
// Аргументы (pure).
// ────────────────────────────────────────────────────────────────────────────
const BLOCK_IDS = new Set(['scrape', 'health', 'correlation', 'alerts']);

export function parseArgs(argv, env = process.env) {
    const out = {
        blocks: [],
        check: false,
        expect: [],
        prom: env.NEURO_E2E_PROMETHEUS || DEFAULTS.prom,
        api: env.NEURO_E2E_API || DEFAULTS.api,
        alertsFile: env.NEURO_E2E_ALERTS_FILE || DEFAULTS.alertsFile,
        readyTargets: parseReadyTargets(env.NEURO_E2E_READY_TARGETS),
        correlationId: env.NEURO_E2E_CORRELATION_ID || '',
        correlationPath: env.NEURO_E2E_CORRELATION_PATH || '/ready',
        correlationTicket: env.NEURO_E2E_CORRELATION_TICKET || '',
        composeProject: env.NEURO_E2E_COMPOSE_PROJECT || 'neurocenter-production',
        composeEnvFile: env.NEURO_E2E_COMPOSE_ENV_FILE || '',
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--check') out.check = true;
        else if (a === '--blocks') {
            const v = argv[++i] || '';
            for (const b of v.split(',')) {
                const t = b.trim();
                if (!t) continue;
                if (!BLOCK_IDS.has(t)) throw new Error('Неизвестный блок: ' + t + ' (допустимо: ' + [...BLOCK_IDS].join(', ') + ')');
                if (!out.blocks.includes(t)) out.blocks.push(t);
            }
        } else if (a === '--expect') {
            const v = argv[++i] || '';
            for (const n of v.split(',')) {
                const t = n.trim();
                if (t && !out.expect.includes(t)) out.expect.push(t);
            }
        } else if (a === '--help' || a === '-h') {
            out.help = true;
        } else {
            throw new Error('Неизвестный аргумент: ' + a);
        }
    }
    return out;
}

// name=url,name=url → [{name,url}]; пустая строка → [].
function parseReadyTargets(value) {
    if (!value) return [];
    const out = [];
    for (const part of value.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const idx = t.indexOf('=');
        if (idx === -1) throw new Error('NEURO_E2E_READY_TARGETS: ожидается name=url, получено ' + t);
        out.push({ name: t.slice(0, idx).trim(), url: t.slice(idx + 1).trim() });
    }
    return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Scrape (в): parse /api/v1/query + evaluate.
// ────────────────────────────────────────────────────────────────────────────

// Ответ Prometheus /api/v1/query для up{job="neurocenter"} → нормализованные таргеты.
export function parsePromQuery(json) {
    if (!json || json.status !== 'success') {
        return { ok: false, error: 'не-success ответ Prometheus', targets: [] };
    }
    const data = json.data || {};
    const result = Array.isArray(data.result) ? data.result : [];
    const targets = result.map((row) => {
        const metric = row.metric || {};
        const instance = metric.instance || '';
        const upRaw = row.value ? row.value[1] : '0';
        const up = Number(upRaw) === 1;
        return { instance, up, job: metric.job || 'neurocenter' };
    });
    const down = targets.filter((t) => !t.up).map((t) => t.instance);
    const defect = targets.find((t) => t.instance === KNOWN_DEFECT_INSTANCE);
    return {
        ok: true,
        targets,
        allUp: targets.length > 0 && down.length === 0,
        down,
        knownDefect: { present: !!defect, down: !!defect && !defect.up },
    };
}

// Вердикт блока scrape: green если все up; red если есть down (кроме known-defect);
// flagged если единственный down — known-defect (ff:4400).
export function evaluateScrape(parsed) {
    if (!parsed.ok) return { status: 'red', lines: ['scrape: ' + (parsed.error || 'ошибка запроса к Prometheus')] };
    if (!parsed.targets.length) return { status: 'red', lines: ['scrape: нет таргетов job="neurocenter" (Prometheus не собрал стек)'] };
    const lines = parsed.targets.map((t) => '  ' + (t.up ? '[up]   ' : '[down] ') + t.instance);
    const down = parsed.down;
    if (down.length === 0) {
        lines.push('  → ' + parsed.targets.length + '/' + parsed.targets.length + ' up=1');
        return { status: 'green', lines };
    }
    const onlyDefect = down.length === 1 && down[0] === KNOWN_DEFECT_INSTANCE;
    lines.push('  → down: ' + down.join(', '));
    if (onlyDefect) {
        lines.push('  → ff:4400 down = known-defect (зафиксирован, не регрессия прогона)');
        return { status: 'flagged', lines };
    }
    if (parsed.knownDefect.down) lines.push('  → ff:4400 тоже down (known-defect)');
    return { status: 'red', lines };
}

// ────────────────────────────────────────────────────────────────────────────
// Health (з): parse /ready body + evaluate + статическая SEMANTICS.
// ────────────────────────────────────────────────────────────────────────────

// Тело /ready → { ok, checks }. ok:true и {ok:false, checks:{...}} (503 при down).
export function parseReadyBody(text) {
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, checks: null, parseError: true };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, checks: null, parseError: true };
    const checks = json.checks && typeof json.checks === 'object' && !Array.isArray(json.checks) ? json.checks : null;
    return { ok: json.ok === true, checks };
}

// probes = [{name, status, body}] → green если все 200 + {ok:true}.
export function evaluateHealth(probes) {
    if (!probes.length) return { status: 'skipped', lines: ['health: нет пробируемых /ready (задайте NEURO_E2E_READY_TARGETS или доступный api)'] };
    const lines = [];
    let allGood = true;
    for (const p of probes) {
        const body = parseReadyBody(p.body || '');
        const good = p.status === 200 && body.ok === true;
        if (!good) allGood = false;
        lines.push('  ' + (good ? '[200 ok]' : '[' + p.status + ']  ') + p.name + (body.checks ? '  checks=' + JSON.stringify(body.checks) : ''));
    }
    lines.push('  → ' + (allGood ? 'все /ready = 200 ok' : 'есть /ready не 200/ok'));
    return { status: allGood ? 'green' : 'red', lines };
}

// Статическая SEMANTICS: down-ветка /ready = 503 + body c checks. Проверяется по коду
// shared ready-бюджетов (readiness.cjs) + ready-контроллерам сервисов.
export function healthSemanticsFromSource(readinessSrc, controllerSrcs) {
    const lines = [];
    let ok = true;
    // readiness.cjs: checkReadiness возвращает { ok, checks }.
    const hasOkChecks = /ok:\s*entries\.every/.test(readinessSrc) && /checks:\s*Object\.fromEntries/.test(readinessSrc);
    if (hasOkChecks) lines.push('  + readiness.cjs: checkReadiness → { ok, checks } (агрегированные проверки зависимостей)');
    else {
        ok = false;
        lines.push('  - readiness.cjs: не найдено { ok, checks } в checkReadiness');
    }
    // httpReady: не-ok /ready зависимости → throw 'unavailable' (не ready).
    if (/if \(!response\.ok\)/.test(readinessSrc) && /throw new Error\('unavailable'\)/.test(readinessSrc)) {
        lines.push('  + readiness.cjs: httpReady — не-ok зависимости → unavailable (down-ветка)');
    } else {
        ok = false;
        lines.push('  - readiness.cjs: httpReady не отрабатывает down-ветку');
    }
    // Контроллеры: !state.ok → ServiceUnavailableException (503) с body (checks).
    let controllersWith503 = 0;
    for (const [name, src] of Object.entries(controllerSrcs)) {
        const throws503 = /ServiceUnavailableException\(state\)/.test(src) && /if \(!state\.ok\)/.test(src);
        if (throws503) controllersWith503 += 1;
        else lines.push('  - ' + name + ': не найдено !state.ok → ServiceUnavailableException(state)');
    }
    if (controllersWith503 > 0) lines.push('  + ' + controllersWith503 + ' контроллер(ов): !state.ok → 503 (ServiceUnavailableException) с body checks');
    else ok = false;
    lines.push('  → SEMANTICS ' + (ok ? 'подтверждена статически (503 + checks при down)' : 'НЕ подтверждена — проверить код'));
    return { status: ok ? 'green' : 'red', lines };
}

// ────────────────────────────────────────────────────────────────────────────
// Correlation (д): evaluate сквозного id + маска ticket + нет error.message.
// ────────────────────────────────────────────────────────────────────────────

// input: { requestId, logs: {nginx:[],gateway:[],service:[]}, ticket?, }
// → end-to-end id во всех слоях, ticket замаскирован (REDACTED), нет error.message.
export function correlationEvaluate(input) {
    const requestId = input.requestId;
    const logs = input.logs || {};
    const has = (arr) => (Array.isArray(arr) ? arr : []).some((l) => String(l).includes(requestId));
    const nginx = has(logs.nginx);
    const gateway = has(logs.gateway);
    const service = has(logs.service);
    const lines = [
        '  nginx:   ' + (nginx ? 'id есть' : 'id НЕТ'),
        '  gateway: ' + (gateway ? 'id есть' : 'id НЕТ'),
        '  service: ' + (service ? 'id есть' : 'id НЕТ (ожидается, если запрос дошёл до сервиса)'),
    ];
    // D8/тикет 24: nginx — единственный слой, который ВСЕГДА пишет запись о запросе (access-лог).
    // gateway/service пишут только error/warn (не success-логи): для 2xx downstream-записей нет,
    // поэтому сквозной id верифицируется по nginx-краю; downstream-слой (если залогил) — bonus
    // ниже + покрывается блоками е (crash) и ж (audit). Критерий: id в nginx-крае.
    const endToEnd = nginx;
    let ticketLeaked = false;
    let ticketMasked = false;
    if (input.ticket) {
        const all = [...(logs.nginx || []), ...(logs.gateway || []), ...(logs.service || [])].map(String);
        ticketLeaked = all.some((l) => l.includes(input.ticket));
        ticketMasked = all.some((l) => l.includes('REDACTED'));
        lines.push('  ticket: ' + (ticketLeaked ? 'СЫРОЙ ticket в логах (CRIT)' : ticketMasked ? 'замаскирован (REDACTED)' : 'маска не найдена'));
    }
    // error.message / e.message / err.message в access/error-строках (passthrough).
    const errPattern = /\b(?:error|err|e)\b\s*\??\.(?:message|stack)\b|\bString\(\s*\b(?:error|err|e)\b\s*\)/;
    let errorMessageLeaked = false;
    for (const key of ['nginx', 'gateway', 'service']) {
        for (const l of logs[key] || []) {
            if (errPattern.test(String(l))) {
                errorMessageLeaked = true;
                lines.push('  error-message leak: ' + String(l).slice(0, 120));
            }
        }
    }
    if (!errorMessageLeaked) lines.push('  error.message в access/error-строках: нет');
    let status = 'green';
    if (!endToEnd) status = 'red';
    else if (ticketLeaked) status = 'red';
    else if (errorMessageLeaked) status = 'red';
    else if (input.ticket && !ticketMasked) status = 'flagged';
    return { status, lines, endToEnd, ticketLeaked, ticketMasked, errorMessageLeaked, serviceSeen: service };
}

// ────────────────────────────────────────────────────────────────────────────
// Alerts (г): parse JSONL + evaluate ожидаемых alertname + resolve.
// ────────────────────────────────────────────────────────────────────────────

// alerts.jsonl (текст) → { lines:[{...}], malformed:[{lineNo, reason}] }.
export function parseAlertsJsonl(text) {
    const lines = [];
    const malformed = [];
    const raw = String(text).split('\n');
    for (let i = 0; i < raw.length; i += 1) {
        const t = raw[i].trim();
        if (!t) continue;
        let obj;
        try {
            obj = JSON.parse(t);
        } catch {
            malformed.push({ lineNo: i + 1, reason: 'не-JSON' });
            continue;
        }
        const status = obj.status;
        if (status !== 'firing' && status !== 'resolved') {
            malformed.push({ lineNo: i + 1, reason: 'status не firing/resolved: ' + String(status) });
            continue;
        }
        if (!obj.alertname) {
            malformed.push({ lineNo: i + 1, reason: 'нет alertname' });
            continue;
        }
        lines.push(obj);
    }
    return { lines, malformed };
}

// parsed + expectedNames → наличие ожидаемых alertname, resolve-строки.
export function evaluateAlerts(parsed, expectedNames) {
    const lines = [];
    const byName = new Map();
    for (const l of parsed.lines) {
        if (!byName.has(l.alertname)) byName.set(l.alertname, { firing: 0, resolved: 0 });
        const rec = byName.get(l.alertname);
        if (l.status === 'firing') rec.firing += 1;
        else rec.resolved += 1;
    }
    for (const [name, rec] of byName) lines.push('  ' + name + '  firing=' + rec.firing + ' resolved=' + rec.resolved);
    if (!byName.size) lines.push('  (нет алертов в файле)');
    const missing = [];
    if (expectedNames.length) {
        for (const n of expectedNames) {
            if (byName.has(n)) lines.push('  + ожидался ' + n + ': есть (firing=' + byName.get(n).firing + ')');
            else {
                missing.push(n);
                lines.push('  - ожидался ' + n + ': НЕТ');
            }
        }
    }
    const hasResolve = parsed.lines.some((l) => l.status === 'resolved');
    if (parsed.lines.length) lines.push('  resolve-строки: ' + (hasResolve ? 'есть' : 'нет (алерты ещё не сняты)'));
    let status = 'green';
    if (parsed.malformed.length) {
        status = 'red';
        for (const m of parsed.malformed) lines.push('  malformed line ' + m.lineNo + ': ' + m.reason);
    } else if (missing.length) {
        status = 'red';
        lines.push('  → отсутствуют ожидаемые alertname: ' + missing.join(', '));
    }
    return { status, lines, missing, hasResolve, count: parsed.lines.length };
}

// ────────────────────────────────────────────────────────────────────────────
// --check: доступность эндпоинтов (без стека — понятный отчёт чего нет).
// ────────────────────────────────────────────────────────────────────────────
export function evaluateCheck(probes) {
    // probes = [{name, url, reachable, detail}]
    const lines = probes.map((p) => '  ' + (p.reachable ? '[ok]    ' : '[нет]  ') + p.name + (p.detail ? '  — ' + p.detail : ''));
    const allReachable = probes.every((p) => p.reachable);
    lines.push('  → ' + (allReachable ? 'все эндпоинты доступны — можно гонять блоки' : 'часть эндпоинтов недоступна (см. выше) — заведите стек/порты'));
    return { status: allReachable ? 'green' : 'red', lines };
}

// ────────────────────────────────────────────────────────────────────────────
// Отчёт (pure): результаты блоков → текст + exit code.
// ────────────────────────────────────────────────────────────────────────────
const BLOCK_LABEL = { scrape: 'в (scrape)', health: 'з (health)', correlation: 'д (correlation)', alerts: 'г (alerts)', check: '--check' };
const STATUS_ICON = { green: 'GREEN', red: 'RED  ', flagged: 'FLAG ', skipped: 'SKIP ', hitl: 'HITL ' };

export function buildReport(results, { check = false } = {}) {
    const out = [];
    out.push('RES-01 e2e — ' + (check ? 'check-режим (доступность)' : 'блоки: ' + results.map((r) => r.block).join(', ')));
    out.push('='.repeat(72));
    let red = 0;
    for (const r of results) {
        if (r.status === 'red') red += 1;
        out.push('');
        out.push('[' + (STATUS_ICON[r.status] || r.status.toUpperCase()) + '] ' + (BLOCK_LABEL[r.block] || r.block));
        for (const l of r.lines || []) out.push(l);
    }
    out.push('='.repeat(72));
    if (check) {
        const allOk = results.every((r) => r.status === 'green');
        out.push('ИТОГ (check): ' + (allOk ? 'все эндпоинты доступны' : 'есть недоступные эндпоинты'));
        return { text: out.join('\n'), exitCode: allOk ? 0 : 1 };
    }
    out.push('ИТОГ: ' + (red === 0 ? 'red-блоков нет (green/flagged/skip/hitl — см. выше)' : 'есть ' + red + ' RED-блок(ов) → баг-тикет, НЕ чинить в ходе RES-01'));
    return { text: out.join('\n'), exitCode: red === 0 ? 0 : 1 };
}

// ────────────────────────────────────────────────────────────────────────────
// Тонкое live-провожирование (fetch/docker) — не unit-тестится, покрывается live.
// ────────────────────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    } finally {
        clearTimeout(timer);
    }
}

async function httpProbe(url) {
    try {
        const r = await fetchWithTimeout(url);
        const body = await r.text().catch(() => '');
        return { status: r.status, body, reachable: true };
    } catch (error) {
        return { status: 0, body: '', reachable: false, detail: String((error && error.message) || error) };
    }
}

// (в) scrape: запрос к Prometheus + parse + evaluate.
async function runScrape(promBase) {
    const base = promBase.replace(/\/$/, '');
    const url = base + '/api/v1/query?' + new URLSearchParams({ query: 'up{job="neurocenter"}' });
    const probe = await httpProbe(url);
    if (!probe.reachable) return { block: 'scrape', status: 'red', lines: ['scrape: Prometheus недоступен на ' + base + ' (' + probe.detail + ')'] };
    let json;
    try {
        json = JSON.parse(probe.body);
    } catch {
        return { block: 'scrape', status: 'red', lines: ['scrape: Prometheus вернул не-JSON: ' + probe.body.slice(0, 120)] };
    }
    const ev = evaluateScrape(parsePromQuery(json));
    return { block: 'scrape', status: ev.status, lines: ev.lines };
}

// (з) health: /ready на таргетах + статическая SEMANTICS.
async function runHealth({ apiBase, readyTargets }) {
    const lines = [];
    const probes = [];
    const api = apiBase.replace(/\/$/, '');
    // Всегда пробовать nginx /ready (единственный наружный /ready).
    const nginxReady = await httpProbe(api + '/ready');
    probes.push({ name: 'nginx /ready (' + api + '/ready)', status: nginxReady.status, body: nginxReady.body });
    for (const t of readyTargets) {
        const p = await httpProbe(t.url + (t.url.endsWith('/ready') ? '' : '/ready'));
        probes.push({ name: t.name, status: p.status, body: p.body });
    }
    const ev = evaluateHealth(probes);
    lines.push(...ev.lines);
    if (!readyTargets.length) lines.push('  (прямые /ready таргетов не заданы — только nginx; для per-target задайте NEURO_E2E_READY_TARGETS или пробуйте из backend-сети, см. ранбук)');
    // Статическая SEMANTICS down-ветки (503 + checks).
    let semantics;
    try {
        const readinessSrc = await readFile(path.join(root, 'services/shared/readiness.cjs'), 'utf8');
        const controllerSrcs = {};
        for (const svc of ['api-gateway']) {
            const f = path.join(root, 'services', svc, 'src', 'app.controller.ts');
            try {
                controllerSrcs[svc] = await readFile(f, 'utf8');
            } catch {
                /* нет контроллера */
            }
        }
        semantics = healthSemanticsFromSource(readinessSrc, controllerSrcs);
    } catch (error) {
        semantics = { status: 'red', lines: ['  SEMANTICS: не удалось прочитать код ready-бюджетов: ' + String((error && error.message) || error)] };
    }
    lines.push('  — SEMANTICS (down-ветка 503 + checks):');
    lines.push(...semantics.lines);
    let status = 'green';
    if (ev.status === 'red') status = 'red';
    else if (semantics.status === 'red') status = 'red';
    return { block: 'health', status, lines };
}

// (д) correlation: запрос через nginx + grep логов (docker compose logs).
// envFile (NEURO_E2E_COMPOSE_ENV_FILE): compose нужно интерполировать ${NEUROCENTER_RELEASE} и
// прочие required-переменные, чтобы разрешить сервисы; без env-файла `compose logs` не находит
// ни одного сервиса (live-стенд хранит их в отдельном .env, не в shell-окружении).
function dockerComposeLogs(workdir, project = 'neurocenter-production', envFile = '') {
    return new Promise((resolve) => {
        const chunks = [];
        let done = false;
        const finish = (code) => {
            if (done) return;
            done = true;
            resolve({ code, text: chunks.join('') });
        };
        try {
            const composeArgs = ['compose', '-f', 'compose.production.yml', '-p', project];
            if (envFile) composeArgs.push('--env-file', envFile);
            composeArgs.push('logs', '--no-color', '--tail', '2000');
            const child = spawn('docker', composeArgs, {
                cwd: workdir,
            });
            child.stdout.on('data', (d) => chunks.push(d));
            child.stderr.on('data', (d) => chunks.push(d));
            child.on('error', () => finish(127));
            child.on('close', (code) => finish(code ?? 1));
            setTimeout(() => finish(124), 15000);
        } catch {
            finish(127);
        }
    });
}

async function runCorrelation({ apiBase, correlationId, correlationPath, correlationTicket, composeProject, composeEnvFile }) {
    const api = apiBase.replace(/\/$/, '');
    const requestId = correlationId || genRequestId();
    const lines = ['  requestId=' + requestId + ' path=' + correlationPath];
    // Запрос через nginx с X-Request-ID.
    let reqStatus = 0;
    try {
        const r = await fetchWithTimeout(api + correlationPath, { headers: { 'x-request-id': requestId } });
        reqStatus = r.status;
        await r.body?.cancel().catch(() => {});
    } catch (error) {
        return { block: 'correlation', status: 'red', lines: [...lines, '  запрос через nginx не удался: ' + String((error && error.message) || error)] };
    }
    lines.push('  HTTP-статус запроса: ' + reqStatus);
    // Логи (docker compose logs) → поиск нашего запроса в access-логе nginx.
    const logs = await dockerComposeLogs(root, composeProject, composeEnvFile);
    if (logs.code === 127) {
        return { block: 'correlation', status: 'hitl', lines: [...lines, '  docker недоступен — correlation требует live-стека (HITL): пробуйте вручную, см. ранбук'] };
    }
    const allLines = logs.text.split('\n');
    // D8/тикет 24: nginx перезаписывает клиентский X-Request-ID своим $request_id (AD-O2),
    // поэтому клиентский id в логах не найти. Нашу строку ищем в access-логе по пути
    // (log_format neurocenter = JSON: {"requestId","path",...}; путь mcp-host/m/:ticket
    // маскируется map $masked_uri → /api/mcp-host/m/REDACTED, AD-O8), берём последнюю;
    // effective id — nginx'овский из этой строки, а не клиентский.
    const candidatePaths = [correlationPath];
    if (correlationPath.startsWith('/api/mcp-host/m/')) candidatePaths.push('/api/mcp-host/m/REDACTED');
    let accessLine = null;
    for (const l of allLines) {
        const p = nginxAccessPath(l);
        if (p !== null && candidatePaths.includes(p)) accessLine = l;
    }
    let effectiveId = requestId;
    if (accessLine) {
        const nginxId = nginxAccessRequestId(accessLine);
        if (nginxId) {
            effectiveId = nginxId;
            if (nginxId !== requestId) lines.push('  nginx переопределил id (AD-O2): в логах ' + nginxId + ' (клиентский id не ищем)');
        }
    } else {
        lines.push('  строка запроса (path=' + correlationPath + ') в access-логе nginx не найдена — остаёмся на клиентском id');
    }
    const hit = allLines.filter((l) => l.includes(effectiveId));
    // Прикидка слоёв по префиксу/ключевым словам (nginx: "requestId", gateway/service: service=...).
    const nginx = hit.filter((l) => /"requestId"|requestId=/.test(l) && !/service=/.test(l));
    const gateway = hit.filter((l) => /api-gateway|gateway/i.test(l));
    const service = hit.filter((l) => /catalog-service|skills-service|rag-sync-service|feature-flags-service|oauth2-bridge/i.test(l));
    const ev = correlationEvaluate({ requestId: effectiveId, logs: { nginx: nginx.length ? nginx : hit, gateway, service }, ticket: correlationTicket || undefined });
    lines.push(...ev.lines);
    return { block: 'correlation', status: ev.status, lines };
}

// D8/тикет 24: поля JSON-строки nginx access-лога (log_format neurocenter).
function nginxAccessRequestId(line) {
    const m = String(line).match(/"requestId"\s*:\s*"([0-9a-fA-F]{32})"/);
    return m ? m[1] : null;
}
function nginxAccessPath(line) {
    const m = String(line).match(/"path"\s*:\s*"([^"]*)"/);
    return m ? m[1] : null;
}

// nginx $request_id — 32 hex (без дефисов); совместимо с isRequestId (6.6).
function genRequestId() {
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 32; i += 1) s += hex[Math.floor(Math.random() * 16)];
    return s;
}

// (г) alerts: чтение alerts.jsonl + evaluate.
async function runAlerts({ alertsFile, expectedNames }) {
    let text;
    try {
        text = await readFile(alertsFile, 'utf8');
    } catch (error) {
        return { block: 'alerts', status: 'red', lines: ['alerts: файл ' + alertsFile + ' недоступен: ' + String((error && error.message) || error)] };
    }
    const parsed = parseAlertsJsonl(text);
    const ev = evaluateAlerts(parsed, expectedNames);
    const lines = ['  alertsFile=' + alertsFile, ...ev.lines];
    return { block: 'alerts', status: ev.status, lines };
}

// --check: доступность prom/api/alerts-file.
async function runCheck({ prom, api, alertsFile }) {
    const probes = [];
    const base = prom.replace(/\/$/, '');
    const p = await httpProbe(base + '/api/v1/query?' + new URLSearchParams({ query: 'up' }));
    probes.push({ name: 'prometheus ' + base + '/api/v1/query', reachable: p.reachable, detail: p.reachable ? 'HTTP ' + p.status : p.detail });
    const a = await httpProbe(api.replace(/\/$/, '') + '/ready');
    probes.push({ name: 'api ' + api.replace(/\/$/, '') + '/ready', reachable: a.reachable, detail: a.reachable ? 'HTTP ' + a.status : a.detail });
    let fileOk = false;
    let fileDetail = '';
    try {
        await access(alertsFile);
        fileOk = true;
        fileDetail = 'существует';
    } catch (error) {
        fileDetail = String((error && error.message) || error);
    }
    probes.push({ name: 'alerts file ' + alertsFile, reachable: fileOk, detail: fileDetail });
    const ev = evaluateCheck(probes);
    return { block: 'check', status: ev.status, lines: ev.lines };
}

// ────────────────────────────────────────────────────────────────────────────
// main.
// ────────────────────────────────────────────────────────────────────────────
function helpText() {
    return [
        'RES-01 e2e-драйвер (автоматизируемые блоки live-приёмки).',
        '',
        'Использование:',
        '  node scripts/test/res-01-e2e.mjs --blocks scrape,health,correlation,alerts',
        '  node scripts/test/res-01-e2e.mjs --blocks alerts --expect NeurocenterStackDown,NeurocenterDiskSpaceLow',
        '  node scripts/test/res-01-e2e.mjs --check',
        '',
        'Блоки: scrape (в), health (з), correlation (д), alerts (г).',
        'Env: NEURO_E2E_PROMETHEUS, NEURO_E2E_API, NEURO_E2E_ALERTS_FILE,',
        '      NEURO_E2E_READY_TARGETS, NEURO_E2E_CORRELATION_ID/PATH/TICKET.',
        'Ранбук: docs/res-01-acceptance.md. Протокол: tickets/epic-res-obs/RES-01-protocol.md.',
    ].join('\n');
}

async function main() {
    const argv = process.argv.slice(2);
    let args;
    try {
        args = parseArgs(argv);
    } catch (error) {
        process.stderr.write('Ошибка аргументов: ' + String((error && error.message) || error) + '\n\n' + helpText() + '\n');
        process.exit(2);
    }
    if (args.help) {
        process.stdout.write(helpText() + '\n');
        process.exit(0);
    }
    let results;
    if (args.check) {
        results = [await runCheck({ prom: args.prom, api: args.api, alertsFile: args.alertsFile })];
    } else {
        if (!args.blocks.length) {
            process.stderr.write('Укажите --blocks (scrape,health,correlation,alerts) или --check.\n\n' + helpText() + '\n');
            process.exit(2);
        }
        results = [];
        for (const b of args.blocks) {
            if (b === 'scrape') results.push(await runScrape(args.prom));
            else if (b === 'health') results.push(await runHealth({ apiBase: args.api, readyTargets: args.readyTargets }));
            else if (b === 'correlation') results.push(await runCorrelation({ apiBase: args.api, correlationId: args.correlationId, correlationPath: args.correlationPath, correlationTicket: args.correlationTicket, composeProject: args.composeProject, composeEnvFile: args.composeEnvFile }));
            else if (b === 'alerts') results.push(await runAlerts({ alertsFile: args.alertsFile, expectedNames: args.expect }));
        }
    }
    const report = buildReport(results, { check: args.check });
    process.stdout.write(report.text + '\n');
    process.exit(report.exitCode);
}

// Запуск только при прямом вызове (импорт в тесты не триггерит main).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write('res-01-e2e failed: ' + String((error && error.stack) || error) + '\n');
        process.exit(1);
    });
}
