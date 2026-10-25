import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Request } from 'express';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { vi } from 'vitest';
import { DEVICE_CODEX_PROTOCOL, normalizeDeviceCodexPayload } from '../../shared/device-codex-inference.cjs';
import { normalizeRoleMcpTool, roleMcpToolKey, SYSTEM_ROLE_MCP_CAPABILITY, type RoleMcpTarget } from '../../shared/system-role-mcp.cjs';
import { buildPackage } from '../src/catalog/bundle-package';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { DeviceStore, digest } from '../src/devices/device-store';
import { DeviceInstallations } from '../src/devices/device-installations';
import { InstallPlans } from '../src/devices/install-plans';
import { configurationSchemaDigest } from '../src/devices/mcp-config-reports';
import { modelFromRow } from '../src/models/model-history';
import type { ModelsService } from '../src/models/models.service';
import { DeviceCodexService } from '../src/models/device-codex.service';
import { DeviceCodexConnections } from '../src/models/device-codex-connections';
import { completeDeviceCodex } from '../src/models/device-codex-completion';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { SystemRoleMcpService } from '../src/system-role-mcp/system-role-mcp.service';
import { roleDefinitionPin, roleHash } from '../src/system-roles/system-role.definitions';
import { SystemRoleRepository } from '../src/system-roles/system-role.repository';
import type { RoleRunRow, StartRoleRun } from '../src/system-roles/system-role.types';

