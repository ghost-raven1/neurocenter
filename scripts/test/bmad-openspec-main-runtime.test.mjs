/**
 * FR-308 (agt-10, entry 10): main-runtime BMAD→OpenSpec — e2e на живом PostgreSQL, собранном
 * catalog-service и реальном исполнителе `node dist/background-agent/background-agent.cli.js`
 * (compose-вход background-agent, тот же executor, что в production). Сценарии I/O Matrix:
 *  1. фоновый агент (entry 7) + combined-задача → реальный prepareMainMethod: prepared prompt
 *     (BMAD→OpenSpec, переиспользование accepted brief/PRD/architecture, без 2-го build-цикла) и
 *     OpenSpec `validate --all --strict --no-interactive`-гейт реально прогнан (I/O 1, 3, 4, 5);
 *  2. pinned-версии + «без скрытых обновлений»: bmad-6.12.4 + openspec-1.15.0 из единого источника
 *     AGENT_METHOD_VERSIONS (pinned в промпте); движок получает OPENSPEC_TELEMETRY=0 /
 *     OPENSPEC_NO_UPDATE_CHECK=1 / OPENCODE_CONFIG_CONTENT {autoupdate:false, share:'disabled',
 *     permission.external_directory:'deny'}; иная версия → явная именованная ошибка
 *     MainMethodPreparationError (RUNTIME_MISSING/METHOD_VERSION/…), stage=prerequisites, все
 *     declared checks not_run (I/O 2);
 *  3. OpenSpec validate не пройден → failed, stage=checks, declared checks not_run (I/O 7).
 *
 * Стансы (зафиксировано в Progress тикета): pinned-метод-CLI `bmad`/`openspec`/`uv` и `--version`
 * пиннуемого движка — станс-исполняемые файлы с pinned-версиями (OpenSpec-корень = рабочая
 * директория, `validate` → маркер-файл + exit по маркеру). Реальные pinned-CLI в среде могут
 * отсутствовать; шов TMainMethodRunner это предусматривает. Реальное: prepare-код
 * (dist/background-agent/method-preparation.js), fixture-проект, executor CLI, owned-PG,
 * fail-closed acceptance. C5-протокол на реальном пилотном проекте — вне сцены (agt-12, HITL).
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const dist = path.join(root, 'services/catalog-service/dist');
const { AGENT_METHOD_VERSIONS } = require(path.join(root, 'services/shared/agent-method-workflow.cjs'));

const BMAD_VERSION = '6.12.4';
const OPENSPEC_VERSION = '1.15.0';
const COMBINED_VERSION = `bmad-${BMAD_VERSION}+openspec-${OPENSPEC_VERSION}`;
const OPENCODE_VERSION = '1.14.48';
const REQUIRED_SKILLS = [
    'bmad-help',
    'bmad-product-brief',
    'bmad-prd',
    'bmad-architecture',
    'openspec-propose',
    'openspec-apply-change',
    'openspec-verify-change',
    'openspec-archive-change',
];

let skip = false,
    bootstrapError = '',
    f = null,
    container = null,
    port = 0;

const waitForTcp = (host, p, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const attempt = () => {
            const socket = net.connect({ host, port: p });
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                socket.destroy();
                Date.now() > deadline ? reject(new Error('PG not ready: ' + host + ':' + p)) : setTimeout(attempt, 250);
            });
        };
        attempt();
    });

const guard = (t) => {
    if (skip) t.skip('bootstrap недоступен: ' + bootstrapError);
};

const waitFor = async (fn, timeoutMs = 120000, intervalMs = 500) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('Таймаут ожидания состояния main-runtime BMAD→OpenSpec.');
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
};

/**
 * Станс-исполняемые pinned-метод-CLI (замена реальных bmad/openspec/uv, которых в среде может не быть).
 * Поведение фиксировано: pinned-версии; OpenSpec-корень = рабочая директория (prepare-код проверит
 * assertOpenSpecRoot по realpath); `validate` пишет маркер-файл и падает при маркере
 * .nc-e2e-validate-fail в корне (сценарий I/O 7).
 */
