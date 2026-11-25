#!/usr/bin/env node
/**
 * TRUST-01 (эпик 2, entry 14): e2e-приёмка устройственного канала и каталога — driver T1–T7.
 *
 * Связывает «устройство → gateway → catalog → контракт» на production-стеке (12 сервисов,
 * production-nginx с маскированием/лестницами, --pull never, validateProduction) — то, чего
 * не доказывали изолированные сьюты 2.1–2.13. Аналог REL-01 для эпика 2.
 *
 * Режимы (гейт = наличие --candidate; под `node --test` доп. флаги не доходят до argv):
 *   node --test scripts/test/trust-device-e2e.test.mjs --static-only
 *     → БЕЗ docker: T5-static (completeness/лестницы/body-инварианты/error-body + ceiling-identity
 *       на коде кандидата). Без --candidate статика — режим по умолчанию (безопасный дефолт).
 *   node scripts/test/trust-device-e2e.test.mjs --candidate <commit>
 *     → полный live: сверка HEAD == кандидат, build+up production-стека, T1–T7, teardown.
 *       Жёсткий docker (build+up 12 сервисов) — HITL H2; запускать при load < 6 (sequential).
 *
 * Переиспользует инфраструктуру production-stack.mjs (не переписывает её):
 *   configureProduction/composeEnvironment из ../production/configuration.mjs;
 *   паттерны request()/docker()/dockerRaw()/login и compose-override (frontend-порты,
 *   blitz-fixture, oauth2 CA) повторяются здесь для самостоятельности driver'а.
 * Scripted device-клиент — по паттерну mcp-host-access-http.test.mjs (без реального устройства, OQ1):
 *   packRuntime → импорт в каталог операторским CLI (compose cp + exec) → карточка → назначение →
 *   device-строка (в БД только sha256(token), NFR-2) → connect → билет → канал.
 *
 * T5-static переиспользует существующие static-тесты как subprocesses (не переписывает):
 *   completeness     — route-policy-completeness.test.mjs (AD-6, entry 8)
 *   лестницы         — deadline-ladders.test.mjs (entry 9)
 *   body             — nginx-edge-invariant.test.mjs (entry 9)
 *   error-body       — error-body-policy.test.mjs (AD-19, entry 10)
 *   ceiling-identity — ceiling-identity.test.mjs (AD-12, pre-гейт T6: dist/shared клиента == services/shared)
 *
 * Т6 live (OQ4): ceiling читается из РАЗВЁРНУТЫХ образов (docker exec) — ловит stale-build.
 *   gateway  — require('/repo/services/shared/runtime-artifacts.cjs').CEILING (server-verify);
 *   клиент   — require dist/shared/runtime-artifacts.cjs в образе rag-sync-service;
 *   fallback — при MODULE_NOT_FOUND (documented gap 3629dc7e: asset-contract вне closure моста) —
 *              byte-identity dist/shared клиента и /repo/services/shared + ceiling gateway.
 *
 * Отчёт: <stage>/trust-device-e2e.json (кандидат, режим, compose-проект, T1–T7, liveRun).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import https from 'node:https';
import { configureProduction, composeEnvironment } from '../production/configuration.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;
const NPM = path.join(path.dirname(NODE), 'npm');
const argv = process.argv;
const staticOnly = argv.includes('--static-only');
const candidateArg = argv.includes('--candidate') ? argv[argv.indexOf('--candidate') + 1] : undefined;
const liveMode = !staticOnly && candidateArg !== undefined;

const stage = path.resolve(root, process.env.NEUROCENTER_TEST_EVIDENCE || '.run/trust-device-e2e');
const reportPath = path.join(stage, 'trust-device-e2e.json');

const report = {
    candidate: candidateArg ?? null,
    mode: liveMode ? 'live' : 'static-only',
    composeProject: null,
    checkedAt: null,
    liveRun: liveMode ? { status: 'pending' } : { status: 'not-run', reason: 'static-only mode (без --candidate)' },
    phases: {},
};

function record(id, ok, detail = {}) {
    report.phases[id] = { status: ok ? 'pass' : 'fail', ...detail };
    console.log((ok ? '  OK   ' : '  FAIL ') + id);
}
function recordSkip(id, reason) {
    report.phases[id] = { status: 'skip', reason };
}
function shell(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, {
        cwd: options.cwd || root,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
        timeout: options.timeout || 300000,
        env: options.env || process.env,
    });
    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    return { status: result.status ?? -1, output, error: result.error };
}

// ============================================================================
// T5-STATIC: gateway-политики на коде кандидата, БЕЗ docker.
// ============================================================================
const STATIC_SUBTESTS = [
    ['T5.completeness', 'route-policy completeness (AD-6, entry 8)', 'route-policy-completeness.test.mjs'],
    ['T5.ladders', 'deadline ladders (entry 9)', 'deadline-ladders.test.mjs'],
    ['T5.body-invariants', 'nginx body invariants (entry 9)', 'nginx-edge-invariant.test.mjs'],
    ['T5.error-body', 'error-body policy (AD-19, entry 10)', 'error-body-policy.test.mjs'],
    ['T5.ceiling-identity', 'ceiling identity AD-12 (pre-гейт T6)', 'ceiling-identity.test.mjs'],
];

function isDistFresh(service) {
    return shell(NODE, ['scripts/workspace/dist-freshness.mjs', '--check', service]).status === 0;
}
function ensureServiceBuilt(service) {
    if (isDistFresh(service)) return false;
    const result = shell(NPM, ['run', 'build'], {
        cwd: path.join(root, service),
        timeout: 12 * 60 * 1000,
        env: { ...process.env, PATH: path.dirname(NODE) + path.delimiter + (process.env.PATH || '') },
    });
    if (result.status !== 0) throw new Error('build ' + service + ' не удался:\n' + result.output.slice(-4000));
    return true;
}
function runNodeTest(file) {
    const result = shell(NODE, ['--test', path.join('scripts', 'test', file)], { timeout: 240000 });
    return { pass: result.status === 0, exitCode: result.status, output: result.output };
}

test('T5-static: gateway-политики (completeness/лестницы/body/error-body/ceiling-identity) на коде кандидата', (t) => {
    let builds = {};
    t.test(
        'build-on-stale: gateway + asset-sync (completeness/error-body/ceiling-identity требуют свежей сборки)',
        () => {
            builds = {
                'api-gateway': ensureServiceBuilt('services/api-gateway'),
                'neurocenter-asset-sync': ensureServiceBuilt('mcp/neurocenter-asset-sync'),
            };
            record('T5.build', true, builds);
        },
    );
    for (const [id, label, file] of STATIC_SUBTESTS) {
        t.test(label, () => {
            const r = runNodeTest(file);
            record(id, r.pass, { file, exitCode: r.exitCode, ...(r.pass ? {} : { tail: r.output.slice(-2000) }) });
            assert.ok(r.pass, `${label}: exit ${r.exitCode}\n${r.output.slice(-4000)}`);
        });
    }
});

// ============================================================================
// LIVE-инфраструктура (production-стек; паттерн production-stack.mjs).
// Заполняется в before() только когда liveMode.
// ============================================================================
const live = {};
let liveOk = false;

function composeArgs(l) {
    return [
        'compose',
        '--project-name',
        l.project,
        '--project-directory',
        root,
        '--env-file',
        path.join(l.directory, 'config/.env'),
        '-f',
        'compose.production.yml',
        '-f',
        l.override,
    ];
}
function docker(l, args, extraEnv = {}) {
    const result = shell('docker', [...composeArgs(l), ...args], {
        env: { ...composeEnvironment(), ...extraEnv },
        timeout: args[0] === 'build' ? 30 * 60 * 1000 : 240000,
    });
    if (args[0] === 'build') writeFileSync(path.join(stage, 'build.log'), result.output, { mode: 0o600 });
    if (result.status !== 0)
        throw new Error('Docker ' + args.slice(0, 3).join(' ') + ':\n' + result.output.slice(-4000));
    return result.output.trim();
}
/** Compose-команда, которая может закончиться ненулевым кодом (T6 fallback, негативные ветки). */
function dockerAllowFail(l, args) {
    const result = shell('docker', [...composeArgs(l), ...args], {
        env: composeEnvironment(),
        timeout: 120000,
    });
    return { status: result.status ?? -1, output: result.output.trim() };
}
function dockerRaw(l, args) {
    const result = shell('docker', args, { timeout: 120000 });
    if (result.status !== 0)
        throw new Error('docker ' + args.slice(0, 3).join(' ') + ':\n' + result.output.slice(-4000));
    return result.output.trim();
}
/** SQL-инлайн параметра psql: строка в одинарных кавычках (экранирование ' → ''), число/NULL как есть. */
function sqlValue(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return "'" + String(value).replace(/'/g, "''") + "'";
}
/** psql-запрос к контейнеру postgres (админская роль nc_owner, как в production-stack.mjs).
 *  psql -Atc не знает $N-параметров: параметры инлайнятся безопасно (sqlValue). */
function query(l, database, sql, params = []) {
    const inlined = sql.replace(/\$(\d+)/g, (whole, digits) => {
        const position = Number(digits);
        assert.ok(position >= 1 && position <= params.length, 'query: параметр $' + position + ' вне списка');
        return sqlValue(params[position - 1]);
    });
    assert.ok(!/\$\d+/.test(inlined), 'query: неиспользованные параметры: ' + inlined);
    return docker(l, [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'nc_owner',
        '-d',
        database,
        '-v',
        'ON_ERROR_STOP=1',
        '-Atc',
        inlined,
    ]);
}

let liveCookie = '';
async function panelRequest(l, url, options = {}) {
    const target = new URL(url, 'https://panel.test');
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: '127.0.0.1',
                port: target.hostname === 'blitz.test' ? 18444 : 18443,
                servername: target.hostname,
                ca: l.ca,
                path: target.pathname + target.search,
                method: options.method || 'GET',
                headers: {
                    Host: target.hostname,
                    // channel/device-запросы (без cookie) помечаются явно; panel-API — с сессией.
                    ...(options.noCookie ? {} : { Cookie: liveCookie }),
                    ...(body
                        ? {
                              'Content-Type': 'application/json',
                              'Content-Length': Buffer.byteLength(body),
                              'X-Neurocenter-Request': '1',
                              Origin: 'https://panel.test',
                          }
                        : {}),
                    ...options.headers,
                },
            },
            (res) => {
                let text = '';
                res.on('data', (chunk) => (text += chunk));
                res.on('end', () => {
                    let data;
                    try {
                        data = JSON.parse(text);
                    } catch {
                        data = text;
                    }
                    resolve({ status: res.statusCode, headers: res.headers, data });
                });
            },
        );
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('panel timeout')));
        if (body) req.write(body);
        req.end();
    });
}