export const owner = 'owner@mcp-native.test', other = 'other@mcp-native.test', project = 'prj-mcp-native';
export const token = 'a'.repeat(64), deviceId = '22222222-2222-4222-8222-222222222222', bindingId = 'b'.repeat(64), instanceId = '11111111-1111-4111-8111-111111111111';
export const modelId = 'native-mcp-model', gatewayUrl = 'http://127.0.0.1:1/native-mcp-boundary';
export const request = (email = owner, activeRole = 'Админ проекта') => ({ headers: {}, email, activeRole }) as unknown as Request;
export const tool = normalizeRoleMcpTool({ name: 'read_selected', description: 'Read this explicit selection', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
export const listResult = { state: 'succeeded' as const, value: { tools: [tool] } };
export const outputResult = (text = 'Private native evidence') => ({ state: 'succeeded' as const, value: { text, isError: false, truncated: false } });
export function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
interface QueryEvent { sql: string; values: unknown[]; client: PoolClient; }
export type QueryHook = (event: QueryEvent) => Promise<void>;
export interface GatewayExecution { callId: string; signal: AbortSignal; reply: ReturnType<typeof deferred<Response>>; }
export const releasedMigrations = () => CATALOG_MIGRATIONS.filter(item => item.version <= 35);

/** Every connection belongs to a disposable DB created only from an explicit caller-owned admin URL. */
export async function ownedDatabase(connection: string | undefined, prefix = 'nc_mcp_native_') {
    const url = ownedTestPostgresAdmin(connection), admin = new Pool({ connectionString: url.href, max: 1 });
    const name = prefix + randomUUID().replaceAll('-', ''); let pool: Pool | undefined;
    try {
        await admin.query('CREATE DATABASE ' + name); url.pathname = '/' + name;
        pool = new Pool({ connectionString: url.href, max: 12, options: '-c statement_timeout=10000' });
        return { pool, name, admin, async close() { await pool!.end(); try { await admin.query('DROP DATABASE IF EXISTS ' + name); } finally { await admin.end(); } } };
    } catch (error) { await pool?.end(); try { await admin.query('DROP DATABASE IF EXISTS ' + name); } finally { await admin.end(); } throw error; }
}

/** Real PG journal/policy/channel with installed receipts; fake gateway is the sole transport boundary. */
export async function createMcpFixture(connection: string | undefined) {
    const database = await ownedDatabase(connection), pool = database.pool;
    try {
        // Exercise the same registered migrator and physical readiness function used by catalogue owners.
        await ensureCatalogSchema(pool);
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$1)', [project]);
        for (const email of [owner, other]) {
            await pool.query('INSERT INTO platform_users(email) VALUES($1)', [email]);
            await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,'Админ проекта')", [project, email]);
        }
        const descriptor = { runtime: 'ollama', capability: 'chat', model: 'native:never-inferred', source: 'custom', manifestSha256: 'c'.repeat(64) };
        await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2::jsonb)', [modelId, JSON.stringify(descriptor)]);
        await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)', [project, modelId, owner]);
        const remote = buildPackage({ id: 'native-remote-mcp', name: 'Native remote fixture', kind: 'mcp', version: 1 }, [], '2026-10-25T00:00:00.000Z', { transport: 'remote', url: 'http://127.0.0.1:1/never-connect' });
        const configured = buildPackage({ id: 'native-configured-mcp', name: 'Native configured fixture', kind: 'mcp', version: 1 }, [{ path: 'index.mjs', content: 'throw new Error("Native SQL fixture never launches MCP");' }], '2026-10-25T00:00:00.000Z', { transport: 'stdio', command: 'node', entrypoint: 'index.mjs', extra: { localConfiguration: { schemaVersion: 1, fields: [{ id: 'fixture_token', label: 'Fixture token', type: 'string', required: true, secret: true, target: { kind: 'env', name: 'NATIVE_FIXTURE_TOKEN' } }] } } });
        const packages = [remote, configured], report = { protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'workspace-instance-v1', 'local-mcp-config-v1', 'package-v5', SYSTEM_ROLE_MCP_CAPABILITY], bindings: [{ projectId: project, bindingId, instanceId, valid: true }] };
        await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,last_seen,report) VALUES($1,$2,$3,$1,$4,$5,now(),$6::jsonb)', [deviceId, owner, 'Админ проекта', 'd'.repeat(64), digest(token), JSON.stringify(report)]);
        const claims = async (email: string) => {
            const account = (await pool.query('SELECT enabled FROM platform_users WHERE email=$1', [email])).rows[0];
            if (!account?.enabled) throw new ForbiddenException('Fixture account disabled');
            const rows = (await pool.query('SELECT project_id,role FROM project_members WHERE principal_name=$1', [email])).rows;
            return { email, userRoles: [...new Set(rows.map(row => String(row.role)))], projects: rows.map(row => ({ projectId: row.project_id, role: row.role })) };
        };
        let queryHook: QueryHook | undefined;
        const transactionalPool = new Proxy(pool, { get(target, key) {
            if (key === 'connect') return async () => {
                const client = await target.connect();
                return new Proxy(client, { get(db, property) {
                    if (property === 'query') return async (sql: string, values: unknown[] = []) => {
                        const result = await db.query(sql, values); await queryHook?.({ sql, values, client: db }); return result;
                    };
                    const value = Reflect.get(db, property); return typeof value === 'function' ? value.bind(db) : value;
                } });
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
        const actor = async (req: Request) => {
            const direct = req as unknown as { email?: string; activeRole?: string };
            const identity = direct.email ? direct : JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] ?? '{}')));
            const current = await claims(identity.email);
            if (!current.userRoles.includes(identity.activeRole)) throw new ForbiddenException('Fixture role revoked');
            return { email: identity.email, activeRole: identity.activeRole, claims: current };
        };
        const models = { pool: transactionalPool, ready: async () => undefined, actor, getUsable: async () => modelFromRow((await pool.query('SELECT * FROM model_catalog WHERE id=$1', [modelId])).rows[0]),
            resolveProject: async (req: Request, id: string, minimum: number, existing?: Awaited<ReturnType<typeof actor>>) => {
                const current = existing ?? await actor(req), grant = current.claims.projects.find(row => row.projectId === id);
                const level = grant?.role === 'Админ проекта' ? 3 : grant?.role === 'Наблюдатель' ? 1 : 0;
                if (level < minimum) throw new ForbiddenException('Fixture project revoked'); return { id };
            } } as unknown as ModelsService;
        // Reuse the real methods without constructing DeviceStore's environment-selected pool.
        const devices = Object.assign(Object.create(DeviceStore.prototype), { pool: transactionalPool, access: { claims } }) as DeviceStore;
        const installations = new DeviceInstallations(devices), plans = new InstallPlans(devices, {} as never);
        const newService = () => new SystemRoleMcpService(models, devices, installations, plans);
        let service = newService();
        const executions: GatewayExecution[] = [], arrivals: Array<ReturnType<typeof deferred<GatewayExecution>>> = [];
        const transportViolations: string[] = [];
        const fetchBoundary = async (raw: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = String(raw), operation = url.slice(gatewayUrl.length);
            if (!url.startsWith(gatewayUrl) || !['/internal/system-role-mcp/execute', '/internal/system-role-mcp/close', '/internal/events'].includes(operation) || init?.method !== 'POST'
                || new Headers(init.headers).get('x-neurocenter-internal') !== 'native-fixture-internal') {
                transportViolations.push(url); throw new Error('Forbidden transport outside exact fake gateway boundary');
            }
            const body = JSON.parse(String(init.body));
            if (operation === '/internal/events') {
                if (JSON.stringify(body) !== JSON.stringify({ sections: ['operations', 'audit', 'projects'] })) throw new Error('Unexpected operation invalidation');
                return Response.json({ ok: true });
            }
            if (operation.endsWith('/close')) return Response.json({ ok: true });
            if (Object.keys(body).join(',') !== 'callId') throw new Error('Unexpected execute payload');
            const execution = { callId: body.callId, signal: init.signal!, reply: deferred<Response>() };
            executions.push(execution); arrivals.shift()?.resolve(execution);
            return new Promise<Response>((resolve, reject) => {
                const abort = () => reject(execution.signal.reason ?? new Error('Aborted fake gateway'));
                execution.signal.addEventListener('abort', abort, { once: true });
                execution.reply.promise.then(resolve, reject).finally(() => execution.signal.removeEventListener('abort', abort));
                if (execution.signal.aborted) abort();
            });
        };
        const configurationRevision = randomUUID();
        const target = (runtime: 'server' | 'device' = 'server', pkg = remote): RoleMcpTarget => ({ runtime, assetId: pkg.plugin.id, version: pkg.plugin.version, manifest: pkg.manifest.sha256,
            ...(runtime === 'device' ? { deviceId, bindingId, instanceId, configurationRevisions: pkg === configured ? [{ assetId: pkg.plugin.id, manifest: pkg.manifest.sha256, revision: configurationRevision }] : [] } : {}) }) as RoleMcpTarget;
        const job = async (kind: string, payload: Record<string, unknown>, state = 'succeeded') => {
            const id = randomUUID(); await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,started_at,lease,lease_until)
                VALUES($1,$2,$3,'Админ проекта',$4,$5,$6::jsonb,$1,$7,$8,now(),$9,now()+interval '5 minutes')`, [id, deviceId, owner, project, kind, JSON.stringify(payload), 'e'.repeat(64), state, randomUUID()]); return id;
        };
        const reset = async () => {
            await pool.query('DELETE FROM device_model_calls'); await pool.query('DELETE FROM model_device_connections');
            // This SQL-only fixture never starts a physical worker. Explicitly release its own exact leases before deleting history.
            const pending = (await pool.query('SELECT s.id,s.worker_lease,d.token_hash FROM system_role_mcp_sessions s JOIN bridge_devices d ON d.id::text=s.target->>\'deviceId\' AND d.email=s.owner_email WHERE s.target->>\'runtime\'=\'device\' AND s.claimed_at IS NOT NULL AND s.worker_closed_at IS NULL')).rows;
            for (const row of pending) await service.repository.acknowledgeDeviceClosed(row.id, row.worker_lease, row.token_hash);
            await pool.query('DELETE FROM system_role_mcp_sessions'); await pool.query('DELETE FROM system_role_runs'); await pool.query('DELETE FROM bridge_jobs'); await pool.query('DELETE FROM device_install_plans');
            await pool.query('UPDATE platform_users SET enabled=true'); await pool.query("UPDATE project_members SET role='Админ проекта'");
            await pool.query('UPDATE bridge_devices SET revoked=false,expires_at=now()+interval \'1 day\',report=$2::jsonb WHERE id=$1', [deviceId, JSON.stringify(report)]);
            await pool.query('UPDATE model_catalog SET descriptor=$2::jsonb,revision=1 WHERE id=$1', [modelId, JSON.stringify(descriptor)]);
            await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [project, modelId, owner]);
            for (const pkg of packages) {
                await pool.query(`INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot)
                    VALUES($1,$2,'mcp',$3,1,$4,'assigned',$5::jsonb) ON CONFLICT(project_id,asset_id,asset_kind) DO UPDATE SET asset_manifest=EXCLUDED.asset_manifest,pin_snapshot=EXCLUDED.pin_snapshot`, [project, pkg.plugin.id, owner, pkg.manifest.sha256, JSON.stringify({ card: pkg.plugin, package: pkg })]);
                await pool.query(`INSERT INTO device_install_plans(id,project_id,asset_kind,asset_id,version,manifest,package,status,created_by,approved_by,approved_at)
                    VALUES($1,$2,'mcp',$3,1,$4,$5::jsonb,'approved',$6,$6,now())`, [randomUUID(), project, pkg.plugin.id, pkg.manifest.sha256, JSON.stringify(pkg), owner]);
                await job('install', { bindingId, instanceId, package: pkg });
            }
            const statusJob = await job('get-mcp-configuration-status', { bindingId, instanceId, package: configured });
            await pool.query('UPDATE bridge_jobs SET result=$2::jsonb WHERE id=$1', [statusJob, JSON.stringify({ schemaVersion: 1, projectId: project, bindingId, instanceId, assetId: configured.plugin.id, assetKind: 'mcp', version: 1, manifest: configured.manifest.sha256,
                schemaDigest: configurationSchemaDigest(configured), ready: true, missingFieldIds: [], revision: configurationRevision, checkedAt: new Date().toISOString() })]);
            queryHook = undefined; service = newService(); executions.length = 0; transportViolations.length = 0;
        };
        const run = async (selectedTarget = target()) => {
            const key = roleMcpToolKey(selectedTarget, tool.name), selected = { ...selectedTarget, discoveryId: randomUUID(), tools: [{ name: tool.name, schemaDigest: tool.schemaDigest }] };
            const prepared = [{ target: selected, tools: [{ ...tool, toolKey: key }] }], model = await models.getUsable(modelId, request());
            const input: StartRoleRun = { projectId: project, instruction: 'Native SQL boundary only', diagnostics: [], targets: [], mcp: [selected], requestId: randomUUID(), modelId,
                expectedModelPin: projectEmbeddingPin(model), expectedDefinitionPin: roleDefinitionPin('agent-ai-admin'), consentDigest: 'f'.repeat(64), sourceFeature: 'system_role_chat' };
            const journal = new SystemRoleRepository(transactionalPool), actorValue = await actor(request());
            const row = await journal.create({ agent_id: 'agent-ai-admin', project_id: project, actor: owner, actor_role: 'Админ проекта', request_id: input.requestId, request_hash: roleHash(input), request: input,
                snapshot: { selection: input, definitionPin: input.expectedDefinitionPin, consentDigest: input.consentDigest, preview: 'Explicit selected fixture', targets: [], mcp: prepared }, model }, db => service.policy.roles.authorize(db, actorValue, project));
            await pool.query("UPDATE system_role_runs SET state='running',phase='collecting',revision=revision+1 WHERE id=$1", [row.id]);
            return { row: (await journal.get(row.id))!, prepared, key, journal };
        };
        const enqueue = async (row: RoleRunRow, selectedTarget: RoleMcpTarget = target()) => {
            const pkg = packages.find(item => item.plugin.id === selectedTarget.assetId)!;
            return service.repository.enqueue({ owner, role: 'Админ проекта', project, target: selectedTarget, package: pkg, run: row }, { key: roleMcpToolKey(selectedTarget, tool.name), name: tool.name, digest: tool.schemaDigest, arguments: { text: 'Explicit own scope' } },
                (db, current) => service.policy.roles.current(request(), current, db).then(() => undefined));
        };
        const configurationForm = async () => {
            const approved = await plans.approvedConfiguration(project, configured), schemaDigest = configurationSchemaDigest(configured)!;
            const payload = { ...approved, bindingId, instanceId, schemaDigest, assetId: configured.plugin.id, assetKind: 'mcp', version: 1 };
            const preparationId = randomUUID(), expiresAt = new Date(Date.now() + 600_000).toISOString();
            const preparationJobId = await job('prepare-mcp-configuration', payload);
            await pool.query('UPDATE bridge_jobs SET result=$2::jsonb WHERE id=$1', [preparationJobId, JSON.stringify({ schemaVersion: 1, projectId: project, bindingId, instanceId,
                assetId: configured.plugin.id, assetKind: 'mcp', version: 1, manifest: configured.manifest.sha256, schemaDigest, preparationId, expiresAt })]);
            return job('open-mcp-configuration', { ...payload, configurationPreparationJobId: preparationJobId, configurationPreparationId: preparationId, configurationExpiresAt: expiresAt }, 'running');
        };
        /** Real job/call CAS and receipt methods; only the trusted connector's filesystem preflight is isolated. */
        const codexCas = async () => {
            const semantic = '9'.repeat(64), source = { scope: 'project' as const, projectId: project, bindingId, instanceId };
            await pool.query('UPDATE model_catalog SET descriptor=$2::jsonb WHERE id=$1', [modelId, JSON.stringify({ runtime: 'device-codex', capability: 'chat', model: 'native-codex-never-inferred', modelVersion: 'fixture', manifestSha256: null, verificationSha256: semantic, dimension: null, source: 'custom' })]);
            const model = modelFromRow((await pool.query('SELECT * FROM model_catalog WHERE id=$1', [modelId])).rows[0]), callId = randomUUID();
            await pool.query(`INSERT INTO model_device_connections(model_id,device_id,owner_email,source,expected_candidate,connector_package,semantic_sha)
                VALUES($1,$2,$3,$4::jsonb,'{}','{}',$5)`, [modelId, deviceId, owner, JSON.stringify(source), semantic]);
            const payload = normalizeDeviceCodexPayload({ protocol: DEVICE_CODEX_PROTOCOL, callId, modelId, modelPin: projectEmbeddingPin(model), connectionRevision: 1, source, deadlineAt: new Date(Date.now() + 60_000).toISOString(), dispatchOnlyFeatures: ['system_role_mcp'] });
            const jobId = await job('infer-device-codex', payload as unknown as Record<string, unknown>, 'running');
            await pool.query(`INSERT INTO device_model_calls(id,job_id,model_id,device_id,owner_email,actor_role,project_id,model_pin,runtime_model,connection_revision,request,required_features,deadline_at)
                VALUES($1,$2,$3,$4,$5,'Админ проекта',$6,$7,$8,1,'{"messages":[{"role":"user","content":"Never inferred"}],"options":{}}','["device_codex_inference","system_ai_admin"]',$9)`,
            [callId, jobId, modelId, deviceId, owner, project, payload.modelPin, model.model, payload.deadlineAt]);
            const lease = (await pool.query('SELECT lease FROM bridge_jobs WHERE id=$1', [jobId])).rows[0].lease;
            const preflight = vi.spyOn(DeviceCodexConnections.prototype, 'assertCurrent').mockImplementation(async () => devices.identity(token));
            const create = (currentPool: Pool = transactionalPool) => new DeviceCodexService({ ...models, pool: currentPool, get: async () => model } as never, devices, { build: async () => { throw new Error('Native CAS fixture never loads connector bytes'); } } as never, { run: async () => { throw new Error('Native CAS fixture never invokes a model'); } } as never);
            const codex = create(), device = await devices.identity(token);
            return { service: codex, device, jobId, callId, body: { jobId, callId, lease }, restore: () => preflight.mockRestore(),
                onClient(client: PoolClient) {
                    const borrowed = new Proxy(client, { get(db, key) { if (key === 'release') return () => undefined; const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value; } });
                    return create({ query: client.query.bind(client), connect: async () => borrowed } as unknown as Pool);
                },
                async deliver() {
                    const result = { protocol: DEVICE_CODEX_PROTOCOL, callId, response: { model: model.model, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'Private completed native SQL evidence' }, prompt_eval_count: null, eval_count: null, usage_reported: false } };
                    return service.repository.transaction(async db => {
                        const stored = (await db.query('SELECT * FROM bridge_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
                        return completeDeviceCodex(db, stored, { lease, state: 'succeeded', percent: 100, message: 'Completed fixture', result } as never);
                    });
                } };
        };
        return { ...database, models, devices, installations, plans, remote, configured, target, job, run, enqueue, configurationForm, codexCas, reset, executions, transportViolations, fetchBoundary,
            get service() { return service; }, setHook(hook?: QueryHook) { queryHook = hook; }, newService,
            nextExecution() { const arrival = deferred<GatewayExecution>(); arrivals.push(arrival); return arrival.promise; },
            async stop() { queryHook = undefined; await service.onApplicationShutdown(); },
            async close() { await service.onApplicationShutdown(); await database.close(); } };
    } catch (error) { await database.close(); throw error; }
}

/** Observe a real waiting backend and its exact blocker, without elapsed-time assertions or sleeps. */
export async function assertBlockedBy(pool: Pool, waitingPid: number, blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        const { rows } = await pool.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [waitingPid]);
        if (rows[0].blockers.includes(blockerPid)) return;
    }
    throw new Error('Expected concurrent PostgreSQL UPDATE did not wait on the controlled lock barrier');
}

export type McpFixture = Awaited<ReturnType<typeof createMcpFixture>>;