const writeStubMethodClis = (binDir) => {
    mkdirSync(binDir, { recursive: true });
    const bmad = path.join(binDir, 'bmad');
    writeFileSync(
        bmad,
        `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('${BMAD_VERSION}');\nprocess.exit(0);\n`,
    );
    const uv = path.join(binDir, 'uv');
    writeFileSync(uv, '#!/usr/bin/env node\nconsole.log("uv 0.9.9");\nprocess.exit(0);\n');
    const openspec = path.join(binDir, 'openspec');
    writeFileSync(
        openspec,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('${OPENSPEC_VERSION}'); process.exit(0); }
if (args[0] === 'context') { console.log(JSON.stringify({ root: { path: process.cwd() } })); process.exit(0); }
if (args[0] === 'list') { console.log('[]'); process.exit(0); }
if (args[0] === 'validate') {
    if (process.env.NC_E2E_VALIDATED_LOG) fs.appendFileSync(process.env.NC_E2E_VALIDATED_LOG, process.cwd() + '\\n');
    process.exit(fs.existsSync(path.join(process.cwd(), '.nc-e2e-validate-fail')) ? 1 : 0);
}
process.exit(0);
`,
    );
    for (const file of [bmad, uv, openspec]) chmodSync(file, 0o755);
};

/**
 * Fake автономный пакет: runtime.json (pin 1.14.48 + sha256) + bin/opencode-probe (loopback-протокол,
 * тот же, что в background-agent-server.test.mjs) с поддержкой `--version` (prepare-код дёргает
 * пиннуемый движок на проверку версии) и логами полученного промпта и окружения (NC_E2E_*).
 */
const writeAutonomousPackage = (pkgRoot) => {
    const binDir = path.join(pkgRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const engine = path.join(binDir, 'opencode-probe');
    const code = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('opencode ${OPENCODE_VERSION}'); process.exit(0); }
const http = require('node:http');
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
        const send = (code, value) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(value));
        };
        if (req.method === 'GET' && url.pathname === '/agent')
            return send(200, [{ name: 'nc-fake', mode: 'primary', model: { providerID: 'p', modelID: 'm' } }]);
        if (req.method === 'POST' && url.pathname === '/session') return send(200, { id: 'ses_fake' });
        if (req.method === 'POST' && url.pathname === '/session/ses_fake/message') {
            const parsed = JSON.parse(body || '{}');
            const text = (parsed.parts && parsed.parts[0] && parsed.parts[0].text) || '';
            if (process.env.NC_E2E_PROMPT_LOG)
                fs.appendFileSync(process.env.NC_E2E_PROMPT_LOG, JSON.stringify(text) + '\\n');
            if (process.env.NC_E2E_ENV_LOG)
                fs.appendFileSync(
                    process.env.NC_E2E_ENV_LOG,
                    JSON.stringify({
                        OPENSPEC_TELEMETRY: process.env.OPENSPEC_TELEMETRY,
                        OPENSPEC_NO_UPDATE_CHECK: process.env.OPENSPEC_NO_UPDATE_CHECK,
                        OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
                        OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION,
                    }) + '\\n',
                );
            return send(200, {
                info: {
                    id: 'msg_1',
                    role: 'assistant',
                    agent: 'nc-fake',
                    providerID: 'p',
                    modelID: 'm',
                    sessionID: 'ses_fake',
                    time: { completed: Date.now() },
                    finish: 'stop',
                },
                parts: [{ type: 'text', text: 'done', sessionID: 'ses_fake', messageID: 'msg_1' }],
            });
        }
        send(404, { error: 'not found' });
    });
});
server.listen(0, '127.0.0.1', () => {
    console.log('listening on http://127.0.0.1:' + server.address().port);
});
`;
    writeFileSync(engine, code);
    chmodSync(engine, 0o755);
    const sha256 = createHash('sha256').update(readFileSync(engine)).digest('hex');
    writeFileSync(
        path.join(pkgRoot, 'runtime.json'),
        JSON.stringify({ probeEngine: { file: 'bin/opencode-probe', version: OPENCODE_VERSION, sha256 } }),
    );
    return pkgRoot;
};