/**
 * MCP-канал (StreamableHTTP): Accept application/json, text/event-stream; ответ может быть
 * JSON или SSE (строки data:) — разбираем оба. Без cookie: канал живёт только на билете.
 */
async function channelRequest(l, url, body) {
    const text = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: '127.0.0.1',
                port: 18443,
                servername: 'panel.test',
                ca: l.ca,
                path: url,
                method: 'POST',
                headers: {
                    Host: 'panel.test',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(text),
                    Accept: 'application/json, text/event-stream',
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => (raw += chunk));
                res.on('end', () => {
                    let data;
                    if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
                        const events = raw
                            .split('\n')
                            .filter((line) => line.startsWith('data:'))
                            .map((line) => line.slice(5).trim())
                            .filter(Boolean);
                        try {
                            data = events.length ? JSON.parse(events[events.length - 1]) : raw;
                        } catch {
                            data = raw;
                        }
                    } else {
                        try {
                            data = JSON.parse(raw);
                        } catch {
                            data = raw;
                        }
                    }
                    resolve({ status: res.statusCode, headers: res.headers, data });
                });
            },
        );
        req.on('error', reject);
        req.setTimeout(45000, () => req.destroy(new Error('channel timeout')));
        req.write(text);
        req.end();
    });
}

/** Полный HTTPS-поток Blitz с PKCE → admin-сессия (cookie bridge_session).
 *  Копия канонического логина production-stack.mjs (включая .split(';')[0]). */
async function loginAdmin(l) {
    const login = await panelRequest(l, '/auth/login?returnTo=%2Fprojects');
    assert.equal(login.status, 302, 'login не уводит в IdP');
    const state = login.headers['set-cookie'].find((item) => item.startsWith('oauth_state='));
    assert.ok(state, 'нет oauth_state cookie');
    liveCookie = state.split(';')[0];
    const authorize = await panelRequest(l, login.headers.location);
    assert.equal(authorize.status, 302, 'authorize не уводит в IdP');
    const callback = await panelRequest(l, authorize.headers.location);
    assert.equal(callback.status, 302, 'callback не возвращает на панель');
    liveCookie = callback.headers['set-cookie'].find((item) => item.startsWith('bridge_session=')).split(';')[0];
    assert.ok(liveCookie, 'нет bridge_session после callback');
    const me = await panelRequest(l, '/auth/me');
    assert.equal(me.status, 200, 'auth/me после логина');
    assert.equal(me.data.user.activeRole, 'Главный админ', 'логин не как Главный админ');
}

