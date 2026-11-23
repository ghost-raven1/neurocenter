#!/usr/bin/env node
// RES-01 (epic-res-obs 6.15) — sweep: grep-инвентарь по 8 правилам эпика.
//
//   node scripts/test/res-obs-sweep.mjs
//
// Статический инвентарь (быстрый): ловит «забыли в entry» ДО live-приёмки RES-01.
// Порядок: sweep → fixes → RES-01 (Design Notes: «Sweep перед RES-01»).
//
// Каждый rule = { id, name, pattern/scope, allowlist, verdict }.
// Выход: человекочитаемый отчёт (hits c файлом:строкой + вердикт FIX/ALLOWLIST +
// основание). exit 0 = 0 необъявленных hits, exit 1 = есть необъявленные.
//
// Allowlist ВНУТРИ скрипта с комментариями (зафиксирован, не «терпим молча»):
// каждый ALLOWLIST-hit имеет явное основание. FIX-hit = необъявленная находка → exit 1.
//
// Правила 1 и 2 ПОВТОРЯЮТ паттерны и allowlist-механику drift-тестов 6.6/6.7
// (logging.test.mjs / redaction-drift.test.mjs) — чтобы не дублировать ложные
// срабатывания: тот же scope, те же исключения, тот же strip-комментов. Это единый
// скрипт-инвентарь, НЕ отдельный tooling-тест (не регистрируется в
// check-tooling-tests.json).
//
// Правила:
//   1. console.* в services/<svc>/src (excl cli, тесты) — allowlist как в 6.6.
//   2. error.message/stack/String(error) в log-вызовах services/<svc>/src — как в 6.7.
//   3. quota-поля (currentBytesLimit/retentionBytesLimit/stagingBytesLimit) без
//      enforcement/чтения: каждое объявленное ограничение сверяется с кодом, который
//      его читает.
//   4. секции RUNTIME_LIMIT_CEILINGS без точки enforcement (runtime-limit-enforcement).
//   5. /health в services/<svc>/src + nginx-шаблоне — ожидается 0 (заменён на /ready).
//   6. сервисы compose.production.yml вне scrape targets prometheus.yml (cross-check
//      в обе стороны; node_exporter/prometheus/alertmanager/alert-receiver — host-жобы).
//   7. root-контейнеры: каждый Dockerfile в services/ обязан иметь USER != 0 до
//      ENTRYPOINT/CMD.
//   8. сервисы compose.production.yml без pids_limit/user в environment-model.json.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ────────────────────────────────────────────────────────────────────────────
// Общие хелперы (повтор из drift-тестов 6.6/6.7 — идентичны, чтобы не дублировать
// ложные срабатывания).
// ────────────────────────────────────────────────────────────────────────────

// Обход *.ts в дереве (рекурсивно).
async function* walkTs(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkTs(full);
        else if (entry.name.endsWith('.ts')) yield full;
    }
}

// Файл в scope drift-правил 1/2: services/<svc>/src, кроме *.cli.ts, тестов
// (*.test.ts/*.spec.ts) и каталога tests. Идентично logging.test.mjs /
// redaction-drift.test.mjs.
function inDriftScope(rel) {
    const name = path.basename(rel);
    if (name.endsWith('.cli.ts')) return false;
    if (name.endsWith('.test.ts') || name.endsWith('.spec.ts')) return false;
    if (rel.split(path.sep).includes('tests')) return false;
    return true;
}

// Удаляет блок- и //-комментарии (кроме :// в URL), чтобы комментарии не считались.
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(?<!:)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

