import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeMcpConfigurationSave } from '../src/devices/mcp-config-permit';
import { DeviceStore } from '../src/devices/device-store';
import { migrateCatalog } from '../src/database/migrations';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { checkCatalogSchema, ensureCatalogSchema } from '../src/database/catalog-schema';
import { CATALOG_SCHEMA_FACTS_SQL } from '../src/database/schema-catalog';
import { SYSTEM_ROLE_MCP_SCHEMA_CONTRACT } from '../src/system-role-mcp/system-role-mcp.schema-contract';
import { assertSystemRoleMcpSchema } from '../src/system-role-mcp/system-role-mcp.schema-verification';
import { systemRoleMcpDigest } from '../../shared/system-role-mcp.cjs';
import { assertBlockedBy, createMcpFixture, deferred, deviceId, gatewayUrl, listResult, modelId, other, outputResult, ownedDatabase, owner, project, releasedMigrations, request, token, tool,
    type McpFixture } from './system-role-mcp-postgres.fixture';

const features = vi.hoisted(() => ({ enabled: true, probe: undefined as undefined | ((keys: readonly string[]) => Promise<void>) }));
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: async (keys: readonly string[]) => { await features.probe?.(keys); if (!features.enabled) throw new ForbiddenException('Feature disabled'); } }));
const connection = process.env.SYSTEM_ROLE_MCP_TEST_ADMIN_URL;