/**
 * Scripted device-клиент (OQ1), полный паттерн mcp-host-access-http.test.mjs:
 * packRuntime → импорт архива в каталог (операторский CLI в контейнере) → проект →
 * член (auto-provisioning platform_users) → hosted-mcp карточка → назначение (pin) →
 * package?version=1 → device-строка (token известен, в БД sha256(token); NFR-2).
 * Возвращает { projectId, cardId, token, pkg, descriptorSha256, deviceId }.
 */
async function seedScriptedDevice(l) {
    const { packRuntime } = await import('../catalog-plugins/pack.mjs');
    const gatewayRequire = createRequire(new URL('../services/api-gateway/package.json', import.meta.url));
    const { hostRuntimeTarget } = gatewayRequire('./dist/features/mcp-host/host-target.js');

    const temporary = path.join(l.directory, 'device-fixture');
    await mkdir(temporary, { recursive: true });
    const source = path.join(temporary, 'host-source');
    await mkdir(source);
    const code =
        `const r=require('node:readline').createInterface({input:process.stdin});let calls=0;` +
        `r.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;` +
        `const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'trust-qa',version:'1'}}` +
        `:q.method==='tools/list'?{tools:[{name:'trust_read',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,destructiveHint:false}}]}` +
        `:q.method==='tools/call'?{content:[{type:'text',text:'trust call '+(++calls)}]}:{};` +
        `process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`;
    await writeFile(path.join(source, 'server.cjs'), code);
    const archive = path.join(temporary, 'host.tar.gz');
    const descriptor = await packRuntime({
        directory: source,
        archivePath: archive,
        target: hostRuntimeTarget(),
        entrypoint: 'server.cjs',
    });
    const descriptorFile = path.join(temporary, 'descriptor.json');
    await writeFile(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 });

    // Импорт одобренного артефакта в каталог операторским CLI (compose cp + exec,
    // CATALOG_PG_URL_FILE из env контейнера; код архива не исполняется).
    docker(l, ['cp', archive, 'catalog-service:/tmp/trust-host.tar.gz']);
    docker(l, ['cp', descriptorFile, 'catalog-service:/tmp/trust-host-descriptor.json']);
    const imported = docker(l, [
        'exec',
        '-T',
        'catalog-service',
        'node',
        '/repo/services/catalog-service/dist/runtime-artifacts/import.cli.js',
        '/tmp/trust-host.tar.gz',
        '/tmp/trust-host-descriptor.json',
    ]);
    const importedJson = imported.slice(imported.lastIndexOf('\n{'));
    assert.ok(importedJson.includes('"ok":true'), 'импорт runtime-артефакта в каталог: ' + imported.slice(-800));

    const created = await panelRequest(l, '/api/projects', { method: 'POST', body: { name: 'TRUST-01 device QA' } });
    assert.equal(created.status, 201, 'создание проекта для device QA');
    const projectId = created.data.id;

    // Device-пользователь — член проекта (role 2 = developer гейт mcp-host);
    // ensureProjectUser автоматически provision'ит platform_users.
    const member = await panelRequest(l, `/api/projects/${projectId}/members`, {
        method: 'POST',
        body: { principalName: 'dev-trust-qa@example.test', role: 'Разработчик' },
    });
    assert.ok([200, 201].includes(member.status), 'добавление device-члена: ' + JSON.stringify(member.data));

    const card = await panelRequest(l, '/api/ai-plugins', {
        method: 'POST',
        body: {
            name: 'TRUST-01 Hosted QA',
            kind: 'mcp',
            description: 'TRUST-01 scripted hosted MCP card',
            config: { transport: 'stdio', args: [], extra: { hostedMcp: true, runtimeArtifacts: [descriptor] } },
        },
    });
    assert.equal(card.status, 201, 'создание hosted-mcp карточки');
    const cardId = card.data.id;

    // Назначение + pin (AD-16: строка ai_plugin_versions существует; pin = approved-снимок).
    const pinned = await panelRequest(l, `/api/projects/${projectId}/assets`, {
        method: 'POST',
        body: { assetId: cardId, assetKind: 'mcp' },
    });
    assert.ok([200, 201].includes(pinned.status), 'назначение/пакет ассета: ' + JSON.stringify(pinned.data));

    // Пакет назначения (версия 1) — descriptorSha256 для сверки клиента (AD-3).
    const pkgResp = await panelRequest(l, `/api/ai-plugins/${cardId}/package?version=1`);
    assert.equal(pkgResp.status, 200, 'пакет версии 1 карточки');
    const pkg = pkgResp.data;

    // Устройство: token = 64 hex (Bearer), в БД — только sha256(token) (fail-closed, NFR-2).
    // Хеш считается на стороне JS (канонический паттерн mcp-host-access-http.test.mjs) —
    // pgcrypto в production-БД не гарантирован.
    // report: protocolVersion 2 + обязательные capability (managed-мост) + binding проекта.
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const deviceId = randomUUID();
    const developerEmail = 'dev-trust-qa@example.test';
    query(
        l,
        'catalog',
        `INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report)
        VALUES($1,$2,'Разработчик','TRUST-01 QA',repeat('f',64),$3,$4)`,
        [
            deviceId,
            developerEmail,
            createHash('sha256').update(token).digest('hex'),
            JSON.stringify({
                protocolVersion: 2,
                capabilities: ['durable-completions', 'managed-installations'],
                bindings: [{ projectId, bindingId: 'a'.repeat(64), valid: true }],
            }),
        ],
    );

    return { projectId, cardId, token, pkg, descriptorSha256: runtimeDescriptorDigest(pkg), deviceId };
}