// Аргументы вызова от открывающей скобки до пары закрывающей (строки/шаблоны учитываются).
function captureCallArgs(source, openParenIndex) {
    let depth = 0;
    for (let i = openParenIndex; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === "'" || ch === '"') {
            i += 1;
            while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
            continue;
        }
        if (ch === '`') {
            i += 1;
            while (i < source.length && source[i] !== '`') {
                if (source[i] === '\\') i += 1;
                else if (source[i] === '$' && source[i + 1] === '{') {
                    let templateDepth = 1;
                    i += 2;
                    while (i < source.length && templateDepth > 0) {
                        if (source[i] === '{') templateDepth += 1;
                        else if (source[i] === '}') templateDepth -= 1;
                        i += 1;
                    }
                    i -= 1;
                }
                i += 1;
            }
            continue;
        }
        if (ch === '(') depth += 1;
        else if (ch === ')') {
            depth -= 1;
            if (depth === 0) return source.slice(openParenIndex + 1, i);
        }
    }
    return source.slice(openParenIndex + 1);
}

// Классификация hit: allowlist (по file, опц. line) → ALLOWLIST, иначе FIX.
function classify(file, line, snippet, allowlist) {
    const allow = allowlist[file];
    if (allow && (allow === true || (Array.isArray(allow) && allow.includes(line)) || typeof allow === 'string')) {
        const reason = typeof allow === 'string' ? allow : 'allowlist: ' + file + (Array.isArray(allow) ? ':' + line : '');
        return { file, line, snippet, verdict: 'ALLOWLIST', reason };
    }
    return { file, line, snippet, verdict: 'FIX', reason: 'необъявленный hit (allowlist не покрывает)' };
}

// ────────────────────────────────────────────────────────────────────────────
// Правило 1: console.* в services/<svc>/src (excl cli, тесты).
// Паттерн и allowlist-механика — как в logging.test.mjs (6.6).
// ────────────────────────────────────────────────────────────────────────────
const CONSOLE_PATTERN = /console\.(?:log|error|warn|info)\(/;
// Allowlist console.* в services/<svc>/src. Пуст: drift-тест 6.6 фиксирует 0 вне
// исключений (cli/тесты), и sweep повторяет тот же scope — новых console.* нет.
// Если появится — либо fix (через shared-логгер 6.6), либо явная запись здесь.
const RULE1_ALLOWLIST = Object.freeze({});

async function rule1_console() {
    const hits = [];
    let checked = 0;
    const servicesDir = path.join(root, 'services');
    for (const svc of await readdir(servicesDir)) {
        const srcDir = path.join(servicesDir, svc, 'src');
        const st = await stat(srcDir).catch(() => null);
        if (!st || !st.isDirectory()) continue;
        for await (const file of walkTs(srcDir)) {
            const rel = path.relative(root, file);
            if (!inDriftScope(rel)) continue;
            checked += 1;
            const stripped = stripComments(await readFile(file, 'utf8'));
            stripped.split('\n').forEach((line, i) => {
                if (!CONSOLE_PATTERN.test(line)) return;
                hits.push(classify(rel, i + 1, line.trim(), RULE1_ALLOWLIST));
            });
        }
    }
    return { id: 1, name: 'console.* в services/<svc>/src (excl cli/тесты)', checked, hits };
}

// ────────────────────────────────────────────────────────────────────────────
// Правило 2: passthrough error-полей в log-вызовах services/<svc>/src.
// Паттерны — как в redaction-drift.test.mjs (6.7): CALL_SITES + PASSTHROUGH +
// captureCallArgs. Allowlist AD-O8 = name/code/causeCode (применяет shared-логгер).
// ────────────────────────────────────────────────────────────────────────────
const LOG_METHODS = '(?:log|error|warn|info|debug|fatal|trace)';
const CALL_SITES = new RegExp(
    [
        `\\bconsole\\.${LOG_METHODS}\\s*\\(`,
        `\\b(?:this\\.)?(?:log|logger)\\.${LOG_METHODS}\\s*\\(`,
        `\\bLogger\\.${LOG_METHODS}\\s*\\(`,
    ].join('|'),
    'g',
);
const PASSTHROUGH = [
    /(?:(?:error|err|e)\s+as\s+[^)\n]*\)|\b(?:error|err|e)\b)\s*\??\.(?:message|stack)\b/,
    /\bString\(\s*\b(?:error|err|e)\b\s*\)/,
];
// Allowlist passthrough error-полей в log-вызовах. Пуст: drift-тест 6.7 фиксирует 0
// вне исключений (cli/тесты), sweep повторяет тот же scope. Новый passthrough → fix
// (log.error('msg', { err }) — allowlist AD-O8 наводит shared-логгер) или явная запись.
const RULE2_ALLOWLIST = Object.freeze({});

