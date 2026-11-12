import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
    applicationServices,
    composeClient,
    composeConfiguration,
    containers,
    docker,
    maintenanceLock,
    serviceImageIds,
} from '../production/compose-client.mjs';
import {
    assertCleanCheckout,
    buildReleaseManifest,
    gitCommand,
    imagePattern,
    installerTemplates,
    normalizeBuildContext,
    releaseOfEnv,
    supplyInventory,
    validateReleaseManifest,
    verifyReleaseManifest,
    writeReleaseManifest,
} from '../production/release-manifest.mjs';
import { inspectSchemaManifests, runSchemaCommands } from '../production/schema-migrations.mjs';
import { prepareSchemaInitialization } from '../production/schema-initialization.mjs';
import { assertProductionModelKey } from '../production/model-credentials.mjs';
import {
    deadEnvironment,
    loadEnvironmentModel,
    normalizeServices,
    parseComposeDocument,
    parseSecretNames,
    requiredEnvironmentDrift,
    structuralDrift,
} from '../production/environment-model.mjs';
import { withDockerBuildCa } from '../workspace/docker-build-ca.mjs';
import { verifyProductionBridge } from './production-bridge.fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const EVIDENCE_FORMAT = 'neurocenter-release-candidate-e2e-v1';
const LOAD_LIMIT = 8;
const LOAD_POLL_MS = 15000;
// Те же ключи, что в scripts/test/schema-locks-ddl-invariant-db.mjs: check-команды берут свои локи.
const FF_LOCK_KEY = 'neurocenter:feature-flags:migrations';
const CATALOG_LOCK_KEY = 'neurocenter:catalog:migrations';
// Тот же набор, что в scripts/test/tls-global-disable.test.mjs.
const TLS_OFF_PATTERNS = [/NODE_TLS_REJECT_UNAUTHORIZED=0/, /strict-ssl=false/, /rejectUnauthorized:\s*false/];
// Pinned-сервисы F4 (паттерн update.mjs): 7 app + setup-запуски на образе catalog-service.
const PINNED_SERVICES = Object.freeze([
    ...applicationServices,
    'database-init',
    'bootstrap-admin',
    'capacity-collector',
]);
// Сервисы с build-секциями в compose.production.yml (B-вариант: ipv4first-Dockerfile'ы).
const BUILD_SERVICES = Object.freeze([
    'database-init',
    'catalog-service',
    'feature-flags-service',
    'skills-service',
    'rag-sync-service',
    'oauth2-bridge',
    'api-gateway',
    'frontend',
]);
const PANEL_PORT = 19080;
const PANEL_TLS_PORT = 19443;
const BLITZ_PORT = 19444;

/**
 * Приёмка замороженного кандидата REL-01 (entry 1.13): F1–F6 одним драйвером.
 * Live-режим: --candidate <commit> --tag <rel> --manifest <path> --host-variant A|B
 *   + NEUROCENTER_CONFIG_DIR (production-конфиг кандидата). Запуски F2–F5 — HITL,
 *   ранбук docs/release-candidate-e2e.md. Под node --test исполняется offline-блок.
 */

// ============================== Exports (pure) ==============================

export function parseDriverArgs(argv) {
    const args = { candidate: null, tag: null, manifest: null, hostVariant: null };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!['--candidate', '--tag', '--manifest', '--host-variant'].includes(arg))
            throw new Error('Неизвестный аргумент ' + arg + ' (см. usage)');
        const value = argv[i + 1];
        if (value === undefined) throw new Error('Для ' + arg + ' не задано значение');
        i += 1;
        if (arg === '--candidate') {
            if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('--candidate должен быть 40-значным hex-commit');
            args.candidate = value;
        } else if (arg === '--tag') {
            if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) || value === 'latest')
                throw new Error('--tag: некорректная метка релиза');
            args.tag = value;
        } else if (arg === '--manifest') {
            args.manifest = path.resolve(value);
        } else {
            if (!['A', 'B'].includes(value)) throw new Error('--host-variant принимает A или B');
            args.hostVariant = value;
        }
    }
    if (!args.candidate || !args.tag || !args.manifest || !args.hostVariant)
        throw new Error('Live-режим требует --candidate, --tag, --manifest и --host-variant');
    return args;
}

/** F1: тег annotated, manifest.release/commit совпадают с тегом, HEAD == кандидат, дерево чистое. */
export async function checkFrozenCandidate(rootDirectory, args, manifest) {
    const git = (command) => gitCommand(rootDirectory, command);
    const checked = validateReleaseManifest(manifest);
    let tagType;
    try {
        tagType = (await git(['cat-file', '-t', args.tag])).trim();
    } catch {
        throw new Error('F1: тег ' + args.tag + ' не найден в репозитории');
    }
    if (tagType !== 'tag') throw new Error('F1: тег ' + args.tag + ' не annotated (git cat-file -t = ' + tagType + ')');
    if (checked.release !== args.tag)
        throw new Error('F1: manifest.release (' + checked.release + ') не совпадает с тегом ' + args.tag);
    const tagCommit = (await git(['rev-list', '-n1', args.tag])).trim();
    if (checked.commit !== tagCommit)
        throw new Error(
            'F1: manifest.commit (' +
                checked.commit +
                ') не совпадает с коммитом тега ' +
                args.tag +
                ' (' +
                tagCommit +
                ')',
        );
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    if (head !== args.candidate) throw new Error('F1: HEAD (' + head + ') не совпадает с кандидатом ' + args.candidate);
    if (args.candidate !== checked.commit)
        throw new Error(
            'F1: кандидат (' +
                args.candidate +
                ') не является замороженным коммитом манифеста (' +
                checked.commit +
                ')',
        );
    const commit = await assertCleanCheckout(rootDirectory, git);
    if (commit !== head) throw new Error('F1: чистый checkout не подтверждён на HEAD');
    return { commit, tagCommit };
}