/** AD-3: тот же алгоритм, что и сервер (canonical descriptor-текст) — клиент и сервер считают одно и то же. */
function runtimeDescriptorDigest(pkg) {
    const artifacts = pkg?.config?.extra?.runtimeArtifacts ?? [];
    const visit = (item) => {
        if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
        if (typeof item === 'number' && Number.isFinite(item)) return item;
        if (Array.isArray(item)) return Array.from(item, visit);
        if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item)))
            return Object.fromEntries(
                Object.keys(item)
                    .sort()
                    .map((key) => [key, visit(item[key])]),
            );
        throw new Error('Descriptor-текст содержит не-JSON значение.');
    };
    return createHash('sha256')
        .update(JSON.stringify(visit(artifacts), null, 2) + '\n')
        .digest('hex');
}

async function bringUpProductionStack() {
    live.project = 'nc-trust-device-' + randomUUID().slice(0, 8);
    const directory = path.join(stage, 'fixture', live.project);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const cert = spawnSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(directory, 'tls.key'),
        '-out',
        path.join(directory, 'tls.crt'),
        '-days',
        '1',
        '-subj',
        '/CN=panel.test',
        '-addext',
        'subjectAltName=DNS:panel.test,DNS:blitz.test,IP:127.0.0.1',
    ]);
    if (cert.status !== 0) throw new Error('Для тестового TLS нужен openssl');
    const config = await configureProduction(
        {
            panelUrl: 'https://panel.test',
            ssoHost: 'https://blitz.test',
            ssoClientId: 'fixture-client',
            ssoClientSecret: 'fixture-only',
            adminEmail: 'admin@example.test',
            release: process.env.NEUROCENTER_TEST_RELEASE || 'trust-20261118',
            tlsCertFile: path.join(directory, 'tls.crt'),
            tlsKeyFile: path.join(directory, 'tls.key'),
        },
        path.join(directory, 'config'),
    );
    // live.directory = корень fixture-проекта: composeArgs читает <dir>/config/.env и
    // секреты из <dir>/config/secrets — configureProduction же пишет прямо в destination
    // (<dir>/config), поэтому корень = родитель config-каталога (D15: первый live-прогон 2026-11-25).
    live.directory = path.dirname(config.directory);
    live.ca = await readFile(path.join(directory, 'tls.crt'));
    // AD-5: секрет хоста mcp-host (HMAC билетов) — fixture-генерация configuration.mjs;
    // driver использует его ТОЛЬКО для подделки валидно-подписанных негативных билетов.
    live.mcpHostSecret = (
        await readFile(path.join(live.directory, 'config', 'secrets', 'mcp_host_secret'), 'utf8')
    ).trim();

    live.override = path.join(directory, 'compose.fixture.yml');
    await writeFile(
        live.override,
        'services:\n' +
            '  frontend:\n' +
            '    ports: !override [127.0.0.1:18080:8080, 127.0.0.1:18443:8443]\n' +
            '  oauth2-bridge:\n' +
            '    environment:\n' +
            '      NODE_EXTRA_CA_CERTS: /fixture/tls.crt\n' +
            `    volumes: ['${directory}/tls.crt:/fixture/tls.crt:ro']\n` +
            '  blitz-fixture:\n' +
            '    image: node:24.22.0-bookworm-slim\n' +
            '    command: [node, /fixture/provider.cjs]\n' +
            '    networks:\n' +
            '      backend:\n' +
            '        aliases: [blitz.test]\n' +
            "    ports: ['127.0.0.1:18444:8443']\n" +
            '    volumes:\n' +
            `      - '${directory}/tls.crt:/fixture/tls.crt:ro'\n` +
            `      - '${directory}/tls.key:/fixture/tls.key:ro'\n` +
            `      - '${root}/scripts/test/blitz-provider.fixture.cjs:/fixture/provider.cjs:ro'\n`,
    );

    // Чистый checkout кандидата: сверка перед сборкой (H1, OQ3: кандидат = commit SHA).
    const head = shell('git', ['rev-parse', 'HEAD']).output.trim();
    assert.equal(head, candidateArg, 'кандидат не совпадает с HEAD: HEAD=' + head + ', кандидат=' + candidateArg);
    report.candidateHead = head;

    docker(live, ['build']);
    docker(live, ['up', '-d', '--wait', 'postgres', 'blitz-fixture']);
    docker(live, ['--profile', 'setup', 'run', '--rm', 'database-init']);
    const first = docker(live, ['--profile', 'setup', 'run', '--rm', 'bootstrap-admin']);
    assert.ok(first.includes('"created":true'), 'bootstrap-admin: первый админ создаётся');
    docker(live, ['up', '-d', '--wait']);

    for (let attempt = 0; attempt < 120; attempt++) {
        try {
            const ready = await panelRequest(live, '/ready');
            if (ready.status === 200) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
    }
    const ready = await panelRequest(live, '/ready');
    assert.equal(ready.status, 200, 'production-стек healthy');

    // Admin-сессия (Blitz PKCE) — до всех panel-API фаз; cookie bridge_session.
    await loginAdmin(live);
}

function tearDownProductionStack() {
    if (!live.project) return;
    try {
        // services.log до down: единственный снимок логов стека (после down контейнеров нет).
        writeFileSync(
            path.join(stage, 'services.log'),
            shell('docker', [...composeArgs(live), 'logs', '--no-color'], { timeout: 120000 }).output,
            { mode: 0o600 },
        );
    } catch (err) {
        console.error('teardown logs:', String(err?.message || err));
    }
    try {
        shell('docker', [...composeArgs(live), 'down', '--volumes', '--remove-orphans'], { timeout: 180000 });
    } catch (err) {
        console.error('teardown:', String(err?.message || err));
    }
    // Убираем только fixture (конфиг с секретами, сертификат, device-fixture);
    // services.log/build.log и отчёт остаются в evidence-каталоге (stage).
    rm(path.join(stage, 'fixture'), { recursive: true, force: true }).catch(() => {});
}

// ============================================================================
// Тикеты: подделка с ВЕРНЫМ HMAC (секрет fixture) для изоляции веток verify (T2).
// ============================================================================
/** Билет с изменёнными claim и ПРАВИЛЬНОЙ подписью (HMAC-SHA256 по base64url-payload,
 *  секрет хоста из fixture-конфига): HMAC-ветка verify проходит, дальше — конкретная ветка. */
function forgeSignedTicket(validTicket, patch) {
    const dot = validTicket.lastIndexOf('.');
    const payload = JSON.parse(Buffer.from(validTicket.slice(0, dot), 'base64url').toString('utf8'));
    const next = Buffer.from(JSON.stringify({ ...payload, ...patch })).toString('base64url');
    const sig = createHmac('sha256', live.mcpHostSecret).update(next).digest('base64url');
    return next + '.' + sig;
}
/** Билет с битой подписью (HMAC-ветка verify: timingSafeEqual не сходится). */
function forgeBadSignature(validTicket) {
    const dot = validTicket.lastIndexOf('.');
    return validTicket.slice(0, dot) + '.' + Buffer.from('0'.repeat(64), 'utf8').toString('base64url');
}