function findPassthroughInSource(rel, source) {
    const stripped = stripComments(source);
    const offenders = [];
    CALL_SITES.lastIndex = 0;
    let match;
    while ((match = CALL_SITES.exec(stripped)) !== null) {
        const openParen = stripped.indexOf('(', match.index + match[0].length - 1);
        const args = captureCallArgs(stripped, openParen);
        if (PASSTHROUGH.some((pattern) => pattern.test(args))) {
            offenders.push({ file: rel, line: lineOf(stripped, match.index) });
        }
    }
    return offenders;
}

async function rule2_errorMessage() {
    const hits = [];
    let checked = 0;
    const servicesDir = path.join(root, 'services');
    for (const svc of await readdir(servicesDir)) {
        const srcDir = path.join(servicesDir, svc, 'src');
        const st = await stat(srcDir).catch(() => null);
        if (!st || !st.isDirectory()) continue;
        for await (const file of walkTs(srcDir)) {
            const rel = path.relative(root, file);
            if (!inDriftScope(rel)) continue;
            checked += 1;
            for (const off of findPassthroughInSource(rel, await readFile(file, 'utf8'))) {
                hits.push(classify(off.file, off.line, '', RULE2_ALLOWLIST));
            }
        }
    }
    return { id: 2, name: 'error.message/stack/String(error) в log-вызовах services/<svc>/src', checked, hits };
}

// ────────────────────────────────────────────────────────────────────────────
// Правило 3: quota-поля без enforcement/чтения.
// Объявленные лимиты (projects.quota, *Limit): каждое должно читаться кодом, который
// его применяет/отдаёт (quota-usage → quota-guard decideQuota / in-process admission).
// Поле, объявленное но нигде не читаемое = дефект (лимит не работает).
// ────────────────────────────────────────────────────────────────────────────
const QUOTA_LIMIT_FIELDS = Object.freeze(['currentBytesLimit', 'retentionBytesLimit', 'stagingBytesLimit']);
// Файлы-декларации (typedef/default/validation) — не считаются «чтением».
const QUOTA_DECL_FILES = new Set([
    'services/catalog-service/src/catalog/dto.ts',
    'services/catalog-service/src/catalog/project-quota.ts',
    'services/catalog-service/src/catalog/project-validation.ts',
]);
// Allowlist quota-полей, осознанно без enforcement. Пуст: все три *Limit читаются
// (quota-usage.service.ts отдаёт их enforcement-точкам; snapshot-repository.ts
// применяет stagingBytesLimit in-process). Поле в allowlist = явный остаток с причиной.
const RULE3_ALLOWLIST = Object.freeze({});