/** Канонический SHA256 по 7 image ID + postgres: сравнение повторяемых сборок F3. */
export function manifestCanonicalSha256(manifest) {
    const payload = {
        images: Object.fromEntries(Object.entries(manifest.images).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        postgresImage: manifest.postgresImage,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** F3: две сборки одного commit дают идентичные образы; любой дрейф — явная ошибка по сервису. */
export function compareManifestDigests(manifestA, manifestB) {
    for (const service of applicationServices) {
        if (manifestA.images[service] !== manifestB.images[service])
            throw new Error(
                'F3: образ ' +
                    service +
                    ' расходится между сборками: ' +
                    manifestA.images[service] +
                    ' -> ' +
                    manifestB.images[service],
            );
    }
    if (manifestA.postgresImage !== manifestB.postgresImage)
        throw new Error('F3: postgresImage расходится: ' + manifestA.postgresImage + ' -> ' + manifestB.postgresImage);
    const canonicalSha256 = manifestCanonicalSha256(manifestA);
    if (manifestCanonicalSha256(manifestB) !== canonicalSha256)
        throw new Error('F3: canonicalSha256 расходится между сборками');
    return { identical: true, canonicalSha256 };
}

function shadowServices(services, composeSide) {
    const shadow = {};
    for (const [name, service] of Object.entries(services)) {
        if (composeSide && name === 'blitz-fixture') continue;
        shadow[name] = {
            ...service,
            // Pinned-оверлей заменяет имена образов digest'ами (live F4): поле не сверяется.
            ...(PINNED_SERVICES.includes(name) ? { image: null } : {}),
            // Test-override переносит порты frontend в 19xxx: поле не сверяется.
            ...(name === 'frontend' ? { ports: [] } : {}),
        };
    }
    return shadow;
}

/**
 * F5-static: модель окружения против compose (base + overlays модели + live-оверлеи).
 * overlayDocuments — JS-объекты {services: …} в effective-виде (после !override).
 */
export async function staticDriftReport(rootDirectory, overlayDocuments = []) {
    const model = await loadEnvironmentModel(rootDirectory);
    const documents = [parseComposeDocument(await readFile(path.join(rootDirectory, model.compose.base), 'utf8'))];
    for (const overlay of model.compose.overlays)
        documents.push(parseComposeDocument(await readFile(path.join(rootDirectory, overlay), 'utf8')));
    documents.push(...overlayDocuments);
    const services = normalizeServices(documents);
    const secretNames = await parseSecretNames(rootDirectory);
    const drift = structuralDrift({ services: shadowServices(model.services, false) }, shadowServices(services, true));
    const dead = deadEnvironment(model, services, { root: rootDirectory, secretNames });
    const required = requiredEnvironmentDrift(model, services, { root: rootDirectory, secretNames });
    return {
        drift,
        dead,
        required,
        counts: {
            structural: drift.length,
            dead: dead.dead.length + dead.noteErrors.length,
            required: required.missing.length + required.phantom.length + required.noteErrors.length,
        },
    };
}

/** Live-оверлеи F4/F5 в effective-виде JS-объектов (JSON-overlay + test-override без !override). */
export function liveOverlayDocuments(manifest, { certFile, keyFile, providerFile } = {}) {
    const pinned = {
        services: Object.fromEntries(
            PINNED_SERVICES.map((service) => [
                service,
                { image: manifest.images[applicationServices.includes(service) ? service : 'catalog-service'] },
            ]),
        ),
    };
    const override = {
        services: {
            frontend: { ports: ['127.0.0.1:' + PANEL_PORT + ':8080', '127.0.0.1:' + PANEL_TLS_PORT + ':8443'] },
            'blitz-fixture': {
                image: 'node:24.22.0-bookworm-slim',
                command: 'node /fixture/provider.cjs',
                networks: { backend: { aliases: ['blitz.test'] } },
                ports: ['127.0.0.1:' + BLITZ_PORT + ':443'],
                volumes: [
                    (certFile ?? '/fixture/tls.crt') + ':/fixture/tls.crt:ro',
                    (keyFile ?? '/fixture/tls.key') + ':/fixture/tls.key:ro',
                    (providerFile ?? path.join(root, 'scripts/test/blitz-provider.fixture.cjs')) +
                        ':/fixture/provider.cjs:ro',
                ],
            },
        },
    };
    return [pinned, override];
}

export function validateE2eReport(report) {
    const fail = (message) => {
        throw new Error('F6: ' + message);
    };
    if (!report || typeof report !== 'object' || Array.isArray(report)) fail('отчёт отсутствует');
    if (report.format !== EVIDENCE_FORMAT) fail('format должен быть ' + EVIDENCE_FORMAT);
    if (!/^[a-f0-9]{40}$/.test(report.candidate?.commit ?? '')) fail('candidate.commit — 40-значный hex-commit');
    if (typeof report.candidate?.tag !== 'string' || !report.candidate.tag) fail('candidate.tag отсутствует');
    if (!['A', 'B'].includes(report.hostVariant)) fail('hostVariant должен быть A или B');
    if (!['GO', 'NO-GO'].includes(report.result)) fail('result должен быть GO или NO-GO');
    if (!applicationServices.every((service) => imagePattern.test(report.digests?.images?.[service] ?? '')))
        fail('digests.images: ожидается 7 sha256-образов');
    if (!imagePattern.test(report.digests?.postgresImage ?? '')) fail('digests.postgresImage отсутствует');
    if (!/^[a-f0-9]{64}$/.test(report.digests?.canonicalSha256 ?? '')) fail('digests.canonicalSha256 отсутствует');
    if (!Array.isArray(report.steps) || report.steps.length === 0) fail('steps отсутствуют');
    if (!Array.isArray(report.checks)) fail('checks отсутствуют');
    if (typeof report.startedAt !== 'string' || typeof report.finishedAt !== 'string')
        fail('startedAt/finishedAt отсутствуют');
    return report;
}

/** F6: evidence-запись 0600 в закрытом 0700-каталоге (атомарно, idiom writeReleaseManifest). */
export async function writeE2eReport(stage, report) {
    validateE2eReport(report);
    let info;
    try {
        info = await lstat(stage);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await mkdir(stage, { recursive: true, mode: 0o700 });
        info = await lstat(stage);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
        throw new Error('F6: каталог evidence должен быть закрытым обычным каталогом (0700)');
    const filename = path.join(stage, 'release-candidate-e2e.json');
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
        await rename(temporary, filename);
        const handle = await open(path.dirname(filename), 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
    return filename;
}

// ============================== Live-режим (HITL) ==============================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Load-менеджмент (прецедент 2026-11-06): тяжёлые шаги только при load1 < 8. */
async function waitForLoad(loadHistory, stepName) {
    for (;;) {
        const load1 = os.loadavg()[0];
        loadHistory.push({ at: new Date().toISOString(), step: stepName, load1: Number(load1.toFixed(2)) });
        if (load1 < LOAD_LIMIT) return load1;
        console.log('Load ' + load1.toFixed(2) + ' >= ' + LOAD_LIMIT + ' — жду 15s (шаг ' + stepName + ')');
        await sleep(LOAD_POLL_MS);
    }
}

function envValue(text, name) {
    const match = text.match(new RegExp('^' + name + '=(?:\'([^\'\\r\\n]*)\'|"([^"]*)"|([^\\r\\n#]+))\\r?$', 'm'));
    return match ? (match[1] ?? match[2] ?? match[3]).trim() : undefined;
}

/** Своя копия operator-конфига: повторный run не ломается stale receipt'ом, секреты не трогаются. */
function copyOperatorConfig(operatorDir, copyDir) {
    if (!fs.existsSync(path.join(operatorDir, '.env')))
        throw new Error(
            'NEUROCENTER_CONFIG_DIR (' + operatorDir + ') не содержит .env — см. docs/release-candidate-e2e.md (H2)',
        );
    fs.rmSync(copyDir, { recursive: true, force: true });
    fs.mkdirSync(copyDir, { recursive: true, mode: 0o700 });
    fs.cpSync(operatorDir, copyDir, { recursive: true });
    fs.chmodSync(copyDir, 0o700);
    const secretsDir = path.join(copyDir, 'secrets');
    if (fs.existsSync(secretsDir)) fs.chmodSync(secretsDir, 0o700);
    const envPath = path.join(copyDir, '.env');
    const text = fs.readFileSync(envPath, 'utf8');
    const updated = text.replace(/^NEUROCENTER_CONFIG_DIR=.*/m, "NEUROCENTER_CONFIG_DIR='" + copyDir + "'");
    if (updated === text) throw new Error('В .env кандидата нет строки NEUROCENTER_CONFIG_DIR');
    fs.writeFileSync(envPath, updated, { mode: 0o600 });
}

function assertSupplyAvailable(rootDirectory) {
    const count = (sub) => {
        const directory = path.join(rootDirectory, 'bridge-dist', sub);
        if (!fs.existsSync(directory)) return 0;
        return fs.readdirSync(directory).filter((name) => name.endsWith('.tgz')).length;
    };
    const runtime = count('runtime');
    const opencode = count('opencode');
    if (runtime < 1 || opencode < 1)
        throw new Error(
            'F2: в checkout нет supply-архивов (bridge-dist/runtime: ' +
                runtime +
                ', bridge-dist/opencode: ' +
                opencode +
                '). Сначала `npm run bridge:prepare` в checkout оператора — docs/release-candidate-e2e.md (H1).',
        );
}

/** Supply (runtime/opencode tgz) не в git: клон получает архивы из checkout драйвера. */
function copySupplyArtifacts(rootDirectory, clone) {
    for (const sub of ['runtime', 'opencode']) {
        const source = path.join(rootDirectory, 'bridge-dist', sub);
        const target = path.join(clone, 'bridge-dist', sub);
        fs.mkdirSync(target, { recursive: true });
        for (const name of fs.readdirSync(source)) {
            if (name.endsWith('.tgz') || name.endsWith('.sha256'))
                fs.copyFileSync(path.join(source, name), path.join(target, name));
        }
    }
}

/** B-вариант: ipv4first-Dockerfile'ы после первого FROM, overlay только dockerfile (context/args сохраняются). */
function prepareIpv4FirstOverlay(clone) {
    const target = path.join(clone, 'bridge-dist', 'ipv4first');
    fs.mkdirSync(target, { recursive: true });
    const overlay = { services: {} };
    for (const service of BUILD_SERVICES) {
        const dockerfile =
            service === 'frontend' ? 'frontend/Dockerfile' : path.join('services', service, 'Dockerfile');
        const lines = fs.readFileSync(path.join(clone, dockerfile), 'utf8').split('\n');
        const fromIndex = lines.findIndex((line) => /^FROM /.test(line));
        if (fromIndex < 0) throw new Error('F2-B: в ' + dockerfile + ' нет FROM');
        lines.splice(fromIndex + 1, 0, 'ENV NODE_OPTIONS=--dns-result-order=ipv4first');
        const name = 'Dockerfile.' + service;
        fs.writeFileSync(path.join(target, name), lines.join('\n'));
        overlay.services[service] = { build: { dockerfile: path.join('bridge-dist', 'ipv4first', name) } };
    }
    const file = path.join(target, 'overlay.compose.json');
    fs.writeFileSync(file, JSON.stringify(overlay, null, 2) + '\n');
    return file;
}

/**
 * Compose-клиент клона: production composeClient хардкодит --project-directory в корень репозитория,
 * а build-контекст `context: .` должен оставаться в клоне.
 */
function cloneComposeClient({ clone, projectName, files = [] }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName)) throw new Error('Некорректное имя Compose-проекта');
    const args = [
        'compose',
        '--project-name',
        projectName,
        '--project-directory',
        clone,
        '--env-file',
        path.join(clone, '.env'),
        '-f',
        path.join(clone, 'compose.production.yml'),
        ...files.flatMap((file) => ['-f', path.resolve(file)]),
    ];
    return { projectName, run: (command, options) => docker([...args, ...command], options) };
}

/** captureReleaseActuals из release-manifest.mjs (приватен) — та же опись фактического состояния. */
async function captureActuals(clone, client) {
    const config = await composeConfiguration(client);
    const postgresName = config.services?.postgres?.image;
    if (typeof postgresName !== 'string' || !postgresName)
        throw new Error('F2: в production-профиле отсутствует postgres');
    const nodeExporterName = config.services?.node_exporter?.image;
    if (typeof nodeExporterName !== 'string' || !nodeExporterName)
        throw new Error('F2: в production-профиле отсутствует node_exporter');
    const [images, postgresRaw, nodeExporterRaw] = await Promise.all([
        serviceImageIds(config),
        docker(['image', 'inspect', postgresName]),
        docker(['image', 'inspect', nodeExporterName]),
    ]);
    const postgresImage = JSON.parse(postgresRaw)[0]?.Id;
    if (!imagePattern.test(postgresImage ?? '')) throw new Error('F2: образ postgres не закреплён');
    const nodeExporterImage = JSON.parse(nodeExporterRaw)[0]?.Id;
    if (!imagePattern.test(nodeExporterImage ?? '')) throw new Error('F2: образ node_exporter не закреплён');
    return {
        images,
        postgresImage,
        nodeExporterImage,
        migrations: await inspectSchemaManifests(images, (args) => docker(args)),
        supply: await supplyInventory(clone),
    };
}

/** F2: чистый клон кандидата -> strict-сборка -> манифест -> recheck (capture СРАЗУ: тег общий). */
async function buildCloneRelease({ index, candidate, tag, hostVariant, operatorConfig, stage }) {
    const clone = path.join(stage, 'clone-' + index);
    const configCopy = path.join(stage, 'config-' + index);
    fs.rmSync(clone, { recursive: true, force: true });
    await gitCommand(root, ['clone', '--no-checkout', '--quiet', root, clone]);
    await gitCommand(clone, ['checkout', '--quiet', '--detach', candidate]);
    const commit = await assertCleanCheckout(clone, (args) => gitCommand(clone, args));
    if (commit !== candidate) throw new Error('F2: клон ' + index + ' зафиксирован не на кандидате');
    copyOperatorConfig(operatorConfig, configCopy);
    fs.copyFileSync(path.join(configCopy, '.env'), path.join(clone, '.env'));
    copySupplyArtifacts(root, clone);
    const files = hostVariant === 'B' ? [prepareIpv4FirstOverlay(clone)] : [];
    const client = cloneComposeClient({
        clone,
        projectName: 'nc-rel01-b' + index,
        files,
    });
    const epoch = Number((await gitCommand(clone, ['log', '-1', '--format=%ct', 'HEAD'])).trim());
    await withDockerBuildCa(clone, { ...process.env, NEUROCENTER_TLS_DISABLE: '0' }, async ({ environment }) => {
        await normalizeBuildContext(clone, epoch);
        await client.run(['build'], { inherit: true, environment });
    });
    const actuals = await captureActuals(clone, client);
    const release = releaseOfEnv(await readFile(path.join(clone, '.env'), 'utf8'));
    if (release !== tag)
        throw new Error('F2: NEUROCENTER_RELEASE в конфиге (' + release + ') не совпадает с тегом кандидата ' + tag);
    const manifest = buildReleaseManifest({ commit, release, ...actuals });
    const filename = path.join(configCopy, 'releases', release, 'release-manifest.json');
    await writeReleaseManifest(filename, manifest);
    const mismatches = verifyReleaseManifest(manifest, await captureActuals(clone, client));
    if (mismatches.length > 0)
        throw new Error('F2: верификация манифеста клона ' + index + ' не пройдена:\n- ' + mismatches.join('\n- '));
    return { clone, configCopy, manifest, filename };
}

function e2eOverrideYaml(certFile, keyFile) {
    return [
        'services:',
        '  frontend:',
        '    ports: !override [' + '"127.0.0.1:' + PANEL_PORT + ':8080", "127.0.0.1:' + PANEL_TLS_PORT + ':8443"',
        '  ]',
        '  blitz-fixture:',
        '    image: node:24.22.0-bookworm-slim',
        '    command: [node, /fixture/provider.cjs]',
        '    networks:',
        '      backend:',
        '        aliases: [blitz.test]',
        '    ports: ["127.0.0.1:' + BLITZ_PORT + ':443"]',
        '    volumes:',
        "      - '" + certFile + ":/fixture/tls.crt:ro'",
        "      - '" + keyFile + ":/fixture/tls.key:ro'",
        "      - '" + path.join(root, 'scripts/test/blitz-provider.fixture.cjs') + ":/fixture/provider.cjs:ro'",
        '',
    ].join('\n');
}

/** H2-валидация кандидата: fixture-SSO (blitz-fixture требует точные значения). */
function assertCandidateConfig(configCopy) {
    const text = fs.readFileSync(path.join(configCopy, '.env'), 'utf8');
    const expect = (name, value, why) => {
        const actual = envValue(text, name);
        if (actual !== value)
            throw new Error(
                'F4: ' +
                    name +
                    ' = ' +
                    JSON.stringify(actual ?? null) +
                    ', ожидается ' +
                    JSON.stringify(value) +
                    ' — ' +
                    why,
            );
    };
    expect('SSO_HOST', 'https://blitz.test', 'blitz-fixture живёт под alias blitz.test');
    expect('SSO_CLIENT_ID', 'fixture-client', 'blitz-provider.fixture.cjs сверяет client_id');
    expect('BOOTSTRAP_ADMIN_EMAIL', 'admin@example.test', '/blitz/oauth/me отдаёт sub admin@example.test');
    const certFile = envValue(text, 'TLS_CERT_FILE');
    const keyFile = envValue(text, 'TLS_KEY_FILE');
    if (!certFile || !keyFile || !fs.existsSync(certFile) || !fs.existsSync(keyFile))
        throw new Error('F4: TLS_CERT_FILE/TLS_KEY_FILE из конфига кандидата не найдены');
    const san = childProcess.execFileSync('openssl', ['x509', '-in', certFile, '-noout', '-ext', 'subjectAltName'], {
        encoding: 'utf8',
    });
    for (const entry of ['DNS:panel.test', 'DNS:blitz.test', 'IP:127.0.0.1'])
        assert.ok(san.includes(entry), 'F4: в SAN сертификата нет ' + entry);
    return { certFile, keyFile };
}

/** F4: pinned-оверлей (паттерн update.mjs, без postgres) + closed-loop up и live-сверка. */
async function deployPinned({ manifest, operatorConfig, projectName, stage, record }) {
    const configCopy = path.join(stage, 'config-deploy');
    copyOperatorConfig(operatorConfig, configCopy);
    const { certFile, keyFile } = assertCandidateConfig(configCopy);
    record('F4: кандидат-конфиг: fixture-SSO параметры и SAN сертификата', certFile);
    const releasesDir = path.join(configCopy, 'releases', manifest.release);
    fs.mkdirSync(releasesDir, { recursive: true, mode: 0o700 });
    const pinnedFile = path.join(releasesDir, 'pinned.compose.json');
    fs.writeFileSync(
        pinnedFile,
        JSON.stringify(
            {
                services: Object.fromEntries(
                    PINNED_SERVICES.map((service) => [
                        service,
                        { image: manifest.images[applicationServices.includes(service) ? service : 'catalog-service'] },
                    ]),
                ),
            },
            null,
            2,
        ) + '\n',
        { mode: 0o600 },
    );
    const overrideFile = path.join(configCopy, 'compose.e2e-override.yml');
    fs.writeFileSync(overrideFile, e2eOverrideYaml(certFile, keyFile), { mode: 0o600 });
    const client = composeClient({ directory: configCopy, projectName, files: [pinnedFile, overrideFile] });
    const config = await composeConfiguration(client);
    await maintenanceLock(client, manifest.images['catalog-service'], 'release-candidate-e2e', async () => {
        await client.run(['up', '-d', '--wait', '--no-build', '--pull', 'never', 'postgres'], { inherit: true });
        await client.run(['--profile', 'setup', 'run', '--rm', '--pull', 'never', 'database-init'], { inherit: true });
        const schemas = await runSchemaCommands(client, 'check');
        const initialization = await prepareSchemaInitialization({
            directory: configCopy,
            projectName,
            client,
            config,
            schemas,
        });
        try {
            await runSchemaCommands(initialization?.client ?? client, 'migrate', {
                beforeEach: initialization?.assertCurrent,
            });
            await initialization?.complete();
            record('F4: схемы проверены и миграции применены (check/migrate receipts)');
        } finally {
            await initialization?.close();
        }
        await client.run(['--profile', 'setup', 'run', '--rm', '--pull', 'never', 'bootstrap-admin'], {
            inherit: true,
        });
        await assertProductionModelKey(configCopy, config, (input) =>
            client.run(
                [
                    'exec',
                    '-T',
                    'postgres',
                    'psql',
                    '-X',
                    '-U',
                    'nc_owner',
                    '-d',
                    'catalog',
                    '-v',
                    'ON_ERROR_STOP=1',
                    '-At',
                ],
                { input },
            ),
        );
        record('F4: production model-key привязан к копии конфигурации');
        await client.run(['up', '-d', '--wait', '--no-build', '--pull', 'never', 'capacity-collector'], {
            inherit: true,
        });
        await client.run(['up', '-d', '--wait', '--no-build', '--pull', 'never'], { inherit: true });
    });
    const list = await containers(client);
    const byService = {};
    for (const container of list) byService[container?.Config?.Labels?.['com.docker.compose.service']] = container;
    for (const service of applicationServices) {
        const container = byService[service];
        assert.ok(container, 'F4: нет контейнера ' + service);
        assert.equal(container.State.Status, 'running', 'F4: ' + service + ' не running');
        assert.equal(container.State.Health?.Status, 'healthy', 'F4: ' + service + ' не healthy');
        assert.equal(
            container.Image,
            manifest.images[service],
            'F4: образ ' + service + ' не совпадает с digest из манифеста',
        );
    }
    assert.equal(byService.postgres?.State?.Status, 'running', 'F4: postgres не running');
    assert.equal(byService.postgres?.State?.Health?.Status, 'healthy', 'F4: postgres не healthy');
    assert.equal(byService.postgres.Image, manifest.postgresImage, 'F4: образ postgres не совпадает с манифестом');
    record('F4: 7 app + postgres подняты, healthy, образы = digestы из кандидат-манифеста');
    return { client, configCopy };
}

const PROBE_SCRIPT = [
    "const req = require('https').get({host: 'blitz.test', port: 443, servername: 'blitz.test', path: '/'}, (res) => {",
    "  console.log('STATUS', res.statusCode); res.resume(); res.on('end', () => process.exit(0));",
    '});',
    "req.on('error', (error) => { console.log('REJECT', error.code); process.exit(0); });",
    'setTimeout(() => process.exit(3), 15000);',
].join('\n');

/** F5-live: TLS-полный ассерт, ghost-БД, DDL, lock-независимость. */
async function runF5Live({ client, manifest, record }) {
    const composeText = fs.readFileSync(path.join(root, 'compose.production.yml'), 'utf8');
    for (const pattern of TLS_OFF_PATTERNS) assert.doesNotMatch(composeText, pattern, 'F5: отключение TLS в compose');
    for (const service of applicationServices) {
        const [image] = JSON.parse(await docker(['image', 'inspect', manifest.images[service]]));
        for (const line of image?.Config?.Env ?? [])
            for (const pattern of TLS_OFF_PATTERNS)
                assert.doesNotMatch(line, pattern, 'F5: отключение TLS в env образа ' + service);
    }
    record('F5: absence — ни в compose.production.yml, ни в Config.Env 7 кандидат-образов');
    const list = await containers(client);
    for (const service of applicationServices) {
        const container = list.find((item) => item?.Config?.Labels?.['com.docker.compose.service'] === service);
        const env = container?.Config?.Env ?? [];
        assert.ok(env.includes('NEUROCENTER_TLS_DISABLE=0'), 'F5: ' + service + ' без NEUROCENTER_TLS_DISABLE=0');
        assert.ok(!env.includes('NODE_TLS_REJECT_UNAUTHORIZED=0'), 'F5: ' + service + ' с TLS-off');
    }
    record('F5: живые 7 контейнеров форсируют NEUROCENTER_TLS_DISABLE=0, глобального TLS-off нет');
    const probe = (relaxed) => {
        const args = ['exec', '-T'];
        if (relaxed) args.push('-e', 'NODE_TLS_REJECT_UNAUTHORIZED=0');
        args.push('api-gateway', 'node', '-e', PROBE_SCRIPT);
        return client.run(args);
    };
    assert.match(
        await probe(false),
        /REJECT (SELF_SIGNED|CERT_)/,
        'F5: исходящий вызов на невалидный сертификат не отклонён',
    );
    const relaxed = await probe(true);
    assert.match(relaxed, /STATUS \d{3}/, 'F5: негативный контроль (TLS off) не дошёл до сервера');
    assert.doesNotMatch(relaxed, /REJECT/, 'F5: негативный контроль должен пройти handshake');
    record('F5: исходящий вызов на self-signed отклонён; контроль NODE_TLS_REJECT_UNAUTHORIZED=0 прошёл');
    let diagnostic;
    try {
        await client.run([
            'run',
            '--rm',
            '--no-deps',
            '-T',
            '--read-only',
            '--pull',
            'never',
            '-e',
            'SSO_DISABLE=true',
            '--entrypoint',
            'node',
            'catalog-service',
            '-e',
            'require("/shared/runtime.cjs")',
        ]);
        throw new Error('F5: SSO_DISABLE=true не остановил production-старт');
    } catch (error) {
        if (/не остановил/.test(error?.message ?? '')) throw error;
        diagnostic = error?.diagnostic ?? String(error?.message ?? '');
    }
    assert.match(
        diagnostic,
        /SSO_DISABLE=false обязателен в production/,
        'F5: validateProduction-отказ не подтверждён',
    );
    record('F5: validateProduction — негативный контроль (SSO_DISABLE=true) останавливает production');
    const psql = (database, sql) =>
        client.run(
            ['exec', '-T', 'postgres', 'psql', '-X', '-U', 'nc_owner', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At'],
            { input: sql },
        );
    const databases = (await psql('postgres', 'SELECT datname FROM pg_database ORDER BY 1;'))
        .split('\n')
        .filter(Boolean);
    assert.ok(databases.includes('catalog'), 'F5: нет БД catalog');
    for (const name of databases)
        assert.match(name, /^(catalog|postgres|template0|template1|nc_rag_[0-9a-f]{32})$/, 'F5: ghost-БД ' + name);
    record('F5: базы только catalog/rag-шары/service-локали, ghost-БД skills нет', databases.join(', '));
    const columns = (
        await psql(
            'catalog',
            "SELECT a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull FROM pg_attribute a WHERE a.attrelid = 'security_events'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
        )
    ).split('\n');
    assert.deepEqual(columns, [
        'event_id|uuid|t',
        'actor|text|t',
        'action|text|t',
        'resource_id|text|t',
        'before_state|jsonb|f',
        'after_state|jsonb|f',
        'created_at|timestamp with time zone|t',
    ]);
    assert.equal(
        await psql(
            'catalog',
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'security_events'::regclass AND contype = 'p'",
        ),
        'PRIMARY KEY (event_id)',
    );
    const index = await psql(
        'catalog',
        "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indexrelid = to_regclass('security_events_created') AND i.indrelid = 'security_events'::regclass",
    );
    assert.ok(index.endsWith('USING btree (created_at DESC)'), 'F5: индекс security_events_created: ' + index);
    record('F5: security_events — ровно контракт DDL (7 колонок, PK, DESC-индекс)');
    for (const [lockKey, racingService] of [
        [FF_LOCK_KEY, 'catalog-service'],
        [CATALOG_LOCK_KEY, 'feature-flags-service'],
    ]) {
        const holder = childProcess.spawn(
            'docker',
            [
                'exec',
                '-T',
                'postgres',
                'psql',
                '-X',
                '-U',
                'nc_owner',
                '-d',
                'postgres',
                '-c',
                "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('" +
                    lockKey +
                    "', 0)); SELECT pg_sleep(20); ROLLBACK;",
            ],
            { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        holder.stderr.resume();
        holder.unref();
        await sleep(3000);
        try {
            const output = await client.run([
                'run',
                '--rm',
                '--no-deps',
                '-T',
                '--read-only',
                '--pull',
                'never',
                '--entrypoint',
                'node',
                racingService,
                'dist/database/migrate.cli.js',
                'check',
            ]);
            JSON.parse(output);
        } finally {
            await new Promise((resolve) => (holder.on('close', resolve), holder.unref()));
        }
        let control;
        try {
            await psql(
                'postgres',
                "SET lock_timeout = '2s'; SELECT pg_advisory_xact_lock(hashtextextended('" + lockKey + "', 0));",
            );
            throw new Error('F5: lock-контроль не упёрся в держателя (' + lockKey + ')');
        } catch (error) {
            control = error?.diagnostic ?? String(error?.message ?? '');
            if (/не упёрся/.test(control)) throw error;
            assert.match(control, /lock timeout|55P03/, 'F5: lock-контроль: ' + control);
        }
        record('F5: check-команда работает под чужим advisory-локом; сам лок всё ещё блокирует (' + lockKey + ')');
    }
}

function makeRequest({ ca, session }) {
    return function request(url, options = {}) {
        const target = new URL(url, 'https://panel.test');
        assert.ok(['panel.test', 'blitz.test'].includes(target.hostname), 'H5: хост за пределами замкнутого контура');
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: '127.0.0.1',
                    port: target.hostname === 'blitz.test' ? BLITZ_PORT : PANEL_TLS_PORT,
                    servername: target.hostname,
                    ca,
                    path: target.pathname + target.search,
                    method: options.method || 'GET',
                    headers: {
                        Host: target.hostname,
                        ...(session.cookie && target.hostname === 'panel.test' ? { Cookie: session.cookie } : {}),
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
            req.setTimeout(15000, () => req.destroy(new Error('H5: timeout ' + url)));
            if (body) req.write(body);
            req.end();
        });
    };
}

/** H5: полный PKCE-поток Blitz и мостовые маршруты через настоящий HTTPS gateway. */
async function verifySsoAndBridge({ client, certFile, record }) {
    const ca = fs.readFileSync(certFile);
    const session = { cookie: '' };
    const request = makeRequest({ ca, session });
    const login = await request('/auth/login?returnTo=%2Fprojects');
    assert.equal(login.status, 302, 'H5: /auth/login не перенаправил в SSO');
    session.cookie = (login.headers['set-cookie'].find((item) => item.startsWith('oauth_state=')) ?? '').split(';')[0];
    assert.ok(session.cookie, 'H5: нет oauth_state cookie');
    const authorize = await request(login.headers.location);
    assert.equal(authorize.status, 302, 'H5: blitz-fixture не выдал callback');
    const callback = await request(authorize.headers.location);
    assert.equal(callback.status, 302, 'H5: callback не завершил вход');
    assert.equal(callback.headers.location, 'https://panel.test/projects', 'H5: callback не вернулся в раздел');
    session.cookie = (callback.headers['set-cookie'].find((item) => item.startsWith('bridge_session=')) ?? '').split(
        ';',
    )[0];
    assert.ok(session.cookie, 'H5: нет bridge_session cookie');
    const me = await request('/auth/me');
    assert.equal(me.status, 200, 'H5: /auth/me');
    assert.equal(me.data.user.activeRole, 'Главный админ', 'H5: сессия не main-admin');
    record('H5: полный SSO-поток Blitz (PKCE) возвращает main-admin в исходный раздел');
    await verifyProductionBridge({
        check: async (name, action) => {
            await action();
            record('H5: ' + name);
        },
        request,
        query: (database, sql) =>
            client.run([
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
                sql,
            ]),
    });
}

async function runLive(args) {
    const startedAt = new Date().toISOString();
    const operatorConfig = process.env.NEUROCENTER_CONFIG_DIR;
    if (!operatorConfig)
        throw new Error(
            'Не задан NEUROCENTER_CONFIG_DIR (production-каталог кандидата) — см. docs/release-candidate-e2e.md (H2)',
        );
    const manifest = validateReleaseManifest(JSON.parse(await readFile(args.manifest, 'utf8')));
    const projectName = 'nc-rel01-' + randomUUID().slice(0, 8);
    const stage = path.resolve(root, process.env.NEUROCENTER_TEST_EVIDENCE || '.run/release-candidate-e2e');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const loadHistory = [];
    const steps = [];
    const checks = [];
    let canonicalSha256 = manifestCanonicalSha256(manifest);
    let manifests = { operator: args.manifest };
    let deploy = null;
    const record = (name, evidence = '') => {
        checks.push({ name, ok: true, evidence });
        console.log('OK   ' + name + (evidence ? ' — ' + evidence : ''));
    };
    const step = async (name, action) => {
        console.log('\n== ' + name + ' ==');
        const startedAtMs = Date.now();
        steps.push({ name, startedAt: new Date(startedAtMs).toISOString() });
        try {
            await action();
        } finally {
            const entry = steps[steps.length - 1];
            entry.finishedAt = new Date().toISOString();
            entry.durationMs = Date.now() - startedAtMs;
        }
    };
    let result = 'GO';
    try {
        await step('F1: замороженный кандидат', async () => {
            const { commit } = await checkFrozenCandidate(root, args, manifest);
            record('F1: тег annotated, manifest.release/commit, HEAD == кандидат, дерево чистое', commit.slice(0, 12));
        });
        await step('F2: две чистые последовательные сборки', async () => {
            assertSupplyAvailable(root);
            record('F2: supply-архивы runtime/opencode присутствуют в checkout');
            await waitForLoad(loadHistory, 'F2-clone1-build');
            const first = await buildCloneRelease({
                index: 1,
                candidate: args.candidate,
                tag: args.tag,
                hostVariant: args.hostVariant,
                operatorConfig,
                stage,
            });
            manifests = { ...manifests, clone1: first.filename };
            record('F2-clone1: сборка с чистого клона, манифест записан и сверен', first.filename);
            await waitForLoad(loadHistory, 'F2-clone2-build');
            const second = await buildCloneRelease({
                index: 2,
                candidate: args.candidate,
                tag: args.tag,
                hostVariant: args.hostVariant,
                operatorConfig,
                stage,
            });
            manifests = { ...manifests, clone2: second.filename };
            record('F2-clone2: повторная сборка с чистого клона, манифест записан и сверен', second.filename);
            const comparison = compareManifestDigests(first.manifest, second.manifest);
            canonicalSha256 = comparison.canonicalSha256;
            record('F3: две сборки идентичны', comparison.canonicalSha256);
            for (const service of applicationServices)
                assert.equal(
                    first.manifest.images[service],
                    manifest.images[service],
                    'F2: образ ' + service + ' не воспроизводит операторский кандидат-манифест',
                );
            assert.equal(first.manifest.postgresImage, manifest.postgresImage, 'F2: postgresImage не воспроизведён');
            record('F2: операторский кандидат-манифест воспроизведён чистыми сборками (7 images + postgres)');
        });
        await step('F4: pinned-деплой в замкнутом контуре', async () => {
            await waitForLoad(loadHistory, 'F4-up');
            deploy = await deployPinned({ manifest, operatorConfig, projectName, stage, record });
        });
        await step('F5: TLS, схема, lock-независимость, мост', async () => {
            const report = await staticDriftReport(root, liveOverlayDocuments(manifest));
            assert.deepEqual(report.counts, { structural: 0, dead: 0, required: 0 }, 'F5-static: дрейф модели');
            record('F5-static: модель окружения без дрейфа (base + overlays + live-оверлеи)');
            const certFile = envValue(fs.readFileSync(path.join(deploy.configCopy, '.env'), 'utf8'), 'TLS_CERT_FILE');
            await runF5Live({ client: deploy.client, manifest, record });
            await verifySsoAndBridge({ client: deploy.client, certFile, record });
        });
        await step('F6: evidence-запись', async () => {
            // Запись формируется в finally: сюда только подтверждение каталога.
            record('F6: evidence-каталог готов', stage);
        });
    } catch (error) {
        result = 'NO-GO';
        throw error;
    } finally {
        if (deploy) {
            try {
                await deploy.client.run(['down', '--remove-orphans', '--timeout', '60']);
                console.log('\nTeardown: Compose-проект остановлен (volumes намеренно сохранены)');
            } catch (error) {
                console.error('Teardown: ' + (error?.message ?? error));
            }
        }
        const report = {
            format: EVIDENCE_FORMAT,
            candidate: { commit: manifest.commit, tag: args.tag },
            hostVariant: args.hostVariant,
            composeProject: projectName,
            digests: {
                images: manifest.images,
                postgresImage: manifest.postgresImage,
                canonicalSha256,
            },
            manifests,
            steps,
            checks,
            loadHistory,
            result,
            startedAt,
            finishedAt: new Date().toISOString(),
        };
        try {
            const filename = await writeE2eReport(stage, report);
            console.log('\nF6: отчёт ' + result + ' записан: ' + filename);
        } catch (error) {
            console.error('F6: отчёт не записан: ' + (error?.message ?? error));
        }
    }
}

const USAGE =
    'Использование: node scripts/test/release-candidate-e2e.test.mjs --candidate <commit> --tag <release> ' +
    '--manifest <path> --host-variant A|B\n' +
    'Env: NEUROCENTER_CONFIG_DIR — production-конфиг кандидата; NEUROCENTER_TEST_EVIDENCE — каталог evidence ' +
    '(по умолчанию .run/release-candidate-e2e).\n' +
    'Live-запуски F2–F5 — HITL, порядок подготовки: docs/release-candidate-e2e.md';

if (process.env.NODE_TEST_CONTEXT) {
    const { test } = await import('node:test');
    const { execFileSync } = childProcess;
    const { tmpdir } = os;
    const requireModule = createRequire(import.meta.url);

    function syntheticManifest({ commit, release }) {
        return buildReleaseManifest({
            commit,
            release,
            images: Object.fromEntries(applicationServices.map((service) => [service, 'sha256:' + 'a'.repeat(64)])),
            postgresImage: 'sha256:' + 'b'.repeat(64),
            nodeExporterImage: 'sha256:' + 'f'.repeat(64),
            supply: {
                runtime: [{ name: 'runtime/neurocenter-runtime.tgz', sha256: 'c'.repeat(64) }],
                opencode: [{ name: 'opencode/neurocenter-opencode.tgz', sha256: 'd'.repeat(64) }],
                installers: installerTemplates.map((name) => ({ name, sha256: 'e'.repeat(64) })),
                vendorContract: {
                    package: 'vendor',
                    version: '1.0.0',
                    commit: '1'.repeat(40),
                    sha256sums: { 'asset.bin': '2'.repeat(64) },
                },
            },
            migrations: {
                'catalog-service': [{ version: 1, name: 'init', checksum: '3'.repeat(64) }],
                'feature-flags-service': [{ version: 1, name: 'init', checksum: '4'.repeat(64) }],
                'rag-sync-service': [{ scope: 'rag', version: '1', name: 'init', checksum: '5'.repeat(64) }],
            },
        });
    }

    async function gitFixture(t) {
        const directory = await mkdtemp(path.join(tmpdir(), 'nc rel01 f1 '));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const git = (args) =>
            execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], {
                cwd: directory,
                encoding: 'utf8',
                env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
            });
        git(['init', '-q', '-b', 'main']);
        fs.writeFileSync(path.join(directory, 'file.txt'), 'x\n');
        git(['add', '.']);
        git(['commit', '-qm', 'fixture']);
        git(['tag', '-a', 'rel-fixture-1', '-m', 'fixture']);
        return { directory, git, commit: git(['rev-parse', 'HEAD']).trim() };
    }

    test('parseDriverArgs: полный набор и отклонения', () => {
        const args = parseDriverArgs([
            '--candidate',
            'a'.repeat(40),
            '--tag',
            'rel-1',
            '--manifest',
            '/tmp/manifest.json',
            '--host-variant',
            'B',
        ]);
        assert.deepEqual(
            { candidate: args.candidate, tag: args.tag, hostVariant: args.hostVariant },
            { candidate: 'a'.repeat(40), tag: 'rel-1', hostVariant: 'B' },
        );
        assert.ok(args.manifest.endsWith('manifest.json'));
        assert.throws(() => parseDriverArgs(['--candidate', 'abc']), /40-значным hex-commit/);
        assert.throws(() => parseDriverArgs(['--candidate', 'a'.repeat(40)]), /--candidate, --tag, --manifest/);
        assert.throws(
            () =>
                parseDriverArgs([
                    '--candidate',
                    'a'.repeat(40),
                    '--tag',
                    'rel-1',
                    '--manifest',
                    '/tmp/m.json',
                    '--host-variant',
                    'C',
                ]),
            /A или B/,
        );
        assert.throws(() => parseDriverArgs(['--unknown']), /Неизвестный аргумент/);
    });

    test('F1: замороженный кандидат подтверждён (annotated тег, manifest, HEAD, чистое дерево)', async (t) => {
        const fixture = await gitFixture(t);
        const manifest = syntheticManifest({ commit: fixture.commit, release: 'rel-fixture-1' });
        const args = { candidate: fixture.commit, tag: 'rel-fixture-1' };
        const result = await checkFrozenCandidate(fixture.directory, args, manifest);
        assert.equal(result.commit, fixture.commit);
    });

    test('F1: расхождение manifest.release с тегом отклонено', async (t) => {
        const fixture = await gitFixture(t);
        const manifest = syntheticManifest({ commit: fixture.commit, release: 'other-release' });
        await assert.rejects(
            checkFrozenCandidate(fixture.directory, { candidate: fixture.commit, tag: 'rel-fixture-1' }, manifest),
            /manifest\.release/,
        );
    });

    test('F1: расхождение manifest.commit с коммитом тега отклонено', async (t) => {
        const fixture = await gitFixture(t);
        const manifest = syntheticManifest({ commit: '9'.repeat(40), release: 'rel-fixture-1' });
        await assert.rejects(
            checkFrozenCandidate(fixture.directory, { candidate: fixture.commit, tag: 'rel-fixture-1' }, manifest),
            /manifest\.commit/,
        );
    });

    test('F1: неизвестный тег и lightweight-тег отклонены', async (t) => {
        const fixture = await gitFixture(t);
        const manifest = syntheticManifest({ commit: fixture.commit, release: 'rel-fixture-1' });
        await assert.rejects(
            checkFrozenCandidate(fixture.directory, { candidate: fixture.commit, tag: 'no-such-tag' }, manifest),
            /не найден/,
        );
        fixture.git(['tag', 'lightweight', fixture.commit]);
        await assert.rejects(
            checkFrozenCandidate(fixture.directory, { candidate: fixture.commit, tag: 'lightweight' }, manifest),
            /annotated/,
        );
    });

    test('F1: кандидат вне HEAD и грязное дерево отклонены', async (t) => {
        const fixture = await gitFixture(t);
        const manifest = syntheticManifest({ commit: fixture.commit, release: 'rel-fixture-1' });
        await assert.rejects(
            checkFrozenCandidate(fixture.directory, { candidate: 'f'.repeat(40), tag: 'rel-fixture-1' }, manifest),
            /HEAD/,
        );
        fs.writeFileSync(path.join(fixture.directory, 'dirty.txt'), 'x\n');
        await assert.rejects(
            checkFrozenCandidate(fixture.directory, { candidate: fixture.commit, tag: 'rel-fixture-1' }, manifest),
            /чистого git-checkout/,
        );
    });

    test('F3: идентичные сборки приняты, дрейф digest — по сервису', () => {
        const commit = 'a'.repeat(40);
        const a = syntheticManifest({ commit, release: 'rel-fixture-1' });
        const b = syntheticManifest({ commit, release: 'rel-fixture-1' });
        const comparison = compareManifestDigests(a, b);
        assert.equal(comparison.identical, true);
        assert.equal(comparison.canonicalSha256, manifestCanonicalSha256(a));
        const drifted = structuredClone(b);
        drifted.images['api-gateway'] = 'sha256:' + 'f'.repeat(64);
        assert.throws(() => compareManifestDigests(a, drifted), /api-gateway/);
        const postgresDrift = structuredClone(b);
        postgresDrift.postgresImage = 'sha256:' + 'c'.repeat(64);
        assert.throws(() => compareManifestDigests(a, postgresDrift), /postgresImage/);
    });

    test('F5-static: модель окружения без дрейфа — base и с live-оверлеями', async () => {
        const base = await staticDriftReport(root);
        assert.deepEqual(base.counts, { structural: 0, dead: 0, required: 0 });
        const manifest = syntheticManifest({ commit: 'a'.repeat(40), release: 'rel-fixture-1' });
        const withOverlay = await staticDriftReport(root, liveOverlayDocuments(manifest));
        assert.deepEqual(withOverlay.counts, { structural: 0, dead: 0, required: 0 });
    });

    test('F6: отчёт 0600 в 0700-каталоге, аномальные отчёты отклонены', async (t) => {
        const stage = await mkdtemp(path.join(tmpdir(), 'nc rel01 f6 '));
        t.after(() => rm(stage, { recursive: true, force: true }));
        await fs.promises.chmod(stage, 0o700);
        const manifest = syntheticManifest({ commit: 'a'.repeat(40), release: 'rel-fixture-1' });
        const report = {
            format: EVIDENCE_FORMAT,
            candidate: { commit: manifest.commit, tag: 'rel-fixture-1' },
            hostVariant: 'B',
            composeProject: 'nc-rel01-test',
            digests: {
                images: manifest.images,
                postgresImage: manifest.postgresImage,
                canonicalSha256: manifestCanonicalSha256(manifest),
            },
            steps: [{ name: 'F1' }],
            checks: [],
            result: 'GO',
            startedAt: '2026-11-09T00:00:00.000Z',
            finishedAt: '2026-11-09T00:10:00.000Z',
        };
        const filename = await writeE2eReport(stage, report);
        const info = await lstat(filename);
        assert.equal(info.mode & 0o777, 0o600);
        assert.equal((await lstat(stage)).mode & 0o777, 0o700);
        assert.equal(JSON.parse(await readFile(filename, 'utf8')).format, EVIDENCE_FORMAT);
        await assert.rejects(writeE2eReport(stage, { ...report, result: 'MAYBE' }), /GO или NO-GO/);
        await assert.rejects(writeE2eReport(stage, { ...report, hostVariant: 'C' }), /hostVariant/);
        await fs.promises.chmod(stage, 0o755);
        await assert.rejects(writeE2eReport(stage, report), /0700/);
    });

    test('validateProduction (offline): SSO-disable и TLS-off запрещены в production', () => {
        const { validateProduction } = requireModule('../../services/shared/runtime.cjs');
        assert.throws(
            () =>
                validateProduction(
                    { NODE_ENV: 'production', NEUROCENTER_SERVICE: 'catalog-service', SSO_DISABLE: 'true' },
                    'catalog-service',
                ),
            /SSO_DISABLE=false обязателен в production/,
        );
        assert.throws(
            () =>
                validateProduction(
                    {
                        NODE_ENV: 'production',
                        NEUROCENTER_SERVICE: 'catalog-service',
                        NODE_TLS_REJECT_UNAUTHORIZED: '0',
                    },
                    'catalog-service',
                ),
            /Запрещено отключать проверку TLS/,
        );
        assert.doesNotThrow(() =>
            validateProduction(
                {
                    NODE_ENV: 'production',
                    NEUROCENTER_SERVICE: 'catalog-service',
                    SSO_DISABLE: 'false',
                    PANEL_URL: 'https://panel.test',
                    NEUROCENTER_INTERNAL_TOKEN: 'a'.repeat(64),
                    CATALOG_PG_URL: 'postgres://user:secret@postgres:5432/catalog',
                    RAG_PG_URL: 'postgres://user:secret@postgres:5432/rag',
                    SKILLS_SERVICE_URL: 'http://skills-service:4000',
                },
                'catalog-service',
            ),
        );
    });

    test('F2: две чистые сборки + F3 (HITL)', { skip: 'HITL: требует docker-хоста и операторский конфиг (H1–H2)' });
    test('F4: pinned-деплой в замкнутом контуре (HITL)', { skip: 'HITL: требует docker-хоста (H3)' });
    test('F5: production TLS, схема, lock-независимость, SSO-мост (HITL)', {
        skip: 'HITL: требует docker-хоста (H4–H5)',
    });
} else {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        console.error(USAGE);
        process.exit(1);
    }
    let args;
    try {
        args = parseDriverArgs(argv);
    } catch (error) {
        console.error(error.message + '\n\n' + USAGE);
        process.exit(1);
    }
    try {
        await runLive(args);
        console.log('\nREL-01: кандидат принят (GO). Отчёт: $NEUROCENTER_TEST_EVIDENCE/release-candidate-e2e.json');
    } catch (error) {
        console.error('\nREL-01: NO-GO — ' + (error?.message ?? error));
        if (error?.diagnostic) console.error(error.diagnostic.split('\n').slice(-40).join('\n'));
        process.exitCode = 1;
    }
}