// ============================================================================
// LIVE-фазы T1–T7 (регистрация; пропускаются в статике, выполняются при --candidate).
// Порядок фаз важен: T1–T3 используют живой pin версии 1; T4/T7 — отдельные карточки
// (T4) и activate (T7), не меняющие pin.
// ============================================================================
const liveSkip = !liveMode;
const liveSkipReason = 'live mode только с --candidate <commit>';
const getDevice = () => live.device || (live.device = seedScriptedDevice(live));

test(
    'T1: mcp-host жив — connect→билет→канал 200, shadowing закрыт, билет в nginx-логах маскирован',
    { skip: liveSkip ? liveSkipReason : false },
    async () => {
        assert.ok(liveOk, 'production-стек не поднят: ' + (report.liveRun?.reason || ''));
        const ctx = await getDevice();
        const connect = await panelRequest(live, '/api/mcp-host/connect', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + ctx.token },
            body: { projectId: ctx.projectId, pkg: ctx.pkg },
        });
        assert.equal(connect.status, 200, 'connect device→ticket: ' + JSON.stringify(connect.data));
        assert.ok(
            connect.data.path?.startsWith('/api/mcp-host/m/'),
            'connect возвращает channel-путь (контроллер, не прокси)',
        );
        assert.equal(
            connect.data.descriptorSha256,
            ctx.descriptorSha256,
            'AD-3: descriptorSha256 = sha256 канонического descriptor-текста',
        );
        const ticket = connect.data.path.split('/m/')[1];
        // T1_MCPHOST_LIVE: канал отвечает 200/jsonrpc (initialize) — shadowing закрыт, живёт controller.
        const channel = await channelRequest(live, connect.data.path, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 2, capabilities: {}, clientInfo: { name: 'trust', version: '1' } },
        });
        assert.ok([200, 202].includes(channel.status), 'канал jsonrpc: ' + JSON.stringify(channel.data));
        assert.ok(!channel.data?.error, 'канал без jsonrpc-error: ' + JSON.stringify(channel.data));
        // T1_LOG_MASKED: после запроса m/:ticket в access-log (frontend → /dev/stdout) билета НЕТ, есть REDACTED (AD-O8).
        await new Promise((r) => setTimeout(r, 1500)); // nginx пишет асинхронно
        const accessLog = docker(live, ['logs', 'frontend']);
        assert.ok(accessLog.includes('/api/mcp-host/m/REDACTED'), 'nginx access-log несёт маскированный путь');
        assert.ok(!accessLog.includes(ticket), 'CRIT: сырой билет попал в nginx access-log');
        record('T1_MCPHOST_LIVE', true, { channelStatus: channel.status });
        record('T1_LOG_MASKED', true);
    },
);

test(
    'T2: билет верифицируется — HMAC+exp+claim≤ceiling+claim↔descriptor; retired-версия → отказ',
    { skip: liveSkip ? liveSkipReason : false },
    async () => {
        assert.ok(liveOk, 'production-стек не поднят: ' + (report.liveRun?.reason || ''));
        const ctx = await getDevice();
        const connect = await panelRequest(live, '/api/mcp-host/connect', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + ctx.token },
            body: { projectId: ctx.projectId, pkg: ctx.pkg },
        });
        assert.equal(connect.status, 200, 'connect для T2');
        const ticket = connect.data.path.split('/m/')[1];
        // T2_VERIFY_OK: канал с валидным билетом отвечает (HMAC+exp+claim≤ceiling+descriptorSha256).
        const ok = await channelRequest(live, connect.data.path, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.ok([200, 202].includes(ok.status), 'T2_VERIFY_OK: канал с валидным билетом: ' + JSON.stringify(ok.data));
        record('T2_VERIFY_OK', true, { status: ok.status });
        // T2_CEILING: Валидно-подписанный билет с compressedBytes > CEILING → 401:
        // HMAC-ветка проходит (подпись правильная), отказ — именно ceiling-проверка verify.
        const ceilingCeil = 1024 ** 3; // interim ceiling (контракт 1.3.0, AD-12: single source)
        const badCeiling = forgeSignedTicket(ticket, { compressedBytes: ceilingCeil + 1 });
        const ceiling = await channelRequest(live, '/api/mcp-host/m/' + badCeiling, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
        });
        assert.equal(ceiling.status, 401, 'T2_CEILING: claim > ceiling → 401 (недействителен)');
        record('T2_CEILING', true);
        // T2_HMAC (отдельная ветка verify): битая подпись → 401 (timingSafeEqual не сходится).
        const badSig = forgeBadSignature(ticket);
        const hmac = await channelRequest(live, '/api/mcp-host/m/' + badSig, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
        });
        assert.equal(hmac.status, 401, 'T2_HMAC: битая подпись → 401');
        record('T2_HMAC', true);
        // T2_RETIRED: retired-версия → connect/authorize отказ (retire-gate AD-16).
        const retiredCard = await panelRequest(live, '/api/ai-plugins', {
            method: 'POST',
            body: {
                name: 'TRUST-01 Retire QA',
                kind: 'mcp',
                description: 'qa retired card',
                config: {
                    transport: 'stdio',
                    args: [],
                    extra: { hostedMcp: true, runtimeArtifacts: ctx.pkg.config.extra.runtimeArtifacts },
                },
            },
        });
        assert.equal(retiredCard.status, 201, 'retire QA card');
        const rid = retiredCard.data.id;
        const rAssign = await panelRequest(live, `/api/projects/${ctx.projectId}/assets`, {
            method: 'POST',
            body: { assetId: rid, assetKind: 'mcp' },
        });
        assert.ok([200, 201].includes(rAssign.status), 'назначение retire-карточки: ' + JSON.stringify(rAssign.data));
        const retiredPkg = (await panelRequest(live, `/api/ai-plugins/${rid}/package?version=1`)).data;
        const retiredRetire = await panelRequest(live, `/api/ai-plugins/${rid}/versions/1/retire`, { method: 'POST' });
        assert.equal(retiredRetire.status, 201, 'retire версии retire-карточки');
        const retiredConnect = await panelRequest(live, '/api/mcp-host/connect', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + ctx.token },
            body: { projectId: ctx.projectId, pkg: retiredPkg },
        });
        assert.equal(retiredConnect.status, 403, 'T2_RETIRED: connect отозванной версии → 403');
        record('T2_RETIRED', true);
    },
);