/** Actual migrations/locks/receipts; no SDK, subprocess, model invocation or real gateway request. */
describe.skipIf(!connection).sequential('System-role MCP on caller-owned PostgreSQL', () => {
    let fixture: McpFixture;
    beforeAll(async () => { fixture = await createMcpFixture(connection); }, 60_000);
    beforeEach(async () => {
        features.enabled = true; features.probe = undefined;
        vi.stubEnv('CATALOG_PG_URL', 'postgresql://forbidden:forbidden@127.0.0.1:1/forbidden');
        vi.stubEnv('API_GATEWAY_URL', gatewayUrl); vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'native-fixture-internal');
        vi.stubGlobal('fetch', fixture.fetchBoundary); await fixture.reset();
    });
    afterEach(async () => {
        if (fixture) { await fixture.stop(); expect(fixture.transportViolations).toEqual([]); }
        vi.unstubAllGlobals(); vi.unstubAllEnvs();
    });
    afterAll(async () => { await fixture?.close(); });
    const discovery = (target = fixture.target(), requestId = randomUUID()) => fixture.service.discover(request(), { projectId: project, target, requestId });
    const count = async (table: 'system_role_mcp_sessions' | 'system_role_mcp_calls' | 'system_role_mcp_discoveries') => Number((await fixture.pool.query('SELECT count(*) FROM ' + table)).rows[0].count);

    it('keeps a durable gateway callback after HTTP ACK loss and process-memory loss without replay', async () => {
        const arrival = fixture.nextExecution(), id = randomUUID(), pending = await discovery(fixture.target(), id), execution = await arrival;
        expect(pending.state).toBe('pending');
        const context = await fixture.service.context(execution.callId), proof = context.call.proof;
        await fixture.service.serverDispatch({ callId: execution.callId, proof });
        await fixture.service.serverResult({ callId: execution.callId, proof, result: listResult });
        execution.reply.reject(new Error('Simulated lost outer HTTP ACK after durable callback'));
        await fixture.stop();
        const reopened = fixture.newService();
        try {
            features.enabled = false;
            expect((await reopened.discovery(request(), id)).tools).toEqual([tool]);
            expect((await reopened.discover(request(), { projectId: project, target: fixture.target(), requestId: id })).state).toBe('ready');
            expect(fixture.executions).toHaveLength(1);
            const stored = await reopened.repository.call(execution.callId);
            expect(stored.state).toBe('succeeded'); expect(stored.result).toEqual(listResult); expect(stored.late_result).toBeNull();
        } finally { await reopened.onApplicationShutdown(); }
    });

    it('rejects foreign proof, pre-dispatch success and a second send while allowing only identical result ACKs', async () => {
        const a = fixture.nextExecution(); await discovery(); const first = await a;
        const b = fixture.nextExecution(); await discovery(); const second = await b;
        const one = await fixture.service.context(first.callId), two = await fixture.service.context(second.callId);
        await expect(fixture.service.serverDispatch({ callId: first.callId, proof: two.call.proof })).rejects.toHaveProperty('status', 404);
        await expect(fixture.service.serverResult({ callId: first.callId, proof: one.call.proof, result: listResult })).rejects.toHaveProperty('status', 409);
        expect((await fixture.service.repository.call(first.callId)).state).toBe('queued');
        await fixture.service.serverDispatch({ callId: first.callId, proof: one.call.proof });
        await expect(fixture.service.serverDispatch({ callId: first.callId, proof: one.call.proof })).rejects.toHaveProperty('status', 409);
        await expect(fixture.service.serverResult({ callId: first.callId, proof: two.call.proof, result: listResult })).rejects.toHaveProperty('status', 404);
        const receipt = { callId: first.callId, proof: one.call.proof, result: listResult };
        await fixture.service.serverResult(receipt); await fixture.service.serverResult(receipt);
        await expect(fixture.service.serverResult({ ...receipt, result: { state: 'succeeded', value: { tools: [] } } })).rejects.toHaveProperty('status', 409);
        expect((await fixture.service.repository.call(second.callId)).state).toBe('queued');
        expect(await count('system_role_mcp_calls')).toBe(2);
    });

    it('serializes identical discovery keys and reserves owner capacity across different concurrent keys', async () => {
        const id = randomUUID(), input = { projectId: project, target: fixture.target(), requestId: id };
        const [a, b] = await Promise.all([fixture.service.discover(request(), input), fixture.service.discover(request(), input)]);
        expect(a.id).toBe(b.id); expect(fixture.executions).toHaveLength(1);
        expect(await count('system_role_mcp_discoveries')).toBe(1);
        await expect(fixture.service.discover(request(), { ...input, target: fixture.target('device') })).rejects.toHaveProperty('status', 409);
        await expect(fixture.service.discovery(request(other), id)).rejects.toHaveProperty('status', 404);
        const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => discovery()));
        expect(attempts.filter(value => value.status === 'fulfilled')).toHaveLength(1);
        for (const attempt of attempts) if (attempt.status === 'rejected') expect(attempt.reason).toHaveProperty('status', 409);
        expect(await count('system_role_mcp_discoveries')).toBe(2); expect(fixture.executions).toHaveLength(2);
        expect(await count('system_role_mcp_sessions')).toBe(2); expect(await count('system_role_mcp_calls')).toBe(2);
    });

    it('preserves ready discovery OFF and requires its exact own tool schema and unexpired TTL for new admission', async () => {
        const arrival = fixture.nextExecution(), view = await discovery(), execution = await arrival, context = await fixture.service.context(execution.callId);
        await fixture.service.serverDispatch({ callId: execution.callId, proof: context.call.proof });
        await fixture.service.serverResult({ callId: execution.callId, proof: context.call.proof, result: listResult });
        const selected = { ...view.target, discoveryId: view.id, tools: [{ name: tool.name, schemaDigest: tool.schemaDigest }] };
        expect((await fixture.service.prepare(request(), project, [selected]))[0].tools[0].inputSchema).toEqual(tool.inputSchema);
        await expect(fixture.service.prepare(request(), project, [{ ...selected, tools: [{ name: tool.name, schemaDigest: '0'.repeat(64) }] }])).rejects.toHaveProperty('status', 409);
        await expect(fixture.service.prepare(request(other), project, [selected])).rejects.toHaveProperty('status', 409);
        features.enabled = false;
        expect((await fixture.service.discovery(request(), view.id)).state).toBe('ready');
        await expect(fixture.service.assertAdmission(request(), project, [selected])).rejects.toHaveProperty('status', 403);
        features.enabled = true;
        // Discovery receipts are immutable; a past expiry is inserted as a distinct historical receipt.
        const expiredId = randomUUID();
        const saved = await fixture.service.repository.discovery(view.id, owner);
        await fixture.pool.query('DELETE FROM system_role_mcp_discoveries WHERE id=$1', [view.id]);
        await fixture.pool.query(`INSERT INTO system_role_mcp_discoveries(id,owner_email,actor_role,project_id,request_hash,target,session_id,call_id,created_at,expires_at)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now()-interval '10 minutes',now()-interval '5 minutes')`, [expiredId, owner, saved!.actor_role, project, saved!.request_hash, JSON.stringify(saved!.target), saved!.session_id, saved!.call_id]);
        expect((await fixture.service.discovery(request(), expiredId)).state).toBe('ready');
        await expect(fixture.service.assertAdmission(request(), project, [{ ...selected, discoveryId: expiredId }])).rejects.toHaveProperty('status', 409);
    });

    it('keeps cancelled/OFF late output private and never resurrects the run or dispatch', async () => {
        const { row, journal } = await fixture.run(), saved = await fixture.enqueue(row), context = await fixture.service.context(saved.call.id);
        await fixture.service.serverDispatch({ callId: saved.call.id, proof: context.call.proof });
        await journal.fenced(row.id, row.lease_token, (db, current) => journal.change(db, current, 'cancelled', 'cancelled', 'Explicit native cancellation'));
        const cancelled = await journal.get(row.id); await fixture.service.close(row.id, row.lease_token); features.enabled = false;
        const ack = { callId: saved.call.id, proof: context.call.proof, result: outputResult() };
        await fixture.service.serverResult(ack); await fixture.service.serverResult(ack);
        const call = await fixture.service.repository.call(saved.call.id);
        expect(call.state).toBe('unknown'); expect(call.result).toBeNull(); expect(call.late_result).toEqual(outputResult());
        expect(await journal.get(row.id)).toEqual(cancelled);
        const privateReceipts = await fixture.service.calls(request(), row.id);
        expect(privateReceipts[0]).toMatchObject({ state: 'unknown', output: outputResult().value });
        await expect(fixture.service.calls(request(other), row.id)).rejects.toHaveProperty('status', 404);
        await expect(fixture.service.serverDispatch({ callId: saved.call.id, proof: context.call.proof })).rejects.toHaveProperty('status', 403);
        features.enabled = true;
        await expect(fixture.service.serverDispatch({ callId: saved.call.id, proof: context.call.proof })).rejects.toHaveProperty('status', 409);
        expect(fixture.executions).toHaveLength(0);
    });

    it('rejects a stale role generation and a changed model pin before dispatch without an orphan send', async () => {
        const { row } = await fixture.run();
        await expect(fixture.enqueue({ ...row, lease_token: randomUUID() })).rejects.toHaveProperty('status', 409);
        expect(await count('system_role_mcp_calls')).toBe(0);
        const saved = await fixture.enqueue(row), context = await fixture.service.context(saved.call.id);
        await fixture.pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{model}','\"native:changed\"'),revision=revision+1 WHERE id=$1", [modelId]);
        await expect(fixture.service.serverDispatch({ callId: saved.call.id, proof: context.call.proof })).rejects.toHaveProperty('status', 409);
        expect((await fixture.service.repository.call(saved.call.id)).state).toBe('queued');
        expect((await fixture.service.repository.call(saved.call.id)).dispatched_at).toBeNull();
    });

    it('claims two private device sessions beside an unchanged running Codex/general job and frees discovery slots on result', async () => {
        const codexId = await fixture.job('infer-device-codex', { privateCallId: randomUUID() }, 'running');
        const before = (await fixture.pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows;
        await Promise.all([discovery(fixture.target('device')), discovery(fixture.target('device'))]);
        const claims = await Promise.all([fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false}), fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false}), fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false})]);
        const accepted = claims.filter(value => value !== null); expect(accepted).toHaveLength(2); expect(new Set(accepted.map(value => value.id)).size).toBe(2);
        expect(claims.filter(value => value === null)).toHaveLength(1);
        expect((await fixture.pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows).toEqual(before);
        expect((await fixture.pool.query('SELECT state FROM bridge_jobs WHERE id=$1', [codexId])).rows[0].state).toBe('running');
        const claimed = accepted[0], body = { jobId: claimed.id, lease: claimed.lease };
        const next = await fixture.service.channel.next(token, body); expect(next).toHaveProperty('kind', 'list');
        const callId = (next as { id: string }).id;
        await expect(fixture.service.channel.dispatch(token, { ...body, lease: randomUUID(), callId })).rejects.toHaveProperty('status', 409);
        await fixture.service.channel.dispatch(token, { ...body, callId });
        await fixture.service.channel.result(token, { ...body, callId, result: listResult });
        expect((await fixture.service.repository.session(claimed.id)).state).toBe('closed');
        expect(await fixture.service.channel.next(token, body)).toEqual({ closed: true });
        await discovery(fixture.target('device'));
        expect(await fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false})).toMatchObject({ kind: 'system-role-mcp-session' });
        expect((await fixture.pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows).toEqual(before);
    });

    it('accepts only the same private device late receipt after revocation and cancellation, with no fresh authority', async () => {
        const target = fixture.target('device'), { row, journal } = await fixture.run(target), saved = await fixture.enqueue(row, target);
        const claimed = (await fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false}))!, body = { jobId: claimed.id, lease: claimed.lease, callId: saved.call.id };
        await fixture.service.channel.dispatch(token, body);
        await journal.fenced(row.id, row.lease_token, (db, current) => journal.change(db, current, 'cancelled', 'cancelled', 'Cancel private tool'));
        await fixture.service.close(row.id, row.lease_token); features.enabled = false;
        await fixture.pool.query("UPDATE bridge_devices SET revoked=true,expires_at=now()-interval '1 day' WHERE id=$1", [deviceId]);
        await expect(fixture.service.channel.next(token, { jobId: claimed.id, lease: claimed.lease })).rejects.toHaveProperty('status', 401);
        await expect(fixture.service.channel.result(token, { ...body, lease: randomUUID(), result: outputResult() })).rejects.toHaveProperty('status', 401);
        await fixture.service.channel.result(token, { ...body, result: outputResult() });
        await fixture.service.channel.result(token, { ...body, result: outputResult() });
        expect((await fixture.service.repository.call(saved.call.id)).state).toBe('unknown');
        expect((await fixture.service.repository.call(saved.call.id)).late_result).toEqual(outputResult());
        expect((await journal.get(row.id))?.state).toBe('cancelled');
    });

    /** Pause only after the production query has acquired the physical row lock. */
    async function blockedWrite<T>(match: (sql: string) => boolean, action: () => Promise<T>, write: (client: PoolClient) => Promise<unknown>) {
        const entered = deferred<number>(), release = deferred(); let matched = false, writer: PoolClient | undefined, update: Promise<unknown> | undefined;
        // Cleanup watchdog only; evidence below is pg_blocking_pids, never elapsed time.
        const watchdog = setTimeout(() => { release.resolve(); entered.reject(new Error('Native lock barrier did not arrive')); }, 4000); watchdog.unref();
        fixture.setHook(async event => {
            if (matched || !match(event.sql)) return; matched = true;
            entered.resolve((await event.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); await release.promise;
        });
        const operation = action(); void operation.catch(() => undefined);
        try {
            const blocker = await Promise.race([entered.promise, operation.then(() => { throw new Error('Production operation omitted expected lock barrier'); })]);
            writer = await fixture.pool.connect(); const waiting = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            update = write(writer); void update.catch(() => undefined);
            await assertBlockedBy(fixture.pool, waiting, blocker); release.resolve();
            const value = await operation; await update; return value;
        } finally { clearTimeout(watchdog); release.resolve(); fixture.setHook(); await Promise.allSettled([operation, ...(update ? [update] : [])]); writer?.release(); }
    }

    it('commits a no-dispatch cancellation before a competing real Codex marker and denies the later send', async () => {
        const codex = await fixture.codexCas();
        try {
            const cancelled = await blockedWrite(sql => sql.startsWith('SELECT id,kind,state,project_id,email,message FROM bridge_jobs'), () => codex.service.cancel(codex.jobId, true),
                db => expect(codex.onClient(db).dispatch(codex.device, codex.body)).rejects.toHaveProperty('status', 409));
            expect(cancelled).toMatchObject({ state: 'cancelled', undispatched: true });
            expect((await fixture.pool.query('SELECT state FROM bridge_jobs WHERE id=$1', [codex.jobId])).rows[0].state).toBe('cancelled');
            const call = (await fixture.pool.query('SELECT dispatched_at,cancelled_at,result FROM device_model_calls WHERE id=$1', [codex.callId])).rows[0];
            expect(call.dispatched_at).toBeNull(); expect(call.cancelled_at).not.toBeNull(); expect(call.result).toBeNull();
            expect(fixture.executions).toHaveLength(0);
        } finally { codex.restore(); }
    });

    it('retains the winning Codex dispatch after its ACK is lost and accepts exactly the same completed receipt', async () => {
        const codex = await fixture.codexCas();
        try {
            let cancellation: unknown;
            await blockedWrite(sql => sql === 'SELECT id FROM bridge_jobs WHERE id=$1 FOR UPDATE', () => codex.service.dispatch(codex.device, codex.body),
                async db => { cancellation = await codex.onClient(db).cancel(codex.jobId, true); });
            expect(cancellation).toMatchObject({ cancelled: false, undispatched: false });
            const call = (await fixture.pool.query('SELECT dispatched_at,cancelled_at,result FROM device_model_calls WHERE id=$1', [codex.callId])).rows[0];
            expect(call.dispatched_at).not.toBeNull(); expect(call.cancelled_at).toBeNull(); expect(call.result).toBeNull();
            // Read the committed marker after deliberately ignoring its response; no model/runtime is invoked.
            await expect(codex.service.dispatch(codex.device, codex.body)).rejects.toHaveProperty('status', 409);
            expect(await codex.deliver()).toEqual({ ok: true, repeated: false });
            features.enabled = false;
            expect(await codex.deliver()).toEqual({ ok: true, repeated: true });
            const before = (await fixture.pool.query('SELECT * FROM device_model_calls WHERE id=$1', [codex.callId])).rows[0];
            expect(await codex.service.cancel(codex.jobId, true)).toMatchObject({ cancelled: false, undispatched: false });
            expect((await fixture.pool.query('SELECT * FROM device_model_calls WHERE id=$1', [codex.callId])).rows[0]).toEqual(before);
            expect(before.result.response.message.content).toBe('Private completed native SQL evidence');
            expect((await fixture.pool.query('SELECT state,result FROM bridge_jobs WHERE id=$1', [codex.jobId])).rows[0]).toMatchObject({ state: 'succeeded', result: { callId: codex.callId } });
            expect((await fixture.pool.query('SELECT state FROM operations WHERE operation_id=$1', ['bridge-' + codex.jobId])).rows[0].state).toBe('SUCCEEDED');
            expect((await fixture.pool.query('SELECT count(*) FROM device_model_calls')).rows[0].count).toBe('1');
        } finally { codex.restore(); }
    });

    it('fences concurrent device revocation through discovery admission and blocks the later worker claim', async () => {
        await blockedWrite(sql => sql.includes('FROM bridge_devices') && sql.includes('FOR SHARE'), () => discovery(fixture.target('device')),
            db => db.query('UPDATE bridge_devices SET revoked=true WHERE id=$1', [deviceId]));
        expect(await count('system_role_mcp_discoveries')).toBe(1);
        await expect(fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false})).rejects.toHaveProperty('status', 401);
        expect((await fixture.pool.query('SELECT state,dispatched_at FROM system_role_mcp_calls')).rows).toEqual([{ state: 'queued', dispatched_at: null }]);
    });

    it('holds the device lock until atomic dispatch commits, then rejects further work after revocation', async () => {
        const target = fixture.target('device'), { row } = await fixture.run(target), saved = await fixture.enqueue(row, target), claimed = (await fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false}))!;
        const fence = { sessionId: claimed.id, lease: claimed.lease, deviceId };
        await blockedWrite(sql => sql === 'SELECT id FROM bridge_devices WHERE id=$1 FOR SHARE', () => fixture.service.dispatch(saved.call.id, fence),
            db => db.query('UPDATE bridge_devices SET revoked=true WHERE id=$1', [deviceId]));
        expect((await fixture.service.repository.call(saved.call.id)).state).toBe('dispatched');
        await expect(fixture.service.channel.authorize(token, { jobId: claimed.id, lease: claimed.lease })).rejects.toHaveProperty('status', 401);
    });

    it('holds the existing configuration form through dispatch and fences its actual subsequent save permit', async () => {
        const formId = await fixture.configurationForm(), target = fixture.target('device', fixture.configured), { row } = await fixture.run(target), saved = await fixture.enqueue(row, target);
        const claimed = (await fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false}))!, fence = { sessionId: claimed.id, lease: claimed.lease, deviceId }, device = await fixture.devices.identity(token);
        await blockedWrite(sql => sql.includes("kind='open-mcp-configuration'") && sql.includes('FOR SHARE'), () => fixture.service.dispatch(saved.call.id, fence), async db => {
            const boundStore = Object.assign(Object.create(DeviceStore.prototype), { pool: db, access: fixture.devices.access }) as DeviceStore;
            return authorizeMcpConfigurationSave(boundStore, fixture.installations, fixture.plans, device, { jobId: formId }, () => fixture.service.policy.roles.actor(request(), project));
        });
        expect((await fixture.pool.query('SELECT payload ? \'configurationInvalidatedAt\' AS invalidated FROM bridge_jobs WHERE id=$1', [formId])).rows[0].invalidated).toBe(true);
        expect((await fixture.service.repository.call(saved.call.id)).state).toBe('dispatched');
        const later = await fixture.enqueue(row, target);
        await expect(fixture.service.dispatch(later.call.id, fence)).rejects.toHaveProperty('status', 409);
        expect((await fixture.service.repository.call(later.call.id)).dispatched_at).toBeNull();
    });

    it('holds exact installed-plan approval through dispatch and rejects the next call after approval revocation', async () => {
        const target = fixture.target('device'), { row } = await fixture.run(target), saved = await fixture.enqueue(row, target), claimed = (await fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false}))!;
        const fence = { sessionId: claimed.id, lease: claimed.lease, deviceId };
        await blockedWrite(sql => sql.includes('FROM device_install_plans') && sql.includes('FOR SHARE'), () => fixture.service.dispatch(saved.call.id, fence),
            db => db.query("UPDATE device_install_plans SET status='revoked' WHERE project_id=$1 AND asset_id=$2", [project, target.assetId]));
        expect((await fixture.service.repository.call(saved.call.id)).state).toBe('dispatched');
        const later = await fixture.enqueue(row, target);
        await expect(fixture.service.dispatch(later.call.id, fence)).rejects.toHaveProperty('status', 409);
        expect((await fixture.service.repository.call(later.call.id)).state).toBe('queued');
    });

    /** A delayed external availability response must not own device, role or session row locks. */
    async function outsideFlagLocks<T>(action: () => Promise<T>, mutate: () => Promise<unknown>, key = 'system_role_mcp') {
        const entered = deferred(), release = deferred(); let gated = false, released = false, settled = false;
        const watchdog = setTimeout(() => { released = true; release.resolve(); entered.reject(new Error('Feature preflight barrier did not arrive')); }, 4000); watchdog.unref();
        features.probe = async keys => { if (!gated && keys.includes(key)) { gated = true; entered.resolve(); await release.promise; } };
        const operation = action(); void operation.then(() => { settled = true; }, () => { settled = true; });
        try {
            await Promise.race([entered.promise, operation.then(() => { throw new Error('Operation skipped the external availability barrier'); })]);
            await mutate();
            // The real database write completed while the feature response remains deliberately unresolved.
            expect(released).toBe(false); expect(settled).toBe(false); released = true; release.resolve();
            await expect(operation).rejects.toBeDefined();
        } finally { clearTimeout(watchdog); released = true; release.resolve(); features.probe = undefined; await Promise.allSettled([operation]); }
    }

    it('allows real Codex cancellation while the global required-feature response is still pending', async () => {
        const codex = await fixture.codexCas();
        try {
            await outsideFlagLocks(() => codex.service.dispatch(codex.device, codex.body), async () => {
                expect(await codex.service.cancel(codex.jobId, true)).toMatchObject({ state: 'cancelled', undispatched: true });
            }, 'device_codex_inference');
            const call = (await fixture.pool.query('SELECT dispatched_at,cancelled_at FROM device_model_calls WHERE id=$1', [codex.callId])).rows[0];
            expect(call.dispatched_at).toBeNull(); expect(call.cancelled_at).not.toBeNull();
            expect(fixture.executions).toHaveLength(0);
        } finally { codex.restore(); }
    });

    it.each(['device revocation', 'role cancellation'])('does not hold SQL locks during dispatch feature I/O: %s', async change => {
        const target = fixture.target('device'), { row, journal } = await fixture.run(target), saved = await fixture.enqueue(row, target), claimed = (await fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false}))!;
        const fence = { sessionId: claimed.id, lease: claimed.lease, deviceId };
        await outsideFlagLocks(() => fixture.service.dispatch(saved.call.id, fence), () => change === 'device revocation'
            ? fixture.pool.query('UPDATE bridge_devices SET revoked=true WHERE id=$1', [deviceId])
            : journal.fenced(row.id, row.lease_token, (db, current) => journal.change(db, current, 'cancelled', 'cancelled', 'Cancel while external flag response is pending')));
        expect((await fixture.service.repository.call(saved.call.id)).state).toBe('queued');
        expect((await fixture.service.repository.call(saved.call.id)).dispatched_at).toBeNull(); expect(fixture.executions).toHaveLength(0);
    });

    it('does not hold the private device claim lock while external flags are pending', async () => {
        await discovery(fixture.target('device'));
        await outsideFlagLocks(() => fixture.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false}), () => fixture.pool.query('UPDATE bridge_devices SET revoked=true WHERE id=$1', [deviceId]));
        expect((await fixture.pool.query('SELECT claimed_at FROM system_role_mcp_sessions')).rows).toEqual([{ claimed_at: null }]);
        expect((await fixture.pool.query('SELECT state,dispatched_at FROM system_role_mcp_calls')).rows).toEqual([{ state: 'queued', dispatched_at: null }]);
    });

    it('enforces immutable source/proof/outcome guards and the captured schema36 contract', async () => {
        expect(SYSTEM_ROLE_MCP_SCHEMA_CONTRACT.length).toBeGreaterThan(100); await assertSystemRoleMcpSchema(fixture.pool);
        const view = await discovery(fixture.target('device')), discoveryRow = (await fixture.service.repository.discovery(view.id, owner))!, session = await fixture.service.repository.session(discoveryRow.session_id);
        await expect(fixture.pool.query('UPDATE system_role_mcp_sessions SET worker_lease=$2 WHERE id=$1', [session.id, randomUUID()])).rejects.toThrow('immutable');
        await expect(fixture.pool.query('UPDATE system_role_mcp_calls SET dispatch_proof=$2 WHERE id=$1', [discoveryRow.call_id, '0'.repeat(64)])).rejects.toThrow('immutable');
        await expect(fixture.pool.query('UPDATE system_role_mcp_discoveries SET request_hash=$2 WHERE id=$1', [view.id, systemRoleMcpDigest('changed')])).rejects.toThrow('immutable');
        await fixture.service.repository.close(session.id);
        await expect(fixture.pool.query("UPDATE system_role_mcp_sessions SET state='open' WHERE id=$1", [session.id])).rejects.toThrow('immutable');
        const db = await fixture.pool.connect(); await db.query('BEGIN');
        try {
            await db.query('ALTER TABLE system_role_mcp_calls DISABLE TRIGGER system_role_mcp_call_guard');
            await expect(assertSystemRoleMcpSchema(db as never)).rejects.toThrow('не готова');
        } finally { await db.query('ROLLBACK'); db.release(); }
        await assertSystemRoleMcpSchema(fixture.pool);
    });

    it('rolls back a failed36, retries once, preserves <=35 receipts and rejects historical/physical drift', async () => {
        const upgrade = await ownedDatabase(connection, 'nc_mcp_upgrade_');
        try {
            await migrateCatalog(upgrade.pool, releasedMigrations());
            const before = (await upgrade.pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows;
            const budget = (await upgrade.pool.query("SELECT pg_get_constraintdef(oid) AS value FROM pg_constraint WHERE conname='system_role_runs_calls_started_check'")).rows;
            const migration = CATALOG_MIGRATIONS.find(item => item.version === 36)!, history = CATALOG_MIGRATIONS;
            expect((await checkCatalogSchema(upgrade.pool)).pending).toEqual([36,37]);
            await expect(migrateCatalog(upgrade.pool, [...releasedMigrations(), { ...migration, sql: migration.sql + '; SELECT deliberately_missing_mcp36_function()' }])).rejects.toThrow();
            expect((await upgrade.pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows).toEqual(before);
            expect((await upgrade.pool.query("SELECT to_regclass('system_role_mcp_sessions') AS sessions")).rows[0].sessions).toBeNull();
            expect((await upgrade.pool.query("SELECT pg_get_constraintdef(oid) AS value FROM pg_constraint WHERE conname='system_role_runs_calls_started_check'")).rows).toEqual(budget);
            await ensureCatalogSchema(upgrade.pool); await assertSystemRoleMcpSchema(upgrade.pool);
            expect(await checkCatalogSchema(upgrade.pool, true)).toMatchObject({ ready: true, pending: [], applied: history.map(item => item.version) });
            const applied = (await upgrade.pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows;
            expect(applied.filter(row => row.version <= 35)).toEqual(before);
            await migrateCatalog(upgrade.pool, history);
            expect((await upgrade.pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows).toEqual(applied);
            await expect(migrateCatalog(upgrade.pool, history.map(item => item.version === 35 ? { ...item, sql: item.sql + '\n-- changed history' } : item))).rejects.toThrow('История');
            await upgrade.pool.query('DROP INDEX system_role_mcp_next_call');
            await expect(assertSystemRoleMcpSchema(upgrade.pool)).rejects.toThrow('system_role_mcp_next_call');
            await expect(checkCatalogSchema(upgrade.pool, true)).rejects.toThrow('system_role_mcp_next_call');
            const index = SYSTEM_ROLE_MCP_SCHEMA_CONTRACT.find(item => item.kind === 'index' && item.id === 'system_role_mcp_next_call')!;
            await upgrade.pool.query(String(index.definition.definition));
            await upgrade.pool.query('DROP TABLE system_role_mcp_discoveries');
            await expect(checkCatalogSchema(upgrade.pool, true)).rejects.toThrow('system_role_mcp_discoveries');
            expect((await upgrade.pool.query(CATALOG_SCHEMA_FACTS_SQL)).rowCount).toBeGreaterThan(100);
        } finally { await upgrade.close(); }
    }, 60_000);
});
