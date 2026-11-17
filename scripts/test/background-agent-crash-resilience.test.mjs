/**
 * FR-305 (agt-11, фаза B): отказоустойчивость фоновой агента — e2e на живом PostgreSQL и
 * реальном executor CLI (`node dist/background-agent/background-agent.cli.js`). Сценарии:
 *  T1. kill -9 mid-run (paid step journaled) → lease → reaper → `unknown` **без повторного
 *      исполнения** (контракт epic-8 entry 12: journaled paid step не повторяется);
 *  T2. in-process крах (uncaughtException на dispatch-pass, e2e fault-injection env) **до**
 *      paid step → crash-handler: attempts+1, backoff, error_events (AD-O5) + security event
 *      (AD-O7), controlled exit(1) → рестарт → успех;
 *  T3. crash-loop ×3 (retry budget) → **dead-letter** (явная остановка) + alert channel
 *      (эпик 6 entry 13: alerts.jsonl, один алерт по транзишену) + error/security события;
 *  T4. **реальный OOM mid-turn** (V8 abort, --max-old-space-size=64) → verified failed receipt
 *      (EXECUTION_FAILED, stage execution) — это результат, НЕ крах: attempts=0, нет error_events,
 *      executor жив;
 *  T5. PG-down mid-run → best-effort (crash path не блокируется: tick-failed, loop жив) → после
 *      восстановления lease → reaper → `unknown`;
 *  T6. потеря ACK (delivered=false после settle) → повторная доставка **той же** квитанции:
 *      слот (source_message_id, agentId) занят → withhold, никогда не дублируется.
 *
 * Отклонения (зафиксированы в Progress): процессный рестарт вместо docker-restart (root-композ
 * не трогаем); `error_events` создаётся e2e (таблицы нет в main, AD-O5-стория ready-for-dev);
 * lease 5 минут сжимается SQL fast-forward (documented time-compression), reaper/claim — реальные;
 * T2/T3 крашат процесс env-gated e2e fault-injection хуком CLI (BACKGROUND_AGENT_E2E_CRASH_DISPATCH:
 * реальный uncaughtException на dispatch-pass — синтезируется только сигнал, handler/stores/exit —
 * реальный production-путь; в production окружение никогда не выставлено).
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
const cliPath = path.join(dist, 'background-agent/background-agent.cli.js');

let skip = false,
    bootstrapError = '',
    f = null,
    container = null,
    port = 0,
    activePool = null;

/** Фиксированные классификаторы (AD-O8) — повторяем из модулей, ассерты не читают src. */
const PROCESS_CRASH_SAFE = 'Background agent process crashed (uncaught exception or unhandled rejection).';
const DEAD_LETTER_SAFE = 'Background agent job dead-lettered: retry budget exhausted (crash policy).';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const waitFor = async (fn, timeoutMs = 90000, intervalMs = 500, diagnose) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) {
            let detail = '';
            if (diagnose) {
                try {
                    detail = await diagnose();
                } catch {
                    detail = '(diagnostics unavailable)';
                }
            }
            throw new Error('Таймаут ожидания состояния фонового агента.\n' + detail);
        }
        await sleep(intervalMs);
    }
};
/**
 * In-process PG pool. T5 stops the PG container mid-run: the postmaster FATALs every idle
 * connection on shutdown, and a Pool without an 'error' listener would turn that expected fatal
 * into an uncaughtException. T5 additionally ends the pool under control on the same tick as the
 * docker stop (which blocks the event loop, so the buffered fatal frames are discarded with the
 * sockets instead of being delivered to a severed client) and builds a fresh pool via this
 * factory after the PG returns.
 */
const makePool = (pgUrl) => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: pgUrl, max: 4 });
    pool.on('error', () => undefined);
    return pool;
};

/** Сколько paid steps (промптов) записал движок в promptLog. */
const countPrompts = (file) => {
    try {
        return readFileSync(file, 'utf8')
            .split('\n---\n')
            .filter((entry) => entry.length > 0).length;
    } catch {
        return 0;
    }
};