test(
    'T3: отзыв — TTL 24h (claim exp), re-check ≤60s (кэш), пул-квоты (skip), pids/non-root',
    { skip: liveSkip ? liveSkipReason : false },
    async () => {
        assert.ok(liveOk, 'production-стек не поднят: ' + (report.liveRun?.reason || ''));
        const ctx = await getDevice();
        // T3_TTL: claim exp = issuance + 24h (HOSTED_MCP_TTL_MS, ticket.ts).
        const connect = await panelRequest(live, '/api/mcp-host/connect', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + ctx.token },
            body: { projectId: ctx.projectId, pkg: ctx.pkg },
        });
        const ticket = connect.data.path.split('/m/')[1];
        const claim = JSON.parse(Buffer.from(ticket.split('.').at(0), 'base64url').toString('utf8'));
        const age = claim.exp - Date.now();
        assert.ok(age > 23 * 3600 * 1000 && age <= 24 * 3600 * 1000, 'T3_TTL: claim exp ≈ 24h, получено ' + age + 'ms');
        record('T3_TTL', true, { ageMs: age });
        // T3_CACHE (OQ2: wall-clock): кэш re-check фиксированного TTL 60s (compose без AUTHZ_TTL env).
        // Последовательность: канал (кэш set) → отзыв device в БД → немедленный запрос ПО КЭШУ (200) →
        // poll до 403 (кэш протух, re-check видит отзыв) → elapsed ≤ ~65s → восстановление.
        const warm = await channelRequest(live, connect.data.path, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.ok([200, 202].includes(warm.status), 'T3_CACHE: до отзыва канал работает');
        const cacheSetAt = Date.now();
        query(live, 'catalog', 'UPDATE bridge_devices SET revoked=true WHERE id=$1', [ctx.deviceId]);
        try {
            const cached = await channelRequest(live, connect.data.path, {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            });
            assert.ok(
                [200, 202].includes(cached.status),
                'T3_CACHE: запрос в свежем окне кэша проходит (кэш не обновляется хитом): ' +
                    JSON.stringify(cached.data),
            );
            // Poll: re-check не чаще, чем раз в 3s; 403 придёт, когда now - cacheSetAt ≥ TTL (≤60s).
            let denied = null;
            const deadline = Date.now() + 75000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 3000));
                const probe = await channelRequest(live, connect.data.path, {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/list',
                });
                if (probe.status === 403) {
                    denied = probe;
                    break;
                }
                assert.ok(
                    [200, 202].includes(probe.status),
                    'T3_CACHE: до протухания кэша канал жив (получено ' + probe.status + ')',
                );
            }
            assert.ok(
                denied,
                'T3_CACHE: после протухания кэша (≤60s) — отказ 403, получен: ' + JSON.stringify(denied?.data),
            );
            const elapsed = Date.now() - cacheSetAt;
            assert.ok(elapsed <= 65000, 'T3_CACHE: окно отзыва ≤ TTL+запас (wall ' + elapsed + 'ms)');
            record('T3_CACHE', true, { wallMs: elapsed, firstPassInWindow: true });
        } finally {
            query(live, 'catalog', 'UPDATE bridge_devices SET revoked=false WHERE id=$1', [ctx.deviceId]);
        }
        // T3_PIDS_NROOT: docker inspect api-gateway → pids_limit + non-root user (entry 6, AD-4).
        const inspected = JSON.parse(dockerRaw(live, ['inspect', live.project + '-api-gateway-1']));
        const pids = inspected[0]?.HostConfig?.PidsLimit;
        const user = inspected[0]?.Config?.User || 'root';
        assert.ok(Number.isInteger(pids) && pids > 0 && pids <= 512, 'T3_PIDS: pids_limit задан, получен ' + pids);
        assert.ok(user !== 'root' && !user.startsWith('0'), 'T3_NROOT: api-gateway non-root, user=' + user);
        record('T3_PIDS_NROOT', true, { pids, user });
        // T3_POOL: квота MAX_HOSTS — усиленный live-прогон (H2): требует N+1 хостов, не в базовом гейте.
        recordSkip('T3_POOL', 'квота MAX_HOSTS — усиленный live-прогон (H2); требует N+1 хостов');
    },
);

test(
    'T4: retire необратим — назначение/запуск/verify отказ; аудит security_events; провенанс сохранён',
    { skip: liveSkip ? liveSkipReason : false },
    async () => {
        assert.ok(liveOk, 'production-стек не поднят: ' + (report.liveRun?.reason || ''));
        const ctx = await getDevice(); // ctx СНАЧАЛА: T4-карточка переиспользует его runtimeArtifacts
        const card = await panelRequest(live, '/api/ai-plugins', {
            method: 'POST',
            body: {
                name: 'TRUST-01 Retire T4',
                kind: 'mcp',
                description: 'qa retire card (T4)',
                config: {
                    transport: 'stdio',
                    args: [],
                    extra: { hostedMcp: true, runtimeArtifacts: ctx.pkg.config.extra.runtimeArtifacts },
                },
            },
        });
        assert.equal(card.status, 201, 'retire T4 card');
        const rid = card.data.id;
        // Назначение ДО отзыва (после отзыва назначение → 409, T4_IRREVERSIBLE ниже).
        const assignBefore = await panelRequest(live, `/api/projects/${ctx.projectId}/assets`, {
            method: 'POST',
            body: { assetId: rid, assetKind: 'mcp' },
        });
        assert.ok(
            [200, 201].includes(assignBefore.status),
            'назначение до отзыва: ' + JSON.stringify(assignBefore.data),
        );
        const pkg = (await panelRequest(live, `/api/ai-plugins/${rid}/package?version=1`)).data;
        // T4: первый retire → 201.
        const retire1 = await panelRequest(live, `/api/ai-plugins/${rid}/versions/1/retire`, { method: 'POST' });
        assert.equal(retire1.status, 201, 'T4: первый retire → 201');
        // T4_IRREVERSIBLE: повторный retire → 409 (retired→active запрещено).
        const retire2 = await panelRequest(live, `/api/ai-plugins/${rid}/versions/1/retire`, { method: 'POST' });
        assert.equal(retire2.status, 409, 'T4_IRREVERSIBLE: повторный retire → 409');
        // Новое назначение отозванной карточки → 409.
        const assignAfter = await panelRequest(live, `/api/projects/${ctx.projectId}/assets`, {
            method: 'POST',
            body: { assetId: rid, assetKind: 'mcp' },
        });
        assert.equal(assignAfter.status, 409, 'T4_IRREVERSIBLE: новое назначение retired → 409');
        record('T4_IRREVERSIBLE', true);
        // Запуск/verify: connect с retired-пакетом → 403 (retire-gate AD-16).
        const retiredConnect = await panelRequest(live, '/api/mcp-host/connect', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + ctx.token },
            body: { projectId: ctx.projectId, pkg },
        });
        assert.equal(retiredConnect.status, 403, 'T4: connect retired-версии → 403');
        // Аудит: ровно одна запись security_events action='plugin.version.retire' на cardId:1.
        const events = JSON.parse(
            query(
                live,
                'catalog',
                `SELECT COALESCE(json_agg(json_build_object('actor',actor,'resource_id',resource_id)),'[]')
             FROM security_events WHERE action='plugin.version.retire' AND resource_id=$1`,
                [rid + ':1'],
            ),
        );
        assert.equal(events.length, 1, 'T4_RETIRE: ровно один security_event на retire: ' + JSON.stringify(events));
        // Провенанс сохранён: версия видна (status=retired), package?version=1 отдаёт байты.
        const versions = (await panelRequest(live, `/api/ai-plugins/${rid}/versions`)).data;
        assert.equal(versions[0].status, 'retired', 'T4_RETIRE: статус retired виден');
        const pkgAfter = await panelRequest(live, `/api/ai-plugins/${rid}/package?version=1`);
        assert.equal(pkgAfter.status, 200, 'T4_RETIRE: провенанс (байты) сохранён');
        record('T4_RETIRE', true, { actor: events[0].actor });
    },
);