async function rule3_quotaFields() {
    const findings = [];
    const servicesDir = path.join(root, 'services');
    for (const field of QUOTA_LIMIT_FIELDS) {
        const reads = [];
        const decls = [];
        for (const svc of await readdir(servicesDir)) {
            const srcDir = path.join(servicesDir, svc, 'src');
            const st = await stat(srcDir).catch(() => null);
            if (!st || !st.isDirectory()) continue;
            for await (const file of walkTs(srcDir)) {
                const rel = path.relative(root, file);
                const base = path.basename(rel);
                if (rel.split(path.sep).includes('tests')) continue;
                if (base.endsWith('.test.ts') || base.endsWith('.spec.ts')) continue;
                const isDecl = QUOTA_DECL_FILES.has(rel);
                const lines = stripComments(await readFile(file, 'utf8')).split('\n');
                lines.forEach((line, i) => {
                    if (!line.includes(field)) return;
                    // В файле-декларации: строка типа `field: number;` или элемент
                    // списка `'field',` — это декларация, не чтение.
                    if (isDecl) {
                        if (new RegExp(field + '\\s*:\\s*(?:number|0)\\b').test(line)) {
                            decls.push(rel + ':' + (i + 1));
                            return;
                        }
                        if (new RegExp("['\"]?" + field + "['\"]?,\\s*$").test(line.trim())) {
                            decls.push(rel + ':' + (i + 1));
                            return;
                        }
                    }
                    reads.push(rel + ':' + (i + 1));
                });
            }
        }
        const exempt = RULE3_ALLOWLIST[field];
        const verdict = reads.length > 0 ? 'OK' : exempt ? 'ALLOWLIST' : 'FIX';
        const reason =
            reads.length > 0
                ? 'читается: ' + reads.slice(0, 4).join(', ') + (reads.length > 4 ? ', …' : '')
                : exempt
                  ? exempt
                  : 'объявленное quota-поле без enforcement/чтения (declarations: ' + (decls.join(', ') || '—') + ')';
        findings.push({ file: '(field ' + field + ')', line: 0, snippet: 'reads=' + reads.length + ' decls=' + decls.length, verdict, reason, info: true });
        if (verdict === 'FIX' || verdict === 'ALLOWLIST') {
            findings.push({ file: '(quota field ' + field + ')', line: 0, snippet: field, verdict, reason });
        }
    }
    return {
        id: 3,
        name: 'quota-поля (*Limit) без enforcement/чтения',
        checked: QUOTA_LIMIT_FIELDS.length,
        hits: findings.filter((f) => !f.info),
        info: findings.filter((f) => f.info),
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Правило 4: секции RUNTIME_LIMIT_CEILINGS без точки enforcement.
// Data-driven: набор секций определяет CEILINGS; каждая обязана быть в
// ENFORCEMENT_POINTS (или в ENFORCEMENT_EXEMPTIONS с причиной) — как в
// runtime-limit-enforcement.cjs (entry 4, AD-1/R11).
// ────────────────────────────────────────────────────────────────────────────

// Топ-уровневые ключи объекта `const NAME = Object.freeze({ ... })` (depth-1 key:).
function topLevelKeysOfFrozen(source, constName) {
    const start = source.indexOf('const ' + constName + ' = Object.freeze(');
    if (start === -1) return [];
    let i = source.indexOf('{', start);
    const open = i;
    let depth = 0;
    const keys = [];
    for (; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) break;
        } else if (depth === 1) {
            const m = /^[A-Za-z_][A-Za-z0-9_$]*\s*:/.exec(source.slice(i, i + 64));
            if (m && (i === open + 1 || /[\n{,]\s*$/.test(source.slice(open, i)))) {
                const key = m[0].split(':')[0].trim();
                if (!keys.includes(key)) keys.push(key);
                i += m[0].length - 1;
            }
        }
    }
    return keys;
}

async function rule4_limitSections() {
    const limitsSrc = await readFile(path.join(root, 'services/shared/runtime-limits.cjs'), 'utf8');
    const enfSrc = await readFile(path.join(root, 'services/shared/runtime-limit-enforcement.cjs'), 'utf8');
    const sections = topLevelKeysOfFrozen(limitsSrc, 'RUNTIME_LIMIT_CEILINGS');
    const points = new Set(topLevelKeysOfFrozen(enfSrc, 'ENFORCEMENT_POINTS'));
    const exemptions = new Set(topLevelKeysOfFrozen(enfSrc, 'ENFORCEMENT_EXEMPTIONS'));
    const hits = [];
    const info = [];
    for (const section of sections) {
        if (points.has(section)) {
            info.push({
                file: 'services/shared/runtime-limit-enforcement.cjs',
                line: 0,
                snippet: 'section=' + section,
                verdict: 'OK',
                reason: 'есть enforcement-точка (ENFORCEMENT_POINTS)',
                info: true,
            });
        } else if (exemptions.has(section)) {
            hits.push({
                file: 'services/shared/runtime-limit-enforcement.cjs',
                line: 0,
                snippet: 'section=' + section,
                verdict: 'ALLOWLIST',
                reason: 'ENFORCEMENT_EXEMPTIONS: осознанно без enforcement-точки (с причиной в shared)',
            });
        } else {
            hits.push({
                file: 'services/shared/runtime-limits.cjs',
                line: 0,
                snippet: 'section=' + section,
                verdict: 'FIX',
                reason: 'секция RUNTIME_LIMIT_CEILINGS без enforcement-точки и без exemption (R11: лимит, который не работает — дефект)',
            });
        }
    }
    return { id: 4, name: 'секции RUNTIME_LIMIT_CEILINGS без точки enforcement', checked: sections.length, hits, info };
}

// ────────────────────────────────────────────────────────────────────────────
// Правило 5: /health в services/<svc>/src + nginx-шаблоне.
// Ожидается 0: /health удалён, заменён на /ready (6.9). Хит = либо fix, либо явный
// exception. Маршрут/прокси на /health — FIX; упоминание в комментарии без allowlist
// — не hit (проза), но показывается в info для прозрачности.
// ────────────────────────────────────────────────────────────────────────────
const HEALTH_TEMPLATE = 'frontend/nginx.production.conf.template';
// Allowlist /health. Пуст: маршрутов /health нет (заменены на /ready, 6.9). Запись
// появляется только для явного exception (например, историческая ссылка в доках).
// Маршрут (@Get('health'), location = /health, proxy на /health) без allowlist — FIX.
const RULE5_ALLOWLIST = Object.freeze({});

function isHealthRoute(line) {
    return (
        /@Get\(\s*['"]health['"]\s*\)/.test(line) ||
        /location\s*[=~ ]*\/health\b/.test(line) ||
        /proxy_pass\s+[^;]*\/health\b/.test(line) ||
        /['"`]\/health['"`]/.test(line)
    );
}

async function rule5_health() {
    const hits = [];
    const info = [];
    let checked = 0;
    const servicesDir = path.join(root, 'services');
    const targets = [];
    for (const svc of await readdir(servicesDir)) {
        const srcDir = path.join(servicesDir, svc, 'src');
        const st = await stat(srcDir).catch(() => null);
        if (!st || !st.isDirectory()) continue;
        for await (const file of walkTs(srcDir)) targets.push(file);
    }
    targets.push(path.join(root, HEALTH_TEMPLATE));
    for (const file of targets) {
        const rel = path.relative(root, file);
        checked += 1;
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((raw, i) => {
            if (!/\/health/.test(raw)) return;
            const line = raw.trim();
            const allow = RULE5_ALLOWLIST[rel];
            if (isHealthRoute(line)) {
                if (allow) hits.push({ file: rel, line: i + 1, snippet: line, verdict: 'ALLOWLIST', reason: allow });
                else hits.push({ file: rel, line: i + 1, snippet: line, verdict: 'FIX', reason: '/health-маршрут: заменён на /ready (6.9)' });
            } else {
                info.push({ file: rel, line: i + 1, snippet: line, verdict: 'OK', reason: 'упоминание (не маршрут)', info: true });
            }
        });
    }
    return { id: 5, name: '/health в services/<svc>/src + nginx-шаблоне (ожидается 0)', checked, hits, info };
}

// ────────────────────────────────────────────────────────────────────────────
// Правило 6: сервисы compose вне scrape targets prometheus.yml (cross-check).
// Scrape-obligated app-сервисы = те, у кого services/<s>/src/main.ts вызывает
// createObservability (монтирует /metrics) и кто в compose. Host-жобы
// (node_exporter, alert-receiver) и prometheus/alertmanager не в job neurocenter.
// ────────────────────────────────────────────────────────────────────────────

// Имена сервисов compose.production.yml (2-пробельный ключ под services:).
function composeServiceNames(yaml) {
    const names = [];
    let inServices = false;
    for (const line of yaml.split('\n')) {
        if (/^services:\s*$/.test(line)) {
            inServices = true;
            continue;
        }
        if (inServices) {
            if (/^[A-Za-z]/.test(line)) break; // конец блока services
            const m = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
            if (m) names.push(m[1]);
        }
    }
    return names;
}

// Таргеты job neurocenter (host:port) из prometheus.yml.
function neurocenterTargets(yaml) {
    const targets = [];
    const jobIdx = yaml.indexOf('job_name: neurocenter');
    if (jobIdx === -1) return targets;
    let end = yaml.length;
    const nextJob = yaml.indexOf('job_name:', jobIdx + 1);
    if (nextJob !== -1) end = nextJob;
    const block = yaml.slice(jobIdx, end);
    const targetsIdx = block.indexOf('targets:');
    if (targetsIdx === -1) return targets;
    for (const line of block.slice(targetsIdx).split('\n')) {
        const m = line.match(/-\s+([A-Za-z0-9_.-]+):(\d+)/);
        if (m) targets.push({ host: m[1], port: Number(m[2]), raw: m[1] + ':' + m[2] });
    }
    return targets;
}

async function rule6_scrapeCoverage() {
    const compose = await readFile(path.join(root, 'compose.production.yml'), 'utf8');
    const prom = await readFile(path.join(root, 'deploy/production/monitoring/prometheus.yml'), 'utf8');
    const composeServices = composeServiceNames(compose);
    const targets = neurocenterTargets(prom);
    const targetHosts = new Set(targets.map((t) => t.host));
    // scrape-obligated: services/<s>/src/main.ts с createObservability.
    const scrapeObligated = [];
    for (const s of composeServices) {
        try {
            const src = await readFile(path.join(root, 'services', s, 'src', 'main.ts'), 'utf8');
            if (src.includes('createObservability')) scrapeObligated.push(s);
        } catch {
            // нет app-исходников — не scrape-obligated
        }
    }
    const hits = [];
    const info = [];
    // (a) таргет → compose: хост таргета обязан быть compose-сервисом.
    for (const t of targets) {
        if (!composeServices.includes(t.host)) {
            hits.push({
                file: 'deploy/production/monitoring/prometheus.yml',
                line: 0,
                snippet: t.raw,
                verdict: 'FIX',
                reason: 'scrape-таргет не соответствует compose-сервису (висячий таргет)',
            });
        }
    }
    // (b) compose → таргеты: каждый scrape-obligated сервис обязан быть в job neurocenter.
    for (const s of scrapeObligated) {
        if (!targetHosts.has(s)) {
            hits.push({
                file: 'compose.production.yml',
                line: 0,
                snippet: s,
                verdict: 'FIX',
                reason: 'scrape-obligated app-сервис (монтирует /metrics) отсутствует в scrape targets prometheus.yml',
            });
        }
        info.push({
            file: 'compose.production.yml',
            line: 0,
            snippet: s,
            verdict: targetHosts.has(s) ? 'OK' : 'FIX',
            reason: targetHosts.has(s) ? 'покрыт job neurocenter' : 'не покрыт',
            info: true,
        });
    }
    // Инфо: compose-сервисы, НЕ scrape-obligated (внешние/host-жобы/one-shot) — не хиты.
    const notObligated = composeServices.filter((s) => !scrapeObligated.includes(s));
    info.push({
        file: 'compose.production.yml',
        line: 0,
        snippet: notObligated.join(', '),
        verdict: 'OK',
        reason: 'не scrape-obligated (внешние образы/host-жобы/one-shot): не ожидаются в job neurocenter',
        info: true,
    });
    return { id: 6, name: 'сервисы compose вне scrape targets prometheus.yml', checked: composeServices.length, hits, info };
}

// ────────────────────────────────────────────────────────────────────────────
// Правило 7: root-контейнеры. Каждый Dockerfile в services/ (+ frontend) обязан иметь
// USER != 0 до ENTRYPOINT/CMD (non-root, AD-OP-6 / entry 1).
// ────────────────────────────────────────────────────────────────────────────

// Разбор Dockerfile: последний USER и стоит ли он до CMD/ENTRYPOINT; USER != root/0.
function analyzeDockerfile(source) {
    const lines = source.split('\n');
    let lastUser = null;
    let lastUserLine = 0;
    let entryLine = 0;
    let entryKind = '';
    for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();
        const userM = t.match(/^USER\s+(.+)$/);
        if (userM) {
            lastUser = userM[1].trim();
            lastUserLine = i + 1;
            continue;
        }
        const entryM = t.match(/^(ENTRYPOINT|CMD)\b/);
        if (entryM && entryLine === 0) {
            entryLine = i + 1;
            entryKind = entryM[1];
        }
    }
    const isRoot = !lastUser || /^(root|0|["']\s*0\s*["'])$/.test(lastUser);
    const userBeforeEntry = entryLine === 0 || lastUserLine < entryLine;
    return { lastUser, lastUserLine, entryLine, entryKind, isRoot, userBeforeEntry };
}

async function rule7_rootContainers() {
    const hits = [];
    const info = [];
    const dockerfiles = [];
    const servicesDir = path.join(root, 'services');
    for (const svc of await readdir(servicesDir)) {
        const df = path.join(servicesDir, svc, 'Dockerfile');
        const st = await stat(df).catch(() => null);
        if (st && st.isFile()) dockerfiles.push(df);
    }
    const fe = path.join(root, 'frontend', 'Dockerfile');
    const feSt = await stat(fe).catch(() => null);
    if (feSt && feSt.isFile()) dockerfiles.push(fe);
    for (const df of dockerfiles) {
        const rel = path.relative(root, df);
        const a = analyzeDockerfile(await readFile(df, 'utf8'));
        if (a.isRoot) {
            hits.push({
                file: rel,
                line: a.lastUserLine || a.entryLine,
                snippet: 'USER=' + (a.lastUser ?? '(нет)'),
                verdict: 'FIX',
                reason: 'Dockerfile без USER!=0 до ENTRYPOINT/CMD (root-контейнер)',
            });
        } else if (!a.userBeforeEntry) {
            hits.push({
                file: rel,
                line: a.lastUserLine,
                snippet: 'USER=' + a.lastUser + ' после ' + a.entryKind,
                verdict: 'FIX',
                reason: 'USER задан после ENTRYPOINT/CMD',
            });
        } else {
            info.push({ file: rel, line: a.lastUserLine, snippet: 'USER=' + a.lastUser, verdict: 'OK', reason: 'non-root USER до ENTRYPOINT/CMD', info: true });
        }
    }
    return { id: 7, name: 'root-контейнеры (Dockerfile services/ + frontend: USER!=0 до ENTRYPOINT/CMD)', checked: dockerfiles.length, hits, info };
}

// ────────────────────────────────────────────────────────────────────────────
// Правило 8: сервисы compose без pids_limit/user в environment-model.json.
// Cross-check по имени сервиса: каждый compose-сервис обязан иметь в модели user +
// pidsLimit (6.2 resource model).
// ────────────────────────────────────────────────────────────────────────────
async function rule8_modelCoverage() {
    const compose = await readFile(path.join(root, 'compose.production.yml'), 'utf8');
    const model = JSON.parse(await readFile(path.join(root, 'deploy/production/environment-model.json'), 'utf8'));
    const composeServices = composeServiceNames(compose);
    const modelServices = model.services || {};
    const hits = [];
    const info = [];
    for (const s of composeServices) {
        const entry = modelServices[s];
        if (!entry) {
            hits.push({ file: 'deploy/production/environment-model.json', line: 0, snippet: s, verdict: 'FIX', reason: 'compose-сервис отсутствует в environment-model.json' });
            continue;
        }
        const missing = [];
        if (entry.user === undefined || entry.user === null || entry.user === '') missing.push('user');
        if (entry.pidsLimit === undefined || entry.pidsLimit === null) missing.push('pidsLimit');
        if (missing.length) {
            hits.push({ file: 'deploy/production/environment-model.json', line: 0, snippet: s, verdict: 'FIX', reason: 'отсутствует в модели: ' + missing.join(', ') });
        } else {
            info.push({
                file: 'deploy/production/environment-model.json',
                line: 0,
                snippet: s + ' (user=' + entry.user + ', pidsLimit=' + entry.pidsLimit + ')',
                verdict: 'OK',
                reason: 'user + pidsLimit заданы',
                info: true,
            });
        }
    }
    return { id: 8, name: 'сервисы compose без pids_limit/user в environment-model.json', checked: composeServices.length, hits, info };
}

// ────────────────────────────────────────────────────────────────────────────
// Оркестрация + отчёт.
// ────────────────────────────────────────────────────────────────────────────
const RULES = [
    [rule1_console, 'console'],
    [rule2_errorMessage, 'error-message'],
    [rule3_quotaFields, 'quota-fields'],
    [rule4_limitSections, 'limit-sections'],
    [rule5_health, 'health'],
    [rule6_scrapeCoverage, 'scrape-coverage'],
    [rule7_rootContainers, 'root-containers'],
    [rule8_modelCoverage, 'model-coverage'],
];

async function main() {
    const results = [];
    for (const [fn, key] of RULES) {
        try {
            results.push(await fn());
        } catch (error) {
            results.push({ id: key, name: key, checked: 0, hits: [], error: String((error && error.message) || error) });
        }
    }

    let undeclared = 0;
    let allowlisted = 0;
    const out = [];
    out.push('RES-01 sweep — grep-инвентарь по 8 правилам эпика (epic-res-obs 6.15)');
    out.push('='.repeat(72));
    for (const r of results) {
        if (r.error) {
            out.push('\n[rule ' + r.id + '] ' + r.name + '\n  ERROR: ' + r.error);
            undeclared += 1;
            continue;
        }
        out.push('\n[rule ' + r.id + '] ' + r.name + '  (проверено: ' + r.checked + ')');
        for (const i of r.info || []) {
            out.push('  (i) ' + i.verdict.padEnd(9) + ' ' + i.file + (i.line ? ':' + i.line : '') + '  ' + i.snippet + '  — ' + i.reason);
        }
        if (!r.hits.length) {
            out.push('  — hits: 0');
            continue;
        }
        for (const h of r.hits) {
            if (h.verdict === 'ALLOWLIST') allowlisted += 1;
            else undeclared += 1;
            out.push('  ' + (h.verdict === 'FIX' ? 'X FIX' : '+ ALLOWLIST') + '  ' + h.file + (h.line ? ':' + h.line : '') + (h.snippet ? '  | ' + h.snippet : ''));
            out.push('          основание: ' + h.reason);
        }
    }
    out.push('='.repeat(72));
    out.push('ИТОГ: необъявленные hits (FIX) = ' + undeclared + '; allowlist = ' + allowlisted + '.');
    out.push(undeclared === 0 ? 'VERDICT: PASS (0 необъявленных hits)' : 'VERDICT: FAIL (есть необъявленные hits — fix или явный allowlist)');

    process.stdout.write(out.join('\n') + '\n');
    process.exit(undeclared === 0 ? 0 : 1);
}

main().catch((error) => {
    process.stderr.write('sweep failed: ' + ((error && error.stack) || error) + '\n');
    process.exit(1);
});
