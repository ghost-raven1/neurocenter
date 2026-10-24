import { vi } from 'vitest';
import { deviceCompletionFixture, ownedDeviceTestAdminUrl } from './device-completion-postgres.fixture';
import { completeDeviceJob } from '../src/devices/device-completion';
import { DeviceCodexService } from '../src/models/device-codex.service';
import { ModelApiAdmission } from '../src/model-api-admission/model-api-admission';
import { withModelUsage } from '../src/model-usage/model-usage.context';
import { createModelDispatchMetrics, withModelDispatchMetrics } from '../src/model-usage/model-dispatch-metrics';
import { DEVICE_CODEX_PROTOCOL } from '../../shared/device-codex-inference.cjs';
import type { DeviceCodexConnection } from '../src/models/device-codex-connections';
import type { IModel } from '../src/models/model.types';

export const adminUrl = process.env.DEVICE_CODEX_GUARD_TEST_ADMIN_URL;
export const owner = 'owner@example.test', projectId = 'prj-codex-guard', deviceId = '30000000-0000-4000-8000-000000000003';
export const lease = '40000000-0000-4000-8000-000000000004';
const bindingId = 'a'.repeat(64), instanceId = '50000000-0000-4000-8000-000000000005';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

/** Real polling, final authorization SQL and receipt transaction; only connection preflights and flag transport are isolated. */
export async function codexGuardFixture() {
    const owned = ownedDeviceTestAdminUrl(adminUrl ?? '');
    const fixture = await deviceCompletionFixture(owned.href), { pool } = fixture;
    try {
        await pool.query(`ALTER TABLE bridge_devices ADD email text,ADD role text,ADD revoked boolean DEFAULT false,
            ADD expires_at timestamptz,ADD report jsonb`);
        await pool.query(`ALTER TABLE bridge_jobs ALTER state SET DEFAULT 'queued',ALTER lease SET DEFAULT '${lease}',
            ALTER lease_until SET DEFAULT (now()+interval '5 minutes'),ADD request_key text,ADD request_hash text`);
        await pool.query(`CREATE TABLE device_model_calls(id text PRIMARY KEY,job_id text UNIQUE,model_id text,device_id text,
            owner_email text,actor_role text,project_id text,model_pin text,runtime_model text,connection_revision integer,
            request jsonb,required_features jsonb,deadline_at timestamptz,dispatched_at timestamptz,cancelled_at timestamptz,
            result jsonb,response_digest text,completed_at timestamptz)`);
        await pool.query(`CREATE TABLE model_device_connections(model_id text PRIMARY KEY,revision integer,revoked_at timestamptz,
            semantic_sha text,source jsonb)`);
        await pool.query('CREATE TABLE model_catalog(id text PRIMARY KEY,descriptor jsonb,archived_at timestamptz)');
        await pool.query('CREATE TABLE platform_users(email text PRIMARY KEY,enabled boolean,is_main_admin boolean)');
        await pool.query('CREATE TABLE project_members(project_id text,principal_name text,role text)');
    } catch (error) { await fixture.dispose(); throw error; }

    const model: IModel = { id: 'model-codex-guard', name: 'Codex fixture', description: '', runtime: 'device-codex', capability: 'chat',
        model: 'codex-fixture', modelVersion: 'codex-fixture', manifestSha256: null, verificationSha256: 'b'.repeat(64),
        dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
    const source = { scope: 'project' as const, projectId, bindingId, instanceId };
    const connection = { model_id: model.id, device_id: deviceId, owner_email: owner, revision: 1, source,
        options: { store: false }, semantic_sha: model.verificationSha256,
        expected_candidate: { provider: 'codexbridge', model: model.model, modelVersion: model.modelVersion, capability: model.capability, baseUrl: null },
        connector_package: {} };
    const response = { model: model.model, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'Already generated answer' },
        prompt_eval_count: 4, eval_count: 8, usage_reported: true };
    const query = vi.spyOn(pool, 'query');
    let releaseGuard: (() => void) | undefined;
    let active: Promise<unknown> | undefined;
    let controller: AbortController | undefined;
    const stop = async () => { releaseGuard?.(); controller?.abort(); await active?.catch(() => undefined); active = undefined; };

    async function setup() {
        await stop(); controller = new AbortController();
        await pool.query('TRUNCATE bridge_jobs,device_model_calls,model_device_connections,model_catalog,bridge_devices,platform_users,project_members,operations');
        await pool.query('INSERT INTO platform_users VALUES($1,true,false)', [owner]);
        await pool.query("INSERT INTO project_members VALUES($1,$2,'Разработчик')", [projectId, owner]);
        await pool.query(`INSERT INTO bridge_devices(id,email,role,expires_at,report) VALUES($1,$2,'Разработчик',now()+interval '1 hour',$3::jsonb)`,
            [deviceId, owner, JSON.stringify({ bindings: [{ projectId, bindingId, instanceId, valid: true }] })]);
        await pool.query('INSERT INTO model_catalog VALUES($1,$2::jsonb,NULL)', [model.id, JSON.stringify({ verificationSha256: model.verificationSha256 })]);
        await pool.query('INSERT INTO model_device_connections VALUES($1,1,NULL,$2,$3::jsonb)', [model.id, model.verificationSha256, JSON.stringify(source)]);
        query.mockClear();
        const waiting = deferred(), resume = deferred(), metrics = createModelDispatchMetrics();
        releaseGuard = resume.resolve;
        let nextGuard: { waiting: ReturnType<typeof deferred>; resume: ReturnType<typeof deferred> } | undefined;
        const admission = new ModelApiAdmission({ acquire: vi.fn(async (_model, _signal, beforeAttempt) => beforeAttempt()) } as never);
        const service = new DeviceCodexService({ pool, get: vi.fn(async () => model) } as never, {} as never, {} as never, admission);
        const connections = (service as unknown as { connections: { read: () => Promise<unknown>; assertCurrent: () => Promise<unknown> } }).connections;
        vi.spyOn(connections, 'read').mockResolvedValue(connection as DeviceCodexConnection);
        let checks = 0;
        vi.spyOn(connections, 'assertCurrent').mockImplementation(async () => {
            // The third preflight belongs to poll(), after its pending Call snapshot has been read.
            if (++checks === 3) { waiting.resolve(); await resume.promise; }
            else if (nextGuard) { const guard = nextGuard; nextGuard = undefined; guard.waiting.resolve(); await guard.resume.promise; }
            return {};
        });
        const pauseNextGuard = () => {
            const guard = { waiting: deferred(), resume: deferred() }; nextGuard = guard;
            releaseGuard = () => { resume.resolve(); guard.resume.resolve(); };
            return { waiting: guard.waiting.promise, resume: guard.resume.resolve };
        };
        const run = () => {
            active = withModelDispatchMetrics(metrics, () => withModelUsage({ purpose: 'direct', actorEmail: owner,
                actorRole: 'Разработчик', projectId }, () => service.infer(model, 'chat', { messages: [{ role: 'user', content: 'Fixture prompt' }] }, controller!.signal)));
            // The test deliberately holds the consumer while another transaction settles its receipt.
            void active.catch(() => undefined);
            return active;
        };
        const ids = async () => (await pool.query<{ id: string; job_id: string }>('SELECT id,job_id FROM device_model_calls')).rows[0];
        const complete = async (outcome: 'success' | 'unknown-after-send' = 'success') => {
            const call = await ids();
            await pool.query("UPDATE bridge_jobs SET state='running',started_at=clock_timestamp() WHERE id=$1", [call.job_id]);
            await pool.query('UPDATE device_model_calls SET dispatched_at=clock_timestamp() WHERE id=$1', [call.id]);
            const result = { protocol: DEVICE_CODEX_PROTOCOL, callId: call.id,
                ...(outcome === 'success' ? { response } : { error: { code: outcome } }) };
            return completeDeviceJob(pool, deviceId, call.job_id, { lease, state: outcome === 'success' ? 'succeeded' : 'failed', message: 'Fixture receipt', result });
        };
        return { run, waiting: waiting.promise, resume: resume.resolve, pauseNextGuard, service, metrics, response, ids, complete };
    }
    return { ...fixture, model, query, setup, stop, async dispose() {
        await stop(); return fixture.dispose();
    } };
}