test(
    'T5-live: 40MB blob upload проходит (не 413 глубоко); upstream 5xx — static',
    { skip: liveSkip ? liveSkipReason : false },
    async () => {
        assert.ok(liveOk, 'production-стек не поднят: ' + (report.liveRun?.reason || ''));
        const ctx = await getDevice();
        // T5_BODY_40MB: реальная content-маршрут (snapshotContentRoute):
        // PUT /api/projects/:key/snapshot-uploads/<uuid>/blobs/<64hex>. nginx server-level
        // client_max_body_size 50m (8g — только /api/asset-sources/archive): 40MB < 50m → тело
        // доходит до catalog, который отвечает бизнес-ошибкой (400/404/409), а НЕ 413.
        const sid = randomUUID();
        const sha = 'b'.repeat(64);
        const buffer = Buffer.alloc(40 * 1024 * 1024, 1);
        const res = await new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: '127.0.0.1',
                    port: 18443,
                    servername: 'panel.test',
                    ca: live.ca,
                    path: `/api/projects/${ctx.projectId}/snapshot-uploads/${sid}/blobs/${sha}`,
                    method: 'PUT',
                    headers: {
                        Host: 'panel.test',
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': buffer.length,
                        Cookie: liveCookie,
                        'X-Neurocenter-Request': '1',
                        Origin: 'https://panel.test',
                    },
                },
                (r) => {
                    let n = 0;
                    r.on('data', (c) => (n += c.length));
                    r.on('end', () => resolve({ status: r.statusCode, n }));
                },
            );
            req.on('error', reject);
            req.setTimeout(60000, () => req.destroy(new Error('upload timeout')));
            req.write(buffer);
            req.end();
        });
        assert.ok(res.status < 413, 'T5_BODY_40MB: 40MB upload не 413 (статус ' + res.status + ')');
        record('T5_BODY_40MB', true, { status: res.status });
        // T5_ERROR_BODY: транспортный 5xx — покрывается static error-body-policy.test.mjs (T5.error-body);
        // live-инжект upstream-отказа — усиленный прогон (H2).
        recordSkip(
            'T5_ERROR_BODY',
            'транспортный 5xx — покрывается static error-body-policy (T5.error-body); live-инжект — H2',
        );
    },
);

test(
    'T6: identity — ceiling у bridge-клиента (развёрнутый) == server-verify (развёрнутый) (OQ4: из образов)',
    { skip: liveSkip ? liveSkipReason : false },
    async () => {
        assert.ok(liveOk, 'production-стек не поднят: ' + (report.liveRun?.reason || ''));
        // OQ4: значения ceiling читаются из РАЗВЁРНУТЫХ образов (docker exec, SERVICE names) — ловит stale-build.
        const gatewayCeiling = JSON.parse(
            docker(live, [
                'exec',
                '-T',
                'api-gateway',
                'node',
                '-e',
                "process.stdout.write(JSON.stringify(require('/repo/services/shared/runtime-artifacts.cjs').CEILING))",
            ]),
        );
        // Клиент: require dist/shared facade в образе rag-sync-service (мост). Ожидается MODULE_NOT_FOUND
        // (documented gap 3629dc7e: @neurocenter/asset-contract вне production-closure моста).
        const clientRead = dockerAllowFail(live, [
            'exec',
            '-T',
            'rag-sync-service',
            'node',
            '-e',
            "process.stdout.write(JSON.stringify(require('/repo/mcp/neurocenter-asset-sync/dist/shared/runtime-artifacts.cjs').CEILING))",
        ]);
        if (clientRead.status === 0) {
            const clientCeiling = JSON.parse(clientRead.output);
            assert.deepEqual(
                clientCeiling,
                gatewayCeiling,
                'T6_IDENTITY: ceiling bridge-клиент == gateway (развёрнутые образы)',
            );
            record('T6_IDENTITY', true, { ceiling: gatewayCeiling, clientRead: 'direct' });
        } else {
            assert.ok(
                clientRead.output.includes('MODULE_NOT_FOUND'),
                'T6_IDENTITY: клиент-require упал не с MODULE_NOT_FOUND: ' + clientRead.output.slice(-400),
            );
            // Fallback-identity (3629dc7e): byte-identity facade-файлов dist/shared (клиент) и
            // /repo/services/shared (gateway) + ceiling gateway. Byte-равные файлы ⇒ равный CEILING
            // при резольвируемом asset-contract; нерезольвируемость самого контракта у клиента —
            // зафиксированный residual (см. runbook H5).
            const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
            const catFile = (l, service, file) => docker(l, ['exec', '-T', service, 'cat', file]);
            const clientFacade = Buffer.from(
                catFile(live, 'rag-sync-service', '/repo/mcp/neurocenter-asset-sync/dist/shared/runtime-artifacts.cjs'),
            );
            const clientLimits = Buffer.from(
                catFile(live, 'rag-sync-service', '/repo/mcp/neurocenter-asset-sync/dist/shared/runtime/limits.cjs'),
            );
            const gatewayFacade = Buffer.from(
                catFile(live, 'api-gateway', '/repo/services/shared/runtime-artifacts.cjs'),
            );
            const gatewayLimits = Buffer.from(catFile(live, 'api-gateway', '/repo/services/shared/runtime/limits.cjs'));
            assert.equal(
                hash(clientFacade),
                hash(gatewayFacade),
                'T6_IDENTITY fallback: byte-identity runtime-artifacts.cjs',
            );
            assert.equal(
                hash(clientLimits),
                hash(gatewayLimits),
                'T6_IDENTITY fallback: byte-identity runtime/limits.cjs',
            );
            assert.ok(gatewayCeiling.compressedBytes > 0, 'T6_IDENTITY fallback: ceiling gateway читается');
            record('T6_IDENTITY', true, {
                ceiling: gatewayCeiling,
                clientRead: 'fallback-byte-identity',
                residual:
                    '3629dc7e: @neurocenter/asset-contract вне closure моста (client require не резольвится в рантайме)',
            });
        }
    },
);

