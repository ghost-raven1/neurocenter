/**
 * FR-305 (agt-07, фаза B): серверный фоновый агент — e2e на живом PostgreSQL и собранном
 * catalog-service. Реальный исполнитель: процесс `node dist/background-agent/background-agent.cli.js`
 * (compose-вход background-agent) с пиннуемым автономным пакетом (fake opencode 1.14.48, тот же
 * loopback-протокол, OQ-2). Сценарии I/O Matrix:
 *  1. задача в фоне → фоновая работа → результат в проектном чате (I/O 1–2);
 *  2. контекст проекта подгружен в задачу (I/O 4);
 *  3. drift-проверка compose/environment-model в процессе (I/O 7);
 *  4. нет компонента → явная ошибка (I/O 3, healthcheck --check).
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile, execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const dist = path.join(root, 'services/catalog-service/dist');

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

const waitFor = async (fn, timeoutMs = 90000, intervalMs = 500) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('Таймаут ожидания состояния фонового агента.');
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
};

/** Fake автономный пакет: runtime.json (pin 1.14.48 + sha256) + bin/opencode-probe (loopback-протокол). */
const writeAutonomousPackage = (pkgRoot) => {
    const binDir = path.join(pkgRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const engine = path.join(binDir, 'opencode-probe');
    const code = `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
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
            if (process.env.NC_E2E_PROMPT_LOG) fs.appendFileSync(process.env.NC_E2E_PROMPT_LOG, text + '\\n---\\n');
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
        JSON.stringify({ probeEngine: { file: 'bin/opencode-probe', version: '1.14.48', sha256 } }),
    );
    return pkgRoot;
};

const USER_ROOM = '00000000-0000-0000-0000-000000000000';

test('bootstrap: live PG + dist + автономный пакет + executor CLI', async (t) => {
    container = 'nc-bga-e2e-' + randomUUID().slice(0, 8);
    port = 55832 + (process.pid % 200);
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
        workspace = mkdtempSync(path.join(tmpdir(), 'nc-bga-e2e-'));
        const projectsRoot = path.join(workspace, 'projects'),
            projectId = 'prj-bg-e2e',
            projectDir = path.join(projectsRoot, projectId);
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(path.join(projectDir, 'check.cjs'), 'process.exit(0);\n');
        const pkgRoot = writeAutonomousPackage(path.join(workspace, 'pkg')),
            promptLog = path.join(workspace, 'prompts.log');
        const { Pool } = require('pg');
        process.env.NEUROCENTER_INTERNAL_TOKEN = randomBytes(32).toString('hex');
        const pgUrl = 'postgres://postgres:qa@127.0.0.1:' + port + '/postgres';
        const cliEnv = {
            ...process.env,
            CATALOG_PG_URL: pgUrl,
            BACKGROUND_AGENT_RUNTIME_ROOT: pkgRoot,
            PROJECTS_ROOT: projectsRoot,
            NC_E2E_PROMPT_LOG: promptLog,
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
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Фоновый агент e2e']);
        const owner = 'owner@example.test';
        await pool.query('INSERT INTO platform_users(email) VALUES($1)', [owner]);
        await pool.query(
            "INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'owner',$2,'Владелец','Админ проекта')",
            [projectId, owner],
        );
        await pool.query('INSERT INTO project_chat_rooms(project_id,id) VALUES($1,$2)', [projectId, USER_ROOM]);
        const seed = async (instruction) => {
            const id = randomUUID(),
                generation = randomUUID(),
                requestKey = randomUUID();
            await pool.query(
                `INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,generation)
                 VALUES($1,$2,$3,'user',$4,$5,$6,$7,'done',$8,$9,$10)`,
                [
                    id,
                    projectId,
                    USER_ROOM,
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
            workspace,
            pkgRoot,
            promptLog,
            projectDir,
            projectId,
            owner,
            req: () => ({
                headers: {
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN,
                    'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: owner, activeRole: 'Админ проекта' })),
                },
            }),
            seed,
            agentMessage: (sourceId) =>
                pool
                    .query(
                        `SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='agent' AND source_message_id=$2 AND (snapshot->>'agentId')='background-agent'`,
                        [projectId, sourceId],
                    )
                    .then((result) => result.rows[0]),
            job: (requestId) =>
                pool
                    .query('SELECT * FROM background_agent_jobs WHERE request_id=$1', [requestId])
                    .then((result) => result.rows[0]),
            roomRevision: () =>
                pool
                    .query('SELECT revision::int AS revision FROM project_chat_rooms WHERE project_id=$1', [projectId])
                    .then((result) => Number(result.rows[0].revision)),
            pgUrl,
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

test('1. задача в фоне → фоновая работа → результат в чате (I/O 1–2)', async (t) => {
    guard(t);
    const source = await f.seed('Фоновая проверка проекта');
    const receipt = await f.service.start(f.req(), f.projectId, USER_ROOM, source, {
        method: 'openspec',
        instruction: 'Фоновая проверка проекта',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    assert.match(receipt.requestKey, /^[0-9a-f-]{36}$/);
    assert.equal(receipt.state, 'pending');
    assert.equal(receipt.projectId, f.projectId);
    const revisionBefore = await f.roomRevision();
    const message = await waitFor(() => f.agentMessage(source));
    assert.equal(message.status, 'done');
    assert.equal(message.reply_to_id, source);
    assert.ok(message.content.includes('Фоновая задача завершена'), 'результат с верификацией в чате');
    assert.equal(message.snapshot.agentId, 'background-agent');
    const job = await waitFor(async () => {
        const row = await f.job(receipt.requestKey);
        return row?.state === 'succeeded' ? row : undefined;
    });
    assert.equal(job.delivered, true);
    assert.equal(job.publish_state, 'published');
    assert.equal(job.runtime_version, '1.14.48');
    assert.equal(job.result.state, 'succeeded');
    assert.equal(job.result.checks[0].state, 'passed');
    assert.equal(job.result.checks[0].exitCode, 0);
    assert.equal(await f.roomRevision(), revisionBefore + 1, 'revision комнаты продвинулась (watch-клиенты увидят)');
});

test('2. контекст проекта подгружен в задачу (I/O 4)', async (t) => {
    guard(t);
    const source = await f.seed('Вторая фоновая задача');
    await f.service.start(f.req(), f.projectId, USER_ROOM, source, {
        method: 'bmad',
        instruction: 'Вторая фоновая задача',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const message = await waitFor(() => f.agentMessage(source));
    assert.ok(message.content.includes('Фоновая задача завершена'));
    const prompt = readFileSync(f.promptLog, 'utf8');
    const entries = prompt.split('\n---\n').filter((entry) => entry.length > 0);
    const last = entries[entries.length - 1];
    assert.ok(last.includes('Вторая фоновая задача'), 'инструкция в промпте; promptLog=' + JSON.stringify(prompt));
    assert.ok(
        last.includes('Project working directory: ' + f.projectDir),
        'контекст проекта (рабочая директория) в промпте; promptLog=' + JSON.stringify(prompt),
    );
});

test('3. drift-проверка compose/environment-model (I/O 7)', async (t) => {
    guard(t);
    const modelModule = await import(new URL('../production/environment-model.mjs', import.meta.url));
    const model = await modelModule.loadEnvironmentModel(root);
    assert.ok(model.services['background-agent'], 'сервис в модели окружения');
    const requiredEnv = Object.keys(model.services['background-agent'].requiredEnv).sort();
    assert.deepEqual(requiredEnv, [
        'BACKGROUND_AGENT_RUNTIME_ROOT',
        'CATALOG_PG_URL_FILE',
        'NEUROCENTER_INTERNAL_TOKEN_FILE',
        'NEUROCENTER_SERVICE',
        'NODE_ENV',
        'PANEL_URL',
    ]);
    const services = await modelModule.loadProductionCompose(root, model);
    assert.deepEqual(modelModule.structuralDrift(model, services), [], 'structural drift');
    const secretNames = await modelModule.parseSecretNames(root);
    const dead = modelModule.deadEnvironment(model, services, { root, secretNames });
    assert.deepEqual(dead.dead, [], 'dead env');
    assert.deepEqual(dead.noteErrors, [], 'env notes');
    const required = modelModule.requiredEnvironmentDrift(model, services, { root, secretNames });
    assert.deepEqual(required.missing, [], 'required env missing');
    assert.deepEqual(required.phantom, [], 'required env phantom');
});

test('4. нет компонента → явная ошибка; healthcheck --check (I/O 3)', async (t) => {
    guard(t);
    const cliPath = path.join(dist, 'background-agent/background-agent.cli.js');
    const runCheck = (env) =>
        new Promise((resolve) => {
            execFile(process.execPath, [cliPath, '--check'], { env, timeout: 60000 }, (error, stdout, stderr) => {
                resolve({
                    code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
                    stdout: String(stdout),
                    stderr: String(stderr),
                });
            });
        });
    const cleanEnv = (extra) => {
        const env = { ...process.env, ...extra };
        delete env.NODE_ENV;
        return env;
    };
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'nc-bga-empty-'));
    // Пакет отсутствует (пустой корень) → явная ENGINE-ошибка, exit 1, фиксированный классификатор.
    const missing = await runCheck(cleanEnv({ CATALOG_PG_URL: f.pgUrl, BACKGROUND_AGENT_RUNTIME_ROOT: emptyRoot }));
    assert.equal(missing.code, 1, 'check с пустым пакетом: exit 1\n' + missing.stdout + missing.stderr);
    const missingJson = JSON.parse(missing.stdout.trim().split('\n').pop());
    assert.equal(missingJson.ok, false);
    assert.equal(missingJson.error.code, 'ENGINE');
    // Действующий пакет + готовая схема → ok (healthcheck compose).
    const good = await runCheck(cleanEnv({ CATALOG_PG_URL: f.pgUrl, BACKGROUND_AGENT_RUNTIME_ROOT: f.pkgRoot }));
    assert.equal(good.code, 0, 'check с пакетом: exit 0\n' + good.stdout + good.stderr);
    const goodJson = JSON.parse(good.stdout.trim().split('\n').pop());
    assert.equal(goodJson.ok, true);
    assert.equal(goodJson.engine.version, '1.14.48');
    assert.equal(goodJson.engine.sha256.length, 64);
    assert.equal(goodJson.database.ready, true);
});

test('teardown', async (t) => {
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
