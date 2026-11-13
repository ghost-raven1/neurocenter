/**
 * FR-304 (agt-06): проверяемый результат агента — верификация, а не «сделано».
 *
 * E2E на живом PostgreSQL и собранном catalog-service: подтверждение device-заданий
 * идёт через реальный приём (completeDeviceJob → DeviceController.complete).
 * Два задания:
 *  - run-agent-method-workflow — device-контракт метод-воркфлоу (потребляет универсальные семантики);
 *  - run-verified-agent-work — задание с объявленной верификацией (универсальный fail-closed гейт).
 * Сценарии: результат+exit-code, «сделано» без верификации → отказ, succeeded только после
 * успешных выбранных проверок, явные not_run/failed/unknown, провенанс (NFR-4).
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const shared = require(fileURLToPath(new URL('../../services/shared/agent-method-workflow.cjs', import.meta.url)));

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

test('bootstrap: live PG + catalog dist', async (t) => {
    container = 'nc-verify-e2e-' + randomUUID().slice(0, 8);
    port = 55732 + (process.pid % 200);
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
        const { Pool } = require('pg');
        process.env.CATALOG_PG_URL = 'postgres://postgres:qa@127.0.0.1:' + port + '/postgres';
        process.env.NODE_ENV = 'production';
        process.env.SSO_DISABLE = 'false';
        process.env.NEUROCENTER_INTERNAL_TOKEN = randomBytes(32).toString('hex');
        process.env.API_GATEWAY_URL = 'http://127.0.0.1:9';
        const dist = fileURLToPath(new URL('../../services/catalog-service/dist/', import.meta.url));
        const { CatalogService } = require(path.join(dist, 'catalog/catalog.service.js'));
        const { AccessDb } = require(path.join(dist, 'access/access-db.js'));
        const { DeviceStore } = require(path.join(dist, 'devices/device-store.js'));
        const { DeviceController } = require(path.join(dist, 'devices/device.controller.js'));
        const pool = new Pool({ connectionString: process.env.CATALOG_PG_URL, max: 2 });
        const catalog = new CatalogService();
        await catalog.ensureSchema();
        const access = new AccessDb();
        await access.onModuleInit();
        const store = new DeviceStore(access);
        await store.onModuleInit();
        const controller = new DeviceController(store, {}, {}, {});
        const projectId = 'prj-verify',
            owner = 'owner@example.test',
            deviceId = randomUUID(),
            token = randomBytes(32).toString('hex'),
            bindingId = sha('verify-binding'),
            instanceId = randomUUID();
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Проверяемый результат']);
        await pool.query('INSERT INTO platform_users(email) VALUES($1)', [owner]);
        await pool.query(
            "INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,'owner',$2,'Владелец','Админ проекта')",
            [projectId, owner],
        );
        await pool.query(
            'INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
            [
                deviceId,
                owner,
                'Админ проекта',
                'Верифицируемое MCP',
                'b'.repeat(64),
                sha(token),
                JSON.stringify({
                    capabilities: ['workspace-instance-v1', 'agent-method-workflow-v1'],
                    bindings: [
                        { projectId, folderName: 'verify-folder', bindingId, instanceId, valid: true },
                    ],
                }),
            ],
        );
        f = {
            pool,
            catalog,
            access,
            store,
            controller,
            projectId,
            deviceId,
            token,
            bindingId,
            instanceId,
            request: {
                headers: {
                    authorization: 'Bearer ' + token,
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN,
                },
            },
            row: async (id) => (await pool.query('SELECT * FROM bridge_jobs WHERE id=$1', [id])).rows[0],
            make: async (kind, payload) => {
                const id = randomUUID(),
                    lease = randomUUID();
                await pool.query(
                    `INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,lease,lease_until,percent)
                    VALUES($1,$2,$3,'Админ проекта',$4,$5,$6::jsonb,$7,$8,'running',$9,now()+interval '3 minutes',35)`,
                    [id, deviceId, owner, projectId, kind, JSON.stringify(payload), randomUUID(), 'c'.repeat(64), lease],
                );
                return { id, lease };
            },
            ack: (job, result, state = 'succeeded') =>
                controller.complete(f.request, job.id, { lease: job.lease, state, message: 'Готово', result }),
        };
    } catch (error) {
        skip = true;
        bootstrapError = error.stack || String(error);
        console.error('bootstrap failed:\n' + bootstrapError);
        try {
            if (container) execFileSync('docker', ['rm', '-f', container], { timeout: 10000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
        container = null;
    }
});

const methodPayload = () =>
    shared.normalizeAgentMethodWorkflowPayload({
        protocol: shared.AGENT_METHOD_WORKFLOW_PROTOCOL,
        workflowId: randomUUID(),
        requestId: randomUUID(),
        projectId: f.projectId,
        bindingId: f.bindingId,
        instanceId: f.instanceId,
        method: 'openspec',
        methodVersion: '1.15.0',
        stage: 'full-cycle',
        instruction: 'Проверяемое задание',
        deadlineAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        runtime: 'opencode',
        checks: [{ command: 'node', args: ['check.cjs'] }],
    });
const methodResult = (workflowId, over = {}) => ({
    protocol: shared.AGENT_METHOD_WORKFLOW_PROTOCOL,
    workflowId,
    method: 'openspec',
    methodVersion: '1.15.0',
    runtime: 'opencode',
    state: 'succeeded',
    stage: 'completed',
    codeChanged: false,
    changes: [],
    artifacts: [],
    checks: [{ command: 'node', args: ['check.cjs'], exitCode: 0, signal: null, state: 'passed' }],
    ...over,
});

const VERIFY = 'agent-result-verification-v1';
const verifiedPayload = (over = {}) => ({ verification: { protocol: VERIFY, checks: [{ command: 'node', args: ['check.cjs'] }] }, ...over });
const verifiedResult = (over = {}) => ({
    protocol: VERIFY,
    state: 'succeeded',
    stage: 'completed',
    checks: [{ command: 'node', args: ['check.cjs'], exitCode: 0, signal: null, state: 'passed' }],
    ...over,
});
const notRun = { command: 'node', args: ['check.cjs'], exitCode: null, signal: null, state: 'not_run' };

const teardown = async () => {
    if (f) {
        await Promise.allSettled([f.store?.onModuleDestroy(), f.access?.onModuleDestroy(), f.catalog?.onModuleDestroy(), f.pool?.end()]);
    }
    if (container) {
        try {
            execFileSync('docker', ['rm', '-f', container], { timeout: 30000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
    }
};
process.on('exit', () => {
    if (container) {
        try {
            execFileSync('docker', ['rm', '-f', container], { timeout: 10000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
    }
});

test('1. result carries real exit-code evidence and is accepted (method workflow)', async (t) => {
    guard(t);
    const job = await f.make(shared.AGENT_METHOD_WORKFLOW_JOB, methodPayload());
    const payload = await f.row(job.id);
    const accepted = methodResult(payload.payload.workflowId);
    assert.deepEqual(await f.ack(job, accepted), { ok: true, repeated: false });
    const row = await f.row(job.id);
    assert.equal(row.state, 'succeeded');
    assert.equal(row.result.state, 'succeeded');
    assert.equal(row.result.checks[0].exitCode, 0);
    assert.deepEqual(await f.ack(job, accepted), { ok: true, repeated: true });
});

test('2. «done» without verification is rejected (fail-closed, method workflow)', async (t) => {
    guard(t);
    const job = await f.make(shared.AGENT_METHOD_WORKFLOW_JOB, methodPayload());
    const workflowId = (await f.row(job.id)).payload.workflowId;
    for (const result of [{}, methodResult(workflowId, { checks: [] })])
        await assert.rejects(f.ack(job, result), (error) => error.status === 409);
    assert.equal((await f.row(job.id)).state, 'running');
});

test('3. succeeded requires all selected checks passed (method workflow)', async (t) => {
    guard(t);
    const job = await f.make(shared.AGENT_METHOD_WORKFLOW_JOB, methodPayload());
    const workflowId = (await f.row(job.id)).payload.workflowId;
    // Проверка завершилась с ненулевым exit: «сделано» без успешной проверки не принимается.
    await assert.rejects(
        f.ack(
            job,
            methodResult(workflowId, {
                state: 'failed',
                stage: 'checks',
                checks: [{ command: 'node', args: ['check.cjs'], exitCode: 1, signal: null, state: 'failed' }],
                failure: { code: 'CHECK_FAILED', action: 'review-result' },
            }),
        ),
        (error) => error.status === 409,
    );
    // unknown (потеря подтверждения) — тоже не «сделано».
    await assert.rejects(
        f.ack(
            job,
            methodResult(workflowId, {
                state: 'unknown',
                stage: 'execution',
                checks: [notRun],
                failure: { code: 'UNKNOWN_OUTCOME', action: 'inspect-workspace' },
            }),
        ),
        (error) => error.status === 409,
    );
    assert.equal((await f.row(job.id)).state, 'running');
});

test('4. failed acknowledgement keeps explicit failed/not_run evidence (method workflow)', async (t) => {
    guard(t);
    const failedJob = await f.make(shared.AGENT_METHOD_WORKFLOW_JOB, methodPayload());
    const failedId = (await f.row(failedJob.id)).payload.workflowId;
    assert.deepEqual(
        await f.ack(
            failedJob,
            methodResult(failedId, {
                state: 'failed',
                stage: 'checks',
                checks: [{ command: 'node', args: ['check.cjs'], exitCode: 1, signal: null, state: 'failed' }],
                failure: { code: 'CHECK_FAILED', action: 'review-result' },
            }),
            'failed',
        ),
        { ok: true, repeated: false },
    );
    assert.equal((await f.row(failedJob.id)).result.checks[0].state, 'failed');
    const notRunJob = await f.make(shared.AGENT_METHOD_WORKFLOW_JOB, methodPayload());
    const notRunId = (await f.row(notRunJob.id)).payload.workflowId;
    assert.deepEqual(
        await f.ack(
            notRunJob,
            methodResult(notRunId, {
                state: 'failed',
                stage: 'prerequisites',
                checks: [notRun],
                failure: { code: 'EXECUTION_FAILED', action: 'setup-method' },
            }),
            'failed',
        ),
        { ok: true, repeated: false },
    );
    assert.equal((await f.row(notRunJob.id)).result.checks[0].state, 'not_run');
});

test('5. universal gate: verified result with declared checks is accepted', async (t) => {
    guard(t);
    const job = await f.make('run-verified-agent-work', verifiedPayload());
    assert.deepEqual(await f.ack(job, verifiedResult()), { ok: true, repeated: false });
    const row = await f.row(job.id);
    assert.equal(row.state, 'succeeded');
    assert.equal(row.result.checks[0].exitCode, 0);
});

test('6. universal gate: «done» without verification is rejected (fail-closed)', async (t) => {
    guard(t);
    const job = await f.make('run-verified-agent-work', verifiedPayload());
    for (const result of [{}, verifiedResult({ state: 'succeeded', checks: [] })])
        await assert.rejects(f.ack(job, result), (error) => error.status === 409);
    assert.equal((await f.row(job.id)).state, 'running');
});

test('7. universal gate: unknown and provenance mismatch are rejected as «done»', async (t) => {
    guard(t);
    const job = await f.make('run-verified-agent-work', verifiedPayload());
    // unknown (потеря подтверждения) явно, не succeeded.
    await assert.rejects(
        f.ack(job, verifiedResult({ state: 'unknown', stage: 'execution', checks: [notRun], failure: { code: 'UNKNOWN_OUTCOME', action: 'inspect-workspace' } })),
        (error) => error.status === 409,
    );
    // Результат описывает другие проверки, чем объявленные в задании (провенанс, NFR-4).
    await assert.rejects(
        f.ack(job, verifiedResult({ checks: [{ command: 'node', args: ['other.cjs'], exitCode: 0, signal: null, state: 'passed' }] })),
        (error) => error.status === 409,
    );
    assert.equal((await f.row(job.id)).state, 'running');
});

test('8. universal gate: failed acknowledgement keeps explicit not_run evidence', async (t) => {
    guard(t);
    const job = await f.make('run-verified-agent-work', verifiedPayload());
    assert.deepEqual(
        await f.ack(job, verifiedResult({ state: 'failed', stage: 'checks', checks: [notRun], failure: { code: 'EXECUTION_FAILED', action: 'inspect-workspace' } }), 'failed'),
        { ok: true, repeated: false },
    );
    assert.equal((await f.row(job.id)).state, 'failed');
    assert.equal((await f.row(job.id)).result.checks[0].state, 'not_run');
});

test('9. invalid verification declaration is rejected before any acknowledgement', async (t) => {
    guard(t);
    const job = await f.make('run-verified-agent-work', verifiedPayload({ verification: { protocol: VERIFY, checks: [] } }));
    await assert.rejects(f.ack(job, verifiedResult()), (error) => error.status === 409);
    assert.equal((await f.row(job.id)).state, 'running');
});

test('10. gate scope: a job without declared verification keeps the prior acceptance', async (t) => {
    guard(t);
    const job = await f.make('run-verified-agent-work', {});
    assert.deepEqual(await f.ack(job, {}), { ok: true, repeated: false });
    assert.equal((await f.row(job.id)).state, 'succeeded');
});

test('teardown', async (t) => {
    if (skip && container) {
        try {
            execFileSync('docker', ['rm', '-f', container], { timeout: 10000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
        return;
    }
    await teardown();
});