test(
    'T7: UJ-2 карточка (5 полей провенанса) + immutable-версии + pin-only (API-уровень; UI — HITL H4)',
    { skip: liveSkip ? liveSkipReason : false },
    async () => {
        assert.ok(liveOk, 'production-стек не поднят: ' + (report.liveRun?.reason || ''));
        const ctx = await getDevice(); // переиспользуем device-карточку (не re-seed)
        const versions0 = (await panelRequest(live, `/api/ai-plugins/${ctx.cardId}/versions`)).data;
        const pinnedVersion = ctx.pkg.plugin.version;
        const pinned = versions0.find((v) => v.version === pinnedVersion);
        const pkg = ctx.pkg;
        // T7_CARD: 5 полей — версия + SHA (manifest) + источник + время + издатель (UJ-2, API-уровень).
        const hasVersion = typeof pinned?.version === 'number' && typeof pkg.plugin.version === 'number';
        const hasSha = typeof pkg.manifest?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(pkg.manifest.sha256);
        const hasSource = typeof pinned?.metadata?.origin === 'string' && pinned.metadata.origin.length > 0;
        const hasTime = typeof pinned?.createdAt === 'string' && pinned.createdAt.length > 0;
        const hasPublisher = typeof pinned?.author === 'string' && pinned.author.length > 0;
        assert.ok(hasVersion, 'T7_CARD: версия в карточке');
        assert.ok(hasSha, 'T7_CARD: SHA (manifest.sha256) в пакете');
        assert.ok(hasSource, 'T7_CARD: источник (metadata.origin) в версии');
        assert.ok(hasTime, 'T7_CARD: время (createdAt) в версии');
        assert.ok(hasPublisher, 'T7_CARD: издатель (author) в версии');
        record('T7_CARD', true, {
            version: pinned.version,
            sha: pkg.manifest.sha256,
            source: pinned.metadata.origin,
            time: pinned.createdAt,
            publisher: pinned.author,
        });
        // T7_IMMUTABLE: старый номер версии никогда не переиспользуется (INSERT-only):
        // activate v1 создаёт НОВУЮ версию v2, строка v1 не меняется (createdAt/author сохранены).
        const v1Before = pinned;
        const activate = await panelRequest(live, `/api/ai-plugins/${ctx.cardId}/versions/1/activate`, {
            method: 'POST',
        });
        assert.ok(
            [200, 201].includes(activate.status),
            'T7_IMMUTABLE: activate v1 (rollback-restore): ' + JSON.stringify(activate.data),
        );
        const versions1 = (await panelRequest(live, `/api/ai-plugins/${ctx.cardId}/versions`)).data;
        assert.equal(versions1.length, 2, 'T7_IMMUTABLE: активация создала новую версию (v2)');
        assert.equal(versions1[0].version, 2, 'T7_IMMUTABLE: новая версия = 2 (старый номер не переиспользован)');
        const v1After = versions1.find((v) => v.version === 1);
        assert.equal(v1After.createdAt, v1Before.createdAt, 'T7_IMMUTABLE: строка v1 не изменена (createdAt)');
        assert.equal(v1After.author, v1Before.author, 'T7_IMMUTABLE: строка v1 не изменена (author)');
        record('T7_IMMUTABLE', true, { activateStatus: activate.status });
        // T7_KIT: установка c version/manifest ≠ pin проекта → отказ (pin-only, approvedPackage gate).
        const forged = { ...pkg, plugin: { ...pkg.plugin, version: 999 } };
        const kitDenied = await panelRequest(live, '/api/mcp-host/connect', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + ctx.token },
            body: { projectId: ctx.projectId, pkg: forged },
        });
        assert.ok(
            [403, 409].includes(kitDenied.status),
            'T7_KIT: version ≠ pin → отказ (получено ' + kitDenied.status + ': ' + JSON.stringify(kitDenied.data) + ')',
        );
        record('T7_KIT', true, { status: kitDenied.status });
        // T7_UI: UI-уровень UJ-2 (провенанс-карточка в браузере) — HITL H4.
        recordSkip('T7_UI', 'UI-уровень UJ-2 (провенанс-карточка в браузере) — HITL H4');
    },
);

// ============================================================================
// Hooks: live-подъём (только при --candidate) + запись отчёта.
// ============================================================================
before(async () => {
    if (!liveMode) return;
    try {
        await bringUpProductionStack();
        liveOk = true;
        report.liveRun.status = 'setup-ok';
        report.composeProject = live.project;
    } catch (err) {
        const reason = String(err?.message || err);
        report.liveRun = { status: 'setup-failed', reason };
        console.error('LIVE SETUP FAILED:', reason);
    }
});
after(async () => {
    if (liveMode) {
        if (!liveOk)
            report.liveRun =
                report.liveRun?.status === 'setup-failed'
                    ? report.liveRun
                    : { status: 'not-run', reason: 'static-only / не поднят' };
        await tearDownProductionStack();
    }
    report.checkedAt = new Date().toISOString();
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log('report: ' + reportPath);
});