/**
 * Fake автономный пакет (тот же loopback-протокол, что в background-agent-server.test.mjs):
 * runtime.json (pin 1.14.48 + sha256) + bin/opencode-probe. `{ oom: true }` — отдельный движок с
 * `--max-old-space-size=64`: на /session/ses_fake/message аллоцирует память до реального V8 abort
 * (SIGABRT) mid-turn — это процесс, умирающий посреди paid step, а не сценарный «failed result».
 */
const writeAutonomousPackage = (pkgRoot, { oom = false } = {}) => {
    const binDir = path.join(pkgRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const engine = path.join(binDir, 'opencode-probe');
    const shebang = oom ? '#!/usr/bin/env -S node --max-old-space-size=64' : '#!/usr/bin/env node';
    const messageHandler = oom
        ? `        if (req.method === 'POST' && url.pathname === '/session/ses_fake/message') {
            // Real V8 OOM mid-turn: held allocations grow the old space to a true heap abort
            // (the process dies on SIGABRT mid-request; the runtime sees the engine child exit).
            const keep = [];
            for (;;) keep.push(new Array(1024 * 1024).fill(1));
        }`
        : `        if (req.method === 'POST' && url.pathname === '/session/ses_fake/message') {
            const parsed = JSON.parse(body || '{}');
            const text = (parsed.parts && parsed.parts[0] && parsed.parts[0].text) || '';
            if (process.env.NC_E2E_PROMPT_LOG) fs.appendFileSync(process.env.NC_E2E_PROMPT_LOG, text + '\\n---\\n');
            const finish = () =>
                send(200, {
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
            const delay = Number(process.env.NC_E2E_TURN_DELAY_MS || 0);
            if (delay > 0) return setTimeout(finish, delay);
            return finish();
        }`;
    const code = `${shebang}
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
${messageHandler}
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

const guard = (t) => {
    if (skip) t.skip('bootstrap недоступен: ' + bootstrapError);
};

test('bootstrap: live PG + dist + автономные пакеты (healthy + OOM) + error_events', async (t) => {
    container = 'nc-agt11-e2e-' + randomUUID().slice(0, 8);
    port = 56232 + (process.pid % 200);
    let cli = null,
        workspace = null;
    try {
        execFileSync(
            'docker',
            [
                'run',
                '-d',
                // no --rm: T5 does docker stop/start on the SAME container (teardown removes it)
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
        workspace = mkdtempSync(path.join(tmpdir(), 'nc-agt11-cr-'));
        const projectsRoot = path.join(workspace, 'projects'),
            projectId = 'prj-cr-e2e',
            projectDir = path.join(projectsRoot, projectId);
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(path.join(projectDir, 'check.cjs'), 'process.exit(0);\n');
        const pkgOk = writeAutonomousPackage(path.join(workspace, 'pkg-ok')),
            pkgOom = writeAutonomousPackage(path.join(workspace, 'pkg-oom'), { oom: true }),
            alertsFile = path.join(workspace, 'alerts.jsonl');
        process.env.NEUROCENTER_INTERNAL_TOKEN = randomBytes(32).toString('hex');
        const pgUrl = 'postgres://postgres:qa@127.0.0.1:' + port + '/postgres';
        const pool = makePool(pgUrl);
        activePool = pool; // the f.* helpers read activePool at call time (T5 recycles it)
        // Readiness = the driver can actually query (a docker-exec pg_isready can report «ready»
        // while the postmaster is still finishing startup — a real query is the ground truth).
        const probeDeadline = Date.now() + 120000;
        for (;;) {
            try {
                await pool.query('SELECT 1');
                break;
            } catch {
                if (Date.now() > probeDeadline) throw new Error('PG readiness timeout: ' + container);
                await sleep(500);
            }
        }
        // error_events: таблицы нет в main (AD-O5-стория ready-for-dev) — e2e создаёт её по frozen
        // AD-O5 column-контракту (id/service/ts/level/request_id/message/stack_hint).
        await pool.query(
            `CREATE TABLE IF NOT EXISTS error_events (
                id bigserial PRIMARY KEY,
                service text NOT NULL,
                ts timestamptz NOT NULL,
                level text NOT NULL CHECK (level IN ('error','critical')),
                request_id text NOT NULL,
                message text NOT NULL,
                stack_hint text
            )`,
        );
        // The catalog schema (projects/… + background_agent_*) is ensured by the first CLI start
        // (ensureCatalogSchema); the bootstrap pass exists to get it ready, then is killed.
        const bootstrapPromptLog = path.join(workspace, 'bootstrap.prompts');
        const bootstrapEnv = {
            ...process.env,
            CATALOG_PG_URL: pgUrl,
            BACKGROUND_AGENT_RUNTIME_ROOT: pkgOk,
            PROJECTS_ROOT: projectsRoot,
            NEUROCENTER_ALERTS_FILE: alertsFile,
            NC_E2E_PROMPT_LOG: bootstrapPromptLog,
            NC_E2E_TURN_DELAY_MS: '0',
        };
        delete bootstrapEnv.NODE_ENV;
        const { cli: bootstrapCli, started: bootstrapStarted } = spawnCli(bootstrapEnv, {});
        await bootstrapStarted;
        await killCli(bootstrapCli);
        const { PgBackgroundAgentStore } = require(path.join(dist, 'background-agent/pg-store.js'));
        const { BackgroundAgentService } = require(path.join(dist, 'background-agent/service.js'));
        const service = new BackgroundAgentService({ pool }, new PgBackgroundAgentStore(pool));
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [
            projectId,
            'Фоновый агент crash-resilience e2e',
        ]);
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
            await activePool.query(
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
        const cliEnv = (pkgRoot, promptLog, delayMs, crashOnDispatch = false) => {
            const env = {
                ...process.env,
                CATALOG_PG_URL: pgUrl,
                BACKGROUND_AGENT_RUNTIME_ROOT: pkgRoot,
                PROJECTS_ROOT: projectsRoot,
                NEUROCENTER_ALERTS_FILE: alertsFile,
                NC_E2E_PROMPT_LOG: promptLog,
                NC_E2E_TURN_DELAY_MS: String(delayMs ?? 0),
            };
            delete env.NODE_ENV;
            if (crashOnDispatch) env.BACKGROUND_AGENT_E2E_CRASH_DISPATCH = '1';
            return env;
        };
        f = {
            // T5 recycles the pool (ends it under control during the PG-down window); the getter
            // keeps f.pool / the queries below bound to the CURRENT pool at call time.
            get pool() {
                return activePool;
            },
            service,
            workspace,
            pkgOk,
            pkgOom,
            alertsFile,
            projectDir,
            projectId,
            owner,
            pgUrl,
            req: () => ({
                headers: {
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN,
                    'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: owner, activeRole: 'Админ проекта' })),
                },
            }),
            seed,
            startCli: (opts) =>
                spawnCli(cliEnv(opts.pkgRoot, opts.promptLog, opts.delayMs ?? 0, opts.crashOnDispatch), opts),
            agentMessage: (sourceId) =>
                activePool
                    .query(
                        `SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='agent' AND source_message_id=$2 AND (snapshot->>'agentId')='background-agent'`,
                        [projectId, sourceId],
                    )
                    .then((result) => result.rows[0]),
            agentMessages: (sourceId) =>
                activePool
                    .query(
                        `SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='agent' AND source_message_id=$2`,
                        [projectId, sourceId],
                    )
                    .then((result) => result.rows),
            job: (requestId) =>
                activePool
                    .query('SELECT * FROM background_agent_jobs WHERE request_id=$1::uuid', [requestId])
                    .then((result) => result.rows[0]),
            roomRevision: () =>
                activePool
                    .query('SELECT revision::int AS revision FROM project_chat_rooms WHERE project_id=$1', [projectId])
                    .then((result) => Number(result.rows[0].revision)),
            errorEvents: (requestId) =>
                activePool
                    .query(
                        'SELECT service, ts, level, request_id, message, stack_hint FROM error_events WHERE request_id=$1 ORDER BY ts, id',
                        [requestId],
                    )
                    .then((result) => result.rows),
            securityEvents: (requestId, action) =>
                activePool
                    .query(
                        'SELECT actor, action, resource_id, before_state, after_state FROM security_events WHERE resource_id=$1 AND action=$2',
                        [requestId, action],
                    )
                    .then((result) => result.rows),
            /** Documented time-compression: a 5-minute lease cannot be awaited in a minutes-long test. */
            expireLease: (requestId) =>
                activePool.query(
                    `UPDATE background_agent_jobs SET lease_until = now() - interval '1 second' WHERE request_id=$1::uuid`,
                    [requestId],
                ),
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

/** All started executor processes (teardown kills whatever is still alive). */
const activeClis = new Set();

const spawnCli = (env, opts = {}) => {
    const proc = spawn(process.execPath, [cliPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', (chunk) => (output += chunk.toString()));
    proc.stderr.on('data', (chunk) => (output += chunk.toString()));
    proc.on('error', (error) => (output += String(error)));
    const cli = {
        proc,
        output: () => output,
        waitExit: (timeoutMs = 60000) =>
            new Promise((resolve) => {
                const t0 = Date.now();
                const check = () => {
                    if (proc.exitCode !== null || proc.signalCode !== null)
                        return resolve({ code: proc.exitCode, signal: proc.signalCode });
                    if (Date.now() - t0 > timeoutMs) {
                        try {
                            proc.kill('SIGKILL');
                        } catch {
                            /* best effort */
                        }
                        return resolve({ code: null, signal: 'SIGKILL(timeout)' });
                    }
                    setTimeout(check, 200);
                };
                check();
            }),
    };
    activeClis.add(cli);
    const started =
        opts.waitStart === false ? Promise.resolve() : waitFor(() => /"event":\s*"started"/.test(output), 120000);
    started.catch(() => killCli(cli));
    return { cli, started };
};

const killCli = async (cli) => {
    if (!cli || cli.killed) return;
    cli.killed = true;
    activeClis.delete(cli);
    if (cli.proc.exitCode === null && cli.proc.signalCode === null) {
        cli.proc.kill('SIGTERM');
        await cli.waitExit(15000);
        if (cli.proc.exitCode === null && cli.proc.signalCode === null) cli.proc.kill('SIGKILL');
    }
};

/**
 * A crash-prone pass (T2/T3): the executor runs with the e2e fault-injection env, so the CLI
 * raises a REAL uncaughtException on the dispatch pass — before the claim and the paid step.
 * The real production crash handler then runs end-to-end: structured log → error store →
 * job-level crash record (attempts+1, backoff deadline, the row back to pending) → security
 * event → controlled exit(1). The row is claimable from the start, so the crash happens on the
 * FIRST tick, deterministically, with no effects recorded.
 */
const crashPass = async (promptLog) => {
    const { cli, started } = f.startCli({ pkgRoot: f.pkgOk, promptLog, delayMs: 0, crashOnDispatch: true });
    await started;
    const exit = await cli.waitExit(60000);
    return { cli, exit };
};

test('T1. kill -9 mid-run (paid step journaled) → reaper → unknown без повторного исполнения (entry 12)', async (t) => {
    guard(t);
    const source = await f.seed('T1 kill -9 mid-run');
    const receipt = await f.service.start(f.req(), f.projectId, USER_ROOM, source, {
        method: 'openspec',
        instruction: 'T1 kill -9 mid-run',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const requestId = receipt.requestKey;
    const promptLog1 = path.join(f.workspace, 't1-p1.prompts'),
        promptLog2 = path.join(f.workspace, 't1-p2.prompts');
    const { cli: cli1, started } = f.startCli({ pkgRoot: f.pkgOk, promptLog: promptLog1, delayMs: 8000 });
    await started;
    // The run has started: the execution checkpoint (the paid step) is journaled before dispatch.
    await waitFor(() => cli1.output().includes('"event":"dispatch"') && cli1.output().includes(requestId), 30000);
    await sleep(2000); // the 8s turn is in flight: the paid step is consumed, no result yet
    cli1.proc.kill('SIGKILL');
    await killCli(cli1);
    assert.equal(countPrompts(promptLog1), 1, 'paid step consumed exactly once (the killed pass)');
    // The hard kill cannot run in-process code: the row keeps its lease until the reaper reclaims it.
    await f.expireLease(requestId); // documented time-compression of the 5-minute lease
    const { cli: cli2, started: started2 } = f.startCli({ pkgRoot: f.pkgOk, promptLog: promptLog2, delayMs: 0 });
    await started2;
    const message = await waitFor(
        () => f.agentMessage(source),
        150000,
        500,
        async () =>
            'exitCode=' +
            cli2.proc.exitCode +
            '\ncli2:\n' +
            cli2.output() +
            '\njob: ' +
            JSON.stringify(await f.job(requestId)),
    );
    assert.ok(
        message.content.includes('Результат фоновой задачи не подтверждён'),
        'unknown receipt in the chat: ' + message.content,
    );
    const job = await f.job(requestId);
    assert.equal(job.state, 'failed'); // the store maps a non-succeeded result to the row state
    assert.equal(job.result.state, 'unknown');
    assert.equal(job.result.stage, 'execution');
    assert.equal(job.result.failure.code, 'UNKNOWN_OUTCOME');
    assert.equal(job.unknown, true);
    assert.equal(job.attempts, 0, 'SIGKILL leaves no in-process crash record (lease/reaper path)');
    assert.equal(countPrompts(promptLog2), 0, 'the journaled paid step is NEVER re-executed (entry 12)');
    await killCli(cli2);
});

test('T2. in-process крах (uncaughtException, dispatch-pass) до paid step → attempts+1, backoff, error_events + security event → success', async (t) => {
    guard(t);
    const source = await f.seed('T2 crash before the paid step');
    const receipt = await f.service.start(f.req(), f.projectId, USER_ROOM, source, {
        method: 'openspec',
        instruction: 'T2 crash before the paid step',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const requestId = receipt.requestKey;
    const promptLog1 = path.join(f.workspace, 't2-p1.prompts'),
        promptLog2 = path.join(f.workspace, 't2-p2.prompts');
    // Pass 1: the deterministic pre-paid-step crash (the e2e fault-injection env; the real crash handler).
    const { cli: cli1, exit } = await crashPass(promptLog1);
    assert.equal(exit.code, 1, 'controlled exit(1) after the crash record\n' + cli1.output());
    assert.ok(cli1.output().includes('"event":"process-crash"'), 'structured crash log (stderr)');
    assert.ok(cli1.output().includes('"code":"PROCESS_CRASH"'));
    assert.equal(countPrompts(promptLog1), 0, 'no paid step before the crash');
    const job1 = await f.job(requestId);
    assert.equal(job1.state, 'pending', 'the row is back to pending with the backoff deadline');
    assert.equal(job1.attempts, 1);
    assert.ok(job1.next_attempt_at, 'backoff deadline set');
    // Observability (AD-O5/AD-O7): one error_events row + one security event, fixed classifiers only.
    const errorRows = await f.errorEvents(requestId);
    assert.equal(errorRows.length, 1, 'exactly one error_events row for the in-flight job');
    assert.equal(errorRows[0].level, 'critical');
    assert.equal(errorRows[0].message, PROCESS_CRASH_SAFE);
    assert.ok(!JSON.stringify(errorRows[0]).includes('T2'), 'AD-O8: no raw error text in the error store');
    const crashEvents = await f.securityEvents(requestId, 'background_agent.crash');
    assert.equal(crashEvents.length, 1);
    assert.equal(crashEvents[0].actor, 'background-agent');
    assert.ok(!JSON.stringify(crashEvents).includes('T2'), 'AD-O8: no raw error text in the security event');
    await killCli(cli1);
    // Pass 2: after the backoff the same job succeeds (one paid step).
    const { cli: cli2, started } = f.startCli({ pkgRoot: f.pkgOk, promptLog: promptLog2, delayMs: 0 });
    await started;
    const message = await waitFor(
        () => f.agentMessage(source),
        90000,
        500,
        async () =>
            'exitCode=' +
            cli2.proc.exitCode +
            '\ncli2:\n' +
            cli2.output() +
            '\njob: ' +
            JSON.stringify(await f.job(requestId)),
    );
    assert.ok(message.content.includes('Фоновая задача завершена'), 'retry after the backoff succeeds');
    const job2 = await f.job(requestId);
    assert.equal(job2.state, 'succeeded');
    assert.equal(job2.result.state, 'succeeded');
    assert.equal(countPrompts(promptLog2), 1, 'exactly one paid step (the successful pass)');
    assert.equal((await f.errorEvents(requestId)).length, 1, 'the success pass adds no error row');
    await killCli(cli2);
});

test('T3. crash-loop ×3 (retry budget) → dead-letter + alert (эпик 6 entry 13) + observability', async (t) => {
    guard(t);
    const source = await f.seed('T3 crash loop to dead letter');
    const receipt = await f.service.start(f.req(), f.projectId, USER_ROOM, source, {
        method: 'openspec',
        instruction: 'T3 crash loop to dead letter',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const requestId = receipt.requestKey;
    const promptLogs = [1, 2, 3, 4].map((i) => path.join(f.workspace, `t3-p${i}.prompts`));
    // Passes 1–3: the deterministic pre-paid-step crash (the e2e fault-injection env), the
    // job-level budget advances 1→2→3; each pass exits controlled(1) after recording.
    for (let i = 0; i < 3; i++) {
        const { cli, exit } = await crashPass(promptLogs[i]);
        assert.equal(exit.code, 1, 'pass ' + (i + 1) + ': controlled exit(1)\n' + cli.output());
        assert.equal(countPrompts(promptLogs[i]), 0, 'pass ' + (i + 1) + ': no paid step');
        const job = await f.job(requestId);
        assert.equal(job.attempts, i + 1, 'pass ' + (i + 1) + ': the crash budget advanced');
        assert.equal(job.state, 'pending');
        await killCli(cli);
    }
    // Pass 4: no crash — the budget is exhausted → dead letter (explicit stop) + the alert. The
    // row is already backoff-pending from pass 3; the first claimable tick settles it.
    const { cli: cli4, started } = f.startCli({ pkgRoot: f.pkgOk, promptLog: promptLogs[3], delayMs: 0 });
    await started;
    await waitFor(
        () => cli4.output().includes('"event":"dead-letter-alerted"'),
        60000,
        500,
        async () => {
            const job = await f.job(requestId);
            return 'exitCode=' + cli4.proc.exitCode + '\ncli4:\n' + cli4.output() + '\njob: ' + JSON.stringify(job);
        },
    );
    const job = await f.job(requestId);
    assert.equal(job.state, 'dead_letter');
    assert.equal(job.dead_letter_reason, 'Retry budget exhausted (crash policy).');
    assert.equal(job.attempts, 3);
    assert.equal(job.result.state, 'unknown', 'the explicit-stop receipt');
    assert.equal(job.delivered, true);
    assert.equal(countPrompts(promptLogs[3]), 0, 'the dead-lettered pass runs nothing');
    // Observability: 3× process-crash + 1× dead-letter error rows; 3× crash + 1× dead-letter events.
    const errorRows = await f.errorEvents(requestId);
    assert.equal(errorRows.length, 4);
    assert.equal(errorRows.filter((row) => row.message === PROCESS_CRASH_SAFE).length, 3);
    assert.equal(errorRows.filter((row) => row.message === DEAD_LETTER_SAFE).length, 1);
    for (const row of errorRows) assert.equal(row.level, 'critical');
    assert.equal((await f.securityEvents(requestId, 'background_agent.crash')).length, 3);
    const deadLetterEvents = await f.securityEvents(requestId, 'background_agent.dead_letter');
    assert.equal(deadLetterEvents.length, 1);
    assert.ok(!JSON.stringify([errorRows, deadLetterEvents]).includes('T3'), 'AD-O8: only fixed classifiers');
    // The alert channel (entry 13): exactly ONE alert on the → dead_letter transition.
    const alerts = readFileSync(f.alertsFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    assert.equal(alerts.length, 1, 'exactly one dead-letter alert\n' + JSON.stringify(alerts));
    assert.deepEqual(alerts[0], {
        ts: alerts[0].ts,
        source: 'background-agent',
        severity: 'critical',
        service: 'background-agent',
        event: 'dead_letter',
        requestKey: job.request_key,
        requestId,
    });
    // The explicit stop reaches the chat as the unknown receipt (the operator acts, no auto-retry).
    const message = await waitFor(
        () => f.agentMessage(source),
        30000,
        500,
        async () =>
            'exitCode=' +
            cli4.proc.exitCode +
            '\ncli4:\n' +
            cli4.output() +
            '\njob: ' +
            JSON.stringify(await f.job(requestId)),
    );
    assert.ok(message.content.includes('Результат фоновой задачи не подтверждён'), message.content);
    await killCli(cli4);
});

test('T4. реальный OOM mid-turn → verified failed receipt (НЕ крах): attempts=0, нет error_events, CLI жив', async (t) => {
    guard(t);
    const source = await f.seed('T4 OOM mid-turn');
    const receipt = await f.service.start(f.req(), f.projectId, USER_ROOM, source, {
        method: 'openspec',
        instruction: 'T4 OOM mid-turn',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const requestId = receipt.requestKey;
    const promptLog = path.join(f.workspace, 't4.prompts');
    const { cli, started } = f.startCli({ pkgRoot: f.pkgOom, promptLog, delayMs: 0 });
    await started;
    const message = await waitFor(
        () => f.agentMessage(source),
        120000,
        500,
        async () =>
            'exitCode=' +
            cli.proc.exitCode +
            '\ncli:\n' +
            cli.output() +
            '\njob: ' +
            JSON.stringify(await f.job(requestId)),
    );
    assert.ok(
        message.content.includes('Фоновая задача не выполнена на этапе «execution»'),
        'verified failed receipt (stage execution): ' + message.content,
    );
    assert.ok(message.content.includes('EXECUTION_FAILED'));
    const job = await f.job(requestId);
    assert.equal(job.state, 'failed');
    assert.equal(job.result.state, 'failed');
    assert.equal(job.result.stage, 'execution');
    assert.equal(job.result.failure.code, 'EXECUTION_FAILED');
    assert.equal(job.result.checks[0].state, 'not_run');
    assert.equal(job.attempts, 0, 'a verified run failure is a RESULT, not a crash (no budget spend)');
    assert.equal((await f.errorEvents(requestId)).length, 0, 'no error_events for a verified failure');
    assert.ok(cli.output().includes('"event":"processed"'), 'the executor settled the receipt and keeps serving');
    assert.equal(cli.proc.exitCode, null, 'the process survives a verified run failure (no controlled exit)');
    await killCli(cli);
});

test('T5. PG-down mid-run → best-effort (tick-failed, loop жив) → lease → reaper → unknown', async (t) => {
    guard(t);
    const source = await f.seed('T5 PG down mid-turn');
    const receipt = await f.service.start(f.req(), f.projectId, USER_ROOM, source, {
        method: 'openspec',
        instruction: 'T5 PG down mid-turn',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const requestId = receipt.requestKey;
    const promptLog = path.join(f.workspace, 't5.prompts');
    const { cli, started } = f.startCli({ pkgRoot: f.pkgOk, promptLog, delayMs: 8000 });
    await started;
    await waitFor(() => cli.output().includes('"event":"dispatch"') && cli.output().includes(requestId), 30000);
    await sleep(2000); // the paid step is journaled and the 8s turn is in flight
    // PG down mid-run: the turn finishes, but the result journal fails — the crash path is best-effort.
    execFileSync('docker', ['stop', container], { timeout: 60000, stdio: 'pipe' });
    // The postmaster FATALs every idle connection on shutdown. The docker stop above blocks the
    // event loop, so those fatal frames are still buffered undelivered: ending the pool on this
    // same tick closes the clients under control and discards the frames — no severed socket can
    // later emit a listener-less error (the ~1/8 run flake: uncaughtException
    // "terminating connection due to administrator command"). The pool is recycled below.
    await activePool.end();
    activePool = null;
    await waitFor(
        () => cli.output().includes('"event":"tick-failed"'),
        90000,
        500,
        async () =>
            'exitCode=' +
            cli.proc.exitCode +
            '\ncli:\n' +
            cli.output() +
            '\njob: ' +
            JSON.stringify(await f.job(requestId)),
    );
    assert.equal(cli.proc.exitCode, null, 'the executor survives a PG outage (the loop keeps polling)');
    execFileSync('docker', ['start', container], { timeout: 60000, stdio: 'pipe' });
    await waitForTcp('127.0.0.1', port, 60000);
    // Recycle: a fresh pool + service/store bound to the recovered PG. The f.* helpers read
    // activePool/f.service at call time, so T6 and the teardown see the live pair.
    const upDeadline = Date.now() + 60000;
    activePool = makePool(f.pgUrl);
    for (;;) {
        try {
            await activePool.query('SELECT 1');
            break;
        } catch {
            if (Date.now() > upDeadline) throw new Error('PG did not come back: ' + container);
            await sleep(500);
        }
    }
    const { PgBackgroundAgentStore } = require(path.join(dist, 'background-agent/pg-store.js'));
    const { BackgroundAgentService } = require(path.join(dist, 'background-agent/service.js'));
    f.service = new BackgroundAgentService({ pool: activePool }, new PgBackgroundAgentStore(activePool));
    await f.expireLease(requestId); // documented time-compression of the 5-minute lease
    const message = await waitFor(
        () => f.agentMessage(source),
        180000,
        500,
        async () =>
            'exitCode=' +
            cli.proc.exitCode +
            '\ncli:\n' +
            cli.output() +
            '\njob: ' +
            JSON.stringify(await f.job(requestId)),
    );
    assert.ok(message.content.includes('Результат фоновой задачи не подтверждён'), message.content);
    const job = await f.job(requestId);
    assert.equal(job.result.state, 'unknown');
    assert.equal(job.attempts, 0, 'a PG outage is not a crash record (the row settles via the reaper)');
    assert.equal(countPrompts(promptLog), 1, 'the paid step ran exactly once (no re-execution)');
    await killCli(cli);
});

test('T6. потеря ACK → повторная доставка ТОЙ ЖЕ квитанции: withhold, никогда не дублируется', async (t) => {
    guard(t);
    const source = await f.seed('T6 lost ACK redelivery');
    const receipt = await f.service.start(f.req(), f.projectId, USER_ROOM, source, {
        method: 'openspec',
        instruction: 'T6 lost ACK redelivery',
        checks: [{ command: 'node', args: ['check.cjs'] }],
        context: { project: {} },
    });
    const requestId = receipt.requestKey;
    const promptLog = path.join(f.workspace, 't6.prompts');
    const { cli, started } = f.startCli({ pkgRoot: f.pkgOk, promptLog, delayMs: 0 });
    await started;
    // First delivery: published, the room revision advances.
    const message1 = await waitFor(
        () => f.agentMessage(source),
        60000,
        500,
        async () =>
            'exitCode=' +
            cli.proc.exitCode +
            '\ncli:\n' +
            cli.output() +
            '\njob: ' +
            JSON.stringify(await f.job(requestId)),
    );
    assert.ok(message1.content.includes('Фоновая задача завершена'));
    const revisionBefore = await f.roomRevision();
    const resultBefore = (await f.job(requestId)).result;
    // Simulated lost ACK: the sink's COMMIT committed, but the delivery mark never persisted.
    await f.pool.query(`UPDATE background_agent_jobs SET delivered=false WHERE request_id=$1::uuid`, [requestId]);
    // The executor re-claims the settled-but-undelivered row (no lease) and re-delivers the SAME receipt;
    // the (source_message_id, agentId) slot blocks the duplicate → withhold, never a second message.
    await waitFor(
        async () => {
            const job = await f.job(requestId);
            return job.delivered && job.publish_state === 'withheld';
        },
        90000,
        500,
        async () =>
            'exitCode=' +
            cli.proc.exitCode +
            '\ncli:\n' +
            cli.output() +
            '\njob: ' +
            JSON.stringify(await f.job(requestId)),
    );
    const job = await f.job(requestId);
    assert.deepEqual(job.result, resultBefore, 'the SAME recorded receipt (never a new result)');
    assert.equal(job.delivered, true, 'the re-delivery settles (the duty is done)');
    const messages = await f.agentMessages(source);
    assert.equal(messages.length, 1, 'no duplicate message in the chat');
    assert.equal(await f.roomRevision(), revisionBefore, 'no revision bump on the withheld re-delivery');
    assert.equal(countPrompts(promptLog), 1, 'the re-delivery re-executes nothing');
    await killCli(cli);
});

test('teardown', async (t) => {
    if (skip) return;
    for (const cli of [...activeClis]) await killCli(cli);
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
    for (const cli of [...activeClis]) {
        if (cli.proc.exitCode === null && cli.proc.signalCode === null) {
            try {
                cli.proc.kill('SIGKILL');
            } catch {
                /* best effort */
            }
        }
    }
    if (container) {
        try {
            execFileSync('docker', ['rm', '-f', container], { timeout: 10000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
    }
});