/**
 * Минимальный fixture-проект BMAD→OpenSpec с pinned-версиями: BMAD-инициатива (manifest
 * installation.version + render_skill.py + uv-методика prepare-кода) и OpenSpec-layout
 * (openspec/config.yaml + change-структура — корень резолвится по cwd станс-CLI).
 */
const seedFixtureProject = (dir, { manifestVersion = BMAD_VERSION, validateFail = false } = {}) => {
    mkdirSync(path.join(dir, '_bmad/_config'), { recursive: true });
    mkdirSync(path.join(dir, '_bmad/scripts'), { recursive: true });
    writeFileSync(path.join(dir, '_bmad/_config/manifest.yaml'), `installation:\n  version: "${manifestVersion}"\n`);
    writeFileSync(path.join(dir, '_bmad/scripts/render_skill.py'), '# render skill (fixture)\n');
    mkdirSync(path.join(dir, '_bmad-output'), { recursive: true });
    writeFileSync(
        path.join(dir, '_bmad-output/prd.md'),
        `# PRD (accepted)\nAccepted planning artifact: reuse, do not create a second one.\n`,
    );
    mkdirSync(path.join(dir, 'openspec/changes'), { recursive: true });
    writeFileSync(path.join(dir, 'openspec/config.yaml'), 'schema: spec-driven\n');
    for (const name of REQUIRED_SKILLS) {
        const skillDir = path.join(dir, '.opencode/skills', name);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n${name} instructions (fixture).\n`);
    }
    writeFileSync(path.join(dir, 'check.cjs'), 'process.exit(0);\n');
    if (validateFail) writeFileSync(path.join(dir, '.nc-e2e-validate-fail'), '');
};

test('bootstrap: live PG + dist + автономный пакет + стансы + executor CLI', async () => {
    container = 'nc-agt10-e2e-' + randomUUID().slice(0, 8);
    port = 56032 + (process.pid % 200);
    let cli = null,
        workspace = null;
    try {
        execFileSync(
            'docker',
            [
                'run',
                '-d',
                '--rm',
                '--name',
                container,
                '-e',
                'POSTGRES_PASSWORD=qa',
                '-p',
                '127.0.0.1:' + port + ':5432',
                'postgres:16',
            ],
            {
                timeout: 60000,
                stdio: 'pipe',
            },
        );
        await waitForTcp('127.0.0.1', port);
        const deadline = Date.now() + 120000;
        for (;;) {
            try {
                execFileSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], {
                    timeout: 15000,
                    stdio: 'pipe',
                });
                break;
            } catch {
                if (Date.now() > deadline) throw new Error('PG readiness timeout: ' + container);
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
        workspace = mkdtempSync(path.join(tmpdir(), 'nc-agt10-e2e-'));
        const projectsRoot = path.join(workspace, 'projects');
        const binDir = path.join(workspace, 'bin');
        const pkgRoot = writeAutonomousPackage(path.join(workspace, 'pkg'));
        writeStubMethodClis(binDir);
        const promptLog = path.join(workspace, 'prompts.log');
        const envLog = path.join(workspace, 'envs.log');
        const validatedLog = path.join(workspace, 'validated.log');
        // Три fixture-проекта: happy path / mismatch-версия BMAD / validate-гейт падает.
        const projects = {
            main: 'prj-10-main',
            mismatch: 'prj-10-mismatch',
            validateFail: 'prj-10-validate-fail',
        };
        seedFixtureProject(path.join(projectsRoot, projects.main));
        seedFixtureProject(path.join(projectsRoot, projects.mismatch), { manifestVersion: '5.0.0' });
        seedFixtureProject(path.join(projectsRoot, projects.validateFail), { validateFail: true });
        const { Pool } = require('pg');
        process.env.NEUROCENTER_INTERNAL_TOKEN = randomBytes(32).toString('hex');
        const pgUrl = 'postgres://postgres:qa@127.0.0.1:' + port + '/postgres';
        const cliEnv = {
            ...process.env,
            PATH: binDir + path.delimiter + (process.env.PATH ?? ''),
            CATALOG_PG_URL: pgUrl,
            BACKGROUND_AGENT_RUNTIME_ROOT: pkgRoot,
            PROJECTS_ROOT: projectsRoot,
            NC_E2E_PROMPT_LOG: promptLog,
            NC_E2E_ENV_LOG: envLog,
            NC_E2E_VALIDATED_LOG: validatedLog,
        };
        delete cliEnv.NODE_ENV;
        cli = spawn(process.execPath, [path.join(dist, 'background-agent/background-agent.cli.js')], {
            env: cliEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let cliOutput = '';
        cli.stdout.on('data', (chunk) => (cliOutput += chunk.toString()));
        cli.stderr.on('data', (chunk) => (cliOutput += chunk.toString()));
        cli.on('error', (error) => (cliOutput += String(error)));
        // Старт исполнителя = схема готова (ensureCatalogSchema на старте loop).
        await waitFor(() => /"event":\s*"started"/.test(cliOutput), 120000);
        const pool = new Pool({ connectionString: pgUrl, max: 4 });
        const { PgBackgroundAgentStore } = require(path.join(dist, 'background-agent/pg-store.js'));
        const { BackgroundAgentService } = require(path.join(dist, 'background-agent/service.js'));
        const service = new BackgroundAgentService({ pool }, new PgBackgroundAgentStore(pool));
        const owner = 'owner@example.test';
        await pool.query('INSERT INTO platform_users(email) VALUES($1)', [owner]);
        // Origin-комната — фиксированный нулевой UUID (CHECK project_chat_room_origin), как в
        // background-agent-server.test.mjs.
        const USER_ROOM = '00000000-0000-0000-0000-000000000000';
        const rooms = {};
        for (const [key, projectId] of Object.entries(projects)) {
            await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'FR-308 e2e ' + key]);
            await pool.query(
                'INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$3,$4,$5)',
                [projectId, owner, owner, 'Владелец', 'Админ проекта'],
            );
            rooms[key] = USER_ROOM;
            await pool.query('INSERT INTO project_chat_rooms(project_id,id) VALUES($1,$2)', [projectId, rooms[key]]);
        }
        const seed = async (projectId, roomId, instruction) => {
            const id = randomUUID(),
                generation = randomUUID(),
                requestKey = randomUUID();
            await pool.query(
                `INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,generation)
                 VALUES($1,$2,$3,'user',$4,$5,$6,$7,'done',$8,$9,$10)`,
                [
                    id,
                    projectId,
                    roomId,
                    instruction,
                    owner,
                    'Владелец',
                    'Админ проекта',
                    requestKey,
                    'c'.repeat(64),
                    generation,
                ],
            );
            return id;
        };
        f = {
            pool,
            service,
            cli,
            cliOutput: () => cliOutput,
            workspace,
            projectsRoot,
            projects,
            rooms,
            promptLog,
            envLog,
            validatedLog,
            owner,
            req: () => ({
                headers: {
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN,
                    'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: owner, activeRole: 'Админ проекта' })),
                },
            }),
            seed,
            job: (requestId) =>
                pool
                    .query('SELECT * FROM background_agent_jobs WHERE request_id=$1', [requestId])
                    .then((result) => result.rows[0]),
            // JSON-строка на промпт: текст промпта содержит `---` (frontmatter скиллов), простой
            // текст-разделитель бы его разрегал на фрагменты.
            promptEntries: () =>
                readFileSync(promptLog, 'utf8')
                    .split('\n')
                    .filter((line) => line.length > 0)
                    .map((line) => JSON.parse(line)),
            envEntries: () =>
                readFileSync(envLog, 'utf8')
                    .split('\n')
                    .filter((line) => line.length > 0)
                    .map((line) => JSON.parse(line)),
        };
    } catch (error) {
        skip = true;
        bootstrapError = error.stack || String(error);
        console.error('bootstrap failed:\n' + bootstrapError);
        if (cli) {
            try {
                cli.kill('SIGKILL');
            } catch {
                /* best effort */
            }
        }
        if (workspace) {
            try {
                rmSync(workspace, { recursive: true, force: true });
            } catch {
                /* best effort */
            }
        }
        try {
            if (container) execFileSync('docker', ['rm', '-f', container], { timeout: 10000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
        container = null;
        f = null;
    }
});

test('1. combined-задача: prepared prompt (BMAD→OpenSpec) + OpenSpec validate-гейт → succeeded (I/O 1,3,4,5)', async (t) => {
    guard(t);
    const projectId = f.projects.main,
        roomId = f.rooms.main;
    const source = await f.seed(projectId, roomId, 'BMAD→OpenSpec основная задача');
    const receipt = await f.service.start(f.req(), projectId, roomId, source, {
        method: 'combined',
        instruction: 'BMAD→OpenSpec основная задача',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    assert.equal(receipt.state, 'pending');
    const job = await waitFor(async () => {
        const row = await f.job(receipt.requestKey);
        return row?.state === 'succeeded' || row?.state === 'failed' ? row : undefined;
    });
    assert.equal(job.state, 'succeeded', 'job: ' + JSON.stringify(job.result));
    assert.equal(job.runtime_version, OPENCODE_VERSION, 'сервер фиксирует пиннуемую версию OpenCode');
    assert.equal(job.result.state, 'succeeded');
    assert.equal(job.result.checks.length, 1);
    assert.equal(job.result.checks[0].state, 'passed');
    assert.equal(job.result.checks[0].exitCode, 0);
    // Движок получил prepared BMAD→OpenSpec-промпт (не generic): pinned-метод, workflowId,
    // переиспользование accepted planning, без 2-го build-цикла, skills из .opencode/skills.
    const entry = f.promptEntries().find((value) => value.includes('BMAD→OpenSpec основная задача'));
    assert.ok(entry, 'prepared prompt в логе движка: ' + JSON.stringify(f.promptEntries()));
    assert.ok(entry.startsWith('Neurocenter main development workflow '), 'workflow-шапка main-runtime');
    assert.ok(entry.includes(`Method combined ${COMBINED_VERSION}`), 'pinned combined-версия в промпте');
    assert.ok(entry.includes('reuse accepted brief/PRD/architecture'), 'BMAD переиспользует accepted planning');
    assert.ok(
        entry.includes('Do not run BMAD build-auto or a second implementation cycle'),
        'второй BMAD build-цикл запрещён',
    );
    assert.ok(entry.includes('one implementation and verification cycle'), 'OpenSpec — единственная реализация');
    assert.ok(entry.includes('Run openspec validate --all --strict --no-interactive after changes'));
    assert.ok(entry.includes('FILE .opencode/skills/bmad-prd/SKILL.md'), 'BMAD skill подгружен из проекта');
    assert.ok(entry.includes('FILE .opencode/skills/openspec-apply-change/SKILL.md'), 'OpenSpec skill подгружен');
    assert.ok(entry.includes('USER TASK:'), 'инструкция в промпте');
    assert.ok(entry.includes('BMAD→OpenSpec основная задача'));
    assert.ok(entry.includes('Project working directory: ' + path.join(f.projectsRoot, projectId)), 'контекст проекта');
    // OpenSpec validate-гейт реально прогнан в bound root (станс-CLI пишет маркер-файл).
    const validated = readFileSync(f.validatedLog, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
    assert.ok(
        validated.includes(path.join(f.projectsRoot, projectId)),
        'validate-гейт прогнан в bound project root: ' + JSON.stringify(validated),
    );
});

test('2. pinned-версии + «без скрытых обновлений» в окружении движка (I/O 2)', async (t) => {
    guard(t);
    // Единый источник pinned-версий (static-проверка тикета).
    assert.equal(AGENT_METHOD_VERSIONS.bmad, BMAD_VERSION);
    assert.equal(AGENT_METHOD_VERSIONS.openspec, OPENSPEC_VERSION);
    assert.equal(AGENT_METHOD_VERSIONS.combined, COMBINED_VERSION);
    // Движок получил окружение «без скрытых обновлений»: telemetry/update-check/auto-update off.
    const env = f.envEntries()[0];
    assert.ok(env, 'env-лог движка заполнен');
    assert.equal(env.OPENSPEC_TELEMETRY, '0');
    assert.equal(env.OPENSPEC_NO_UPDATE_CHECK, '1');
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.autoupdate, false);
    assert.equal(config.share, 'disabled');
    assert.equal(config.permission.external_directory, 'deny');
    assert.equal(JSON.parse(env.OPENCODE_PERMISSION).external_directory, 'deny');
    // Pinned-версии зафиксированы в промпте (версия метода сервером, не runtime-instruction).
    const entry = f.promptEntries().find((value) => value.includes('Method combined'));
    assert.ok(entry, 'prepared prompt присутствует');
    assert.ok(entry.includes(BMAD_VERSION) && entry.includes(OPENSPEC_VERSION));
});

test('3. mismatch BMAD-версии: явная именованная ошибка, prerequisites, checks not_run (I/O 2)', async (t) => {
    guard(t);
    const projectId = f.projects.mismatch,
        roomId = f.rooms.mismatch;
    const source = await f.seed(projectId, roomId, 'BMAD→OpenSpec mismatch-задача');
    const receipt = await f.service.start(f.req(), projectId, roomId, source, {
        method: 'combined',
        instruction: 'BMAD→OpenSpec mismatch-задача',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const job = await waitFor(async () => {
        const row = await f.job(receipt.requestKey);
        return row?.state === 'succeeded' || row?.state === 'failed' ? row : undefined;
    });
    assert.equal(job.state, 'failed', 'mismatch → failed, не тихая подстановка: ' + JSON.stringify(job.result));
    assert.equal(job.result.state, 'failed');
    assert.equal(job.result.stage, 'prerequisites');
    assert.deepEqual(job.result.failure, { code: 'EXECUTION_FAILED', action: 'new-request' });
    assert.equal(job.result.checks.length, 1);
    assert.equal(job.result.checks[0].state, 'not_run');
    assert.equal(job.result.checks[0].exitCode, null);
    // Именованный код MainMethodPreparationError — фиксированный классификатор в логе исполнителя.
    const logs = f.cliOutput();
    const named = logs.match(/\{"event":"method-preparation-failed","code":"([A-Z_]+)"\}/);
    assert.ok(named, 'method-preparation-failed с именованным кодом в логе: ' + JSON.stringify(logs.slice(-2000)));
    assert.equal(named[1], 'METHOD_VERSION', 'именно mismatch-версия BMAD-манифеста');
});

test('4. OpenSpec validate не пройден → failed, declared checks not_run (I/O 7)', async (t) => {
    guard(t);
    const projectId = f.projects.validateFail,
        roomId = f.rooms.validateFail;
    const source = await f.seed(projectId, roomId, 'BMAD→OpenSpec validate-fail задача');
    const receipt = await f.service.start(f.req(), projectId, roomId, source, {
        method: 'combined',
        instruction: 'BMAD→OpenSpec validate-fail задача',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const job = await waitFor(async () => {
        const row = await f.job(receipt.requestKey);
        return row?.state === 'succeeded' || row?.state === 'failed' ? row : undefined;
    });
    assert.equal(job.state, 'failed', 'validate-гейт не пройден → failed: ' + JSON.stringify(job.result));
    assert.equal(job.result.state, 'failed');
    assert.equal(job.result.stage, 'checks');
    assert.deepEqual(job.result.failure, { code: 'CHECK_FAILED', action: 'review-result' });
    assert.equal(job.result.checks.length, 1);
    assert.equal(job.result.checks[0].state, 'not_run', 'declared checks не запускаются после падения гейта');
    // Гейт реально исполнялся в bound root (маркер-файл), и именно он упал.
    const validated = readFileSync(f.validatedLog, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
    assert.ok(
        validated.includes(path.join(f.projectsRoot, projectId)),
        'validate-гейт прогнан для validate-fail проекта: ' + JSON.stringify(validated),
    );
});

test('teardown', async () => {
    if (skip) return;
    if (f?.cli) {
        const cli = f.cli;
        cli.kill('SIGTERM');
        await waitFor(() => cli.exitCode !== null || cli.signalCode !== null, 15000, 200).catch(() =>
            cli.kill('SIGKILL'),
        );
        f.cli = null;
    }
    if (f?.pool) await f.pool.end();
    if (f?.workspace) {
        try {
            rmSync(f.workspace, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    }
    if (container) {
        try {
            execFileSync('docker', ['rm', '-f', container], { timeout: 30000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
        container = null;
    }
});
process.on('exit', () => {
    if (container) {
        try {
            execFileSync('docker', ['rm', '-f', container], { timeout: 10000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
    }
});
