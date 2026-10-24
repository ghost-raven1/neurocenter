import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { Pool } from 'pg';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { AccessDb } from '../src/access/access-db';
import { DeviceStore, digest } from '../src/devices/device-store';
import { DeviceJobs } from '../src/devices/device-jobs';
import { DeviceController } from '../src/devices/device.controller';
import { DeviceInstallations } from '../src/devices/device-installations';
import { InstallPlans } from '../src/devices/install-plans';
import type { Job } from '../src/devices/device-job.model';
import { ProjectEmbeddingService } from '../src/models/project-embedding.service';
import { HostedRagGrantService } from '../src/models/hosted-rag-grant.service';
import { DeviceEmbeddingService } from '../src/models/device-embedding.service';
import { modelFromRow, saveModelVersion } from '../src/models/model-history';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { initialGeneration } from '../src/models/project-embedding.repository';
import { ragPackage } from './rag-install-inspection.fixture';
import { pendingCompletions, saveCompletion, deliverCompletions, type Completion } from '../../../mcp/neurocenter-asset-sync/src/bridge/completions';
import { stateDir, writeState } from '../../../mcp/neurocenter-asset-sync/src/bridge/state';

/** Real migration schema, authorization and durable worker delivery; model execution and its committed file are controlled boundaries. */
export async function lateCompletionFixture(connection: string) {
    const url = ownedTestPostgresAdmin(connection), admin = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000, query_timeout: 10000 });
    const database = 'nc_late_completion_' + randomUUID().replaceAll('-', '');
    let before: string[] = [], temporary: string | undefined;
    const names = ['CATALOG_PG_URL', 'SSO_DISABLE', 'NEUROCENTER_INTERNAL_TOKEN', 'NEUROCENTER_BRIDGE_HOME', 'NEUROCENTER_URL'] as const;
    const environment = new Map(names.map(name => [name, process.env[name]]));
    let pool: Pool | undefined, access: AccessDb | undefined, store: DeviceStore | undefined, created = false;
    async function close() {
        const closed = await Promise.allSettled([store?.onModuleDestroy(), access?.onModuleDestroy(), pool?.end()]);
        const errors = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        let after: string[] = [];
        try {
            if (created) await admin.query('DROP DATABASE ' + database);
            after = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row => row.datname);
        } catch (error) { errors.push(error); }
        finally {
            const disposed = await Promise.allSettled([admin.end(), temporary ? rm(temporary, { recursive: true, force: true }) : Promise.resolve()]);
            for (const result of disposed) if (result.status === 'rejected') errors.push(result.reason);
            for (const [name, value] of environment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        }
        if (errors.length) throw new AggregateError(errors, 'Owned late-completion fixture cleanup failed.');
        return { dropped: created && !after.includes(database), originalDatabasesPreserved: before.every(name => after.includes(name)),
            newDatabasesRemaining: after.filter(name => !before.includes(name)) };
    }
    try {
        before = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row => row.datname);
        temporary = await mkdtemp(path.join(os.tmpdir(), 'nc-late-completion-')); const ownedDirectory = temporary;
        await admin.query('CREATE DATABASE ' + database); created = true; url.pathname = '/' + database;
        process.env.CATALOG_PG_URL = url.href; process.env.SSO_DISABLE = 'false';
        process.env.NEUROCENTER_INTERNAL_TOKEN = randomBytes(32).toString('hex'); process.env.NEUROCENTER_URL = 'http://late-completion.example.test';
        pool = new Pool({ connectionString: url.href, max: 4 }); await ensureCatalogSchema(pool);
        access = new AccessDb(); await access.ready(); store = new DeviceStore(access); await store.ready();
        const db = pool, devices = store, installations = new DeviceInstallations(devices), plans = new InstallPlans(devices, {} as never);
        const selection = new ProjectEmbeddingService({ pool: db, ready: async () => undefined } as never, {} as never);
        const grants = new HostedRagGrantService(devices, installations, plans, selection);
        let inferenceCalls = 0;
        const broker = new DeviceEmbeddingService(devices, { infer: async () => { inferenceCalls++; return { embeddings: [[1, 2, 3]] }; } }, grants);
        const jobs = new DeviceJobs(devices, {} as never, installations, plans, selection);
        const controller = new DeviceController(devices, jobs, installations, {} as never, broker);
        return { pool: db, close, inferenceCalls: () => inferenceCalls,
            async begin() {
                const projectId = 'prj-' + randomUUID(), otherProjectId = 'prj-' + randomUUID(), email = randomUUID() + '@example.test';
                const deviceId = randomUUID(), token = randomBytes(32).toString('hex'), bindingId = 'a'.repeat(64), instanceId = randomUUID();
                const actor = { email, activeRole: 'Разработчик' }, pkg = ragPackage('mcp'), planId = randomUUID();
                const root = path.join(ownedDirectory, projectId); await mkdir(root);
                process.env.NEUROCENTER_BRIDGE_HOME = path.join(root, 'private');
                if (!stateDir().startsWith(root + path.sep)) throw new Error('Worker state escaped the owned temporary directory.');
                await writeState('credentials', { token, deviceId, email });
                await db.query('INSERT INTO projects(id,name) VALUES($1,$1),($2,$2)', [projectId, otherProjectId]);
                await db.query('INSERT INTO platform_users(email) VALUES($1)', [email]);
                for (const project of [projectId, otherProjectId]) await db.query(`INSERT INTO project_members(project_id,user_id,principal_name,display_name,role)
                    VALUES($1,$2,$2,'Owned worker','Разработчик')`, [project, email]);
                const report = { protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'package-v5', 'install-set-v1',
                    'workspace-instance-v1', 'opencode-rag-ui-v1', 'hosted-rag-model-v1', 'hosted-rag-grants-v1', 'hosted-rag-profile-values-v1', 'hosted-rag-reindex-v1'],
                    bindings: [{ projectId, bindingId, instanceId, folderName: 'owned-project', valid: true }] };
                await db.query(`INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report)
                    VALUES($1,$2,'Разработчик','Owned worker',$3,$4,$5)`, [deviceId, email, 'b'.repeat(64), digest(token), report]);
                const descriptor = { description: '', capability: 'embedding', runtime: 'ollama', model: 'controlled:v1', manifestSha256: 'c'.repeat(64), dimension: 3, source: 'custom' };
                const row = (await db.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2) RETURNING *', ['model-' + randomUUID(), descriptor])).rows[0];
                await saveModelVersion(db, row); const model = modelFromRow(row), modelPin = projectEmbeddingPin(model);
                await db.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)', [projectId, model.id, email]);
                await db.query(`INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation)
                    VALUES($1,1,$2,$3,3,$4,$5)`, [projectId, model.id, modelPin, email, initialGeneration(projectId)]);
                await db.query(`INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot)
                    VALUES($1,$2,'mcp',$3,$4,$5,'assigned',$6)`, [projectId, pkg.plugin.id, email, pkg.plugin.version, pkg.manifest.sha256, { card: {}, package: pkg }]);
                await db.query(`INSERT INTO device_install_plans(id,project_id,asset_kind,asset_id,version,manifest,package,status,revision,created_by)
                    VALUES($1,$2,'mcp',$3,$4,$5,$6,'approved',1,$7)`, [planId, projectId, pkg.plugin.id, pkg.plugin.version, pkg.manifest.sha256, pkg, email]);
                const selected = await selection.requireCurrent(projectId), payload = { assetId: pkg.plugin.id, assetKind: 'mcp', version: pkg.plugin.version, package: pkg,
                    bindingId, instanceId, embedding: selected, planId, planRevision: 1, approvalRoot: { kind: 'mcp', id: pkg.plugin.id, version: pkg.plugin.version },
                    approvalManifest: pkg.manifest.sha256, reindex: true, ragReindexProtocol: 'hosted-rag-reindex-v1' };
                async function seed(kind: string, state: string) {
                    const id = randomUUID(); await db.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state)
                        VALUES($1,$2,$3,'Разработчик',$4,$5,$6,$1,$7,$8)`, [id, deviceId, email, projectId, kind, payload, 'd'.repeat(64), state]); return id;
                }
                await seed('install', 'succeeded'); const id = await seed('connect-rag-model', 'queued');
                const request = { headers: { authorization: 'Bearer ' + token, 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN } } as unknown as Request;
                const claimed = await controller.claim(request) as Job;
                if (!claimed || claimed.id !== id) throw new Error('Owned connect job was not delivered.');
                await controller.authorize(request, id, { lease: claimed.lease });
                const input = { projectId, bindingId, instanceId, expectedRevision: selected.revision, expectedModelPin: modelPin,
                    installation: { kind: 'mcp', id: pkg.plugin.id, version: pkg.plugin.version, manifest: pkg.manifest.sha256 }, model: selected.profile.model, input: ['Owned synthetic query'] };
                const receipt: Completion = { id, lease: claimed.lease, deviceId, state: 'succeeded', message: 'Controlled bridge commit completed.',
                    result: { status: 'connected', revision: selected.revision, modelPin, profile: selected.profile, requiresRestart: true,
                        reindex: { complete: true, rowCount: 1, snapshotHash: 'e'.repeat(64), serverSynced: true } } };
                const file = path.join(root, 'committed-worker-output.json');
                return { id, projectId, otherProjectId, deviceId, email, actor, report, receipt, file,
                    authorize: () => controller.authorize(request, id, { lease: claimed.lease }),
                    embed: async () => broker.embed(await devices.identity(token), input),
                    complete: () => controller.complete(request, id, receipt),
                    deliver: () => deliverCompletions(item => controller.complete(request, item.id, item)),
                    pending: pendingCompletions,
                    async commit() {
                        // The integration starts at a controlled worker's already committed effect; native index construction is tested separately.
                        await writeFile(file, JSON.stringify({ committed: true, profile: selected.profile, snapshot: receipt.result.reindex }), { flag: 'wx', mode: 0o600 });
                        await saveCompletion(receipt); return { bytes: await readFile(file), mtime: (await stat(file)).mtimeMs };
                    },
                    async expire() { await db.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [id]); await jobs.list(actor); },
                    list: () => jobs.list(actor),
                    job: async () => (await db.query('SELECT state,result,lease FROM bridge_jobs WHERE id=$1', [id])).rows[0],
                    journal: async () => (await db.query('SELECT * FROM operations WHERE operation_id=$1', ['bridge-' + id])).rows,
                    grant: async () => (await db.query('SELECT revoked_at FROM bridge_hosted_rag_grants WHERE job_id=$1', [id])).rows[0],
                    async revokeMembership() { await db.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2', [projectId, email]); },
                    async restoreMembership() { await db.query(`INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,'Owned worker','Разработчик')`, [projectId, email]); },
                    async rebind() { await devices.heartbeat(await devices.identity(token), { ...report, bindings: [{ ...report.bindings[0], bindingId: 'f'.repeat(64), instanceId: randomUUID() }] }); },
                    async restoreBinding() { await devices.heartbeat(await devices.identity(token), report); },
                    revokeDevice: () => devices.revoke(actor, deviceId),
                    replaceCredentials: () => writeState('credentials', { token: randomBytes(32).toString('hex'), deviceId: randomUUID(), email }),
                };
            },
        };
    } catch (cause) {
        try { await close(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Owned fixture setup and cleanup failed.'); }
        throw cause;
    }
}
