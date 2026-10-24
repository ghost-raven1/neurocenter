import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Pool } from 'pg';
import { vi } from 'vitest';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import type { IModel, TModelRuntime } from '../src/models/model.types';
import { roleDefinitionPin } from '../src/system-roles/system-role.definitions';
import { SystemRoleService } from '../src/system-roles/system-role.service';
import type { RoleRunRow, RoleRunView, StartRoleRun } from '../src/system-roles/system-role.types';

export function barrier() {
    let resolve!: () => void, reject!: (reason: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

/** Only model execution is controlled: admission, claims, cancellation, fencing and operations use real SQL. */
export async function systemRoleQueueFixture(connection: string) {
    const url = ownedTestPostgresAdmin(connection), admin = new Pool({ connectionString: url.href, max: 1 });
    const database = 'nc_role_queue_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE DATABASE ' + database);
    url.pathname = '/' + database;
    const pool = new Pool({ connectionString: url.href, max: 4 });
    let service: SystemRoleService | undefined;
    const gates = new Map<string, ReturnType<typeof barrier>>(), abortGates = new Map<string, ReturnType<typeof barrier>>();
    const settlementGates = new Map<string, ReturnType<typeof barrier>>();
    const started: RoleRunRow[] = [], running = new Set<string>(), peaks = { server: 0, device: 0, total: 0 };
    const models = new Map<string, IModel>();
    const actor = (req: Request) => ({ email: String(req.headers['x-test-actor']), activeRole: 'Главный админ', claims: { userRoles: ['Главный админ'], projects: [] } });
    const req = (email: string) => ({ headers: { 'x-test-actor': email } } as unknown as Request);
    try {
        await ensureCatalogSchema(pool);
        const owner = { pool, actor: vi.fn(async (request: Request) => actor(request)), ready: vi.fn(async () => undefined),
            getUsable: vi.fn(async (id: string) => models.get(id)!) };
        service = new SystemRoleService(owner as never, {} as never, {} as never, {} as never, {} as never, {} as never);
        vi.spyOn(service.policy, 'authorize').mockResolvedValue(undefined);
        vi.spyOn(service.policy, 'modelInTransaction').mockImplementation(async (_db, _actor, _project, id) => models.get(id)!);
        vi.spyOn(service.targets, 'prepare').mockImplementation(async (_req, id, selection) => ({ selection,
            definitionPin: roleDefinitionPin(id), consentDigest: 'b'.repeat(64), preview: 'Controlled context', targets: [] }));
        const runner = (service as unknown as { runner: { run(req: Request, row: RoleRunRow, signal: AbortSignal): Promise<void> } }).runner;
        vi.spyOn(runner, 'run').mockImplementation(async (_req, row, signal) => {
            started.push(row); running.add(row.id);
            const count = (device: boolean) => started.filter(item => running.has(item.id) && (item.model.runtime === 'device-codex') === device).length;
            peaks.server = Math.max(peaks.server, count(false)); peaks.device = Math.max(peaks.device, count(true)); peaks.total = Math.max(peaks.total, running.size);
            let aborted!: () => void;
            const stopped = new Promise<never>((_resolve, reject) => {
                aborted = () => { abortGates.get(row.actor)?.resolve(); reject(signal.reason); };
                signal.addEventListener('abort', aborted, { once: true });
                if (signal.aborted) aborted();
            });
            try {
                await Promise.race([gates.get(row.actor)?.promise ?? Promise.resolve(), stopped]);
                signal.throwIfAborted();
                await service!.repository.fenced(row.id, row.lease_token, (db, current) => service!.repository.change(db, current, 'succeeded', 'completed', 'Controlled model completed.'));
            } finally {
                signal.removeEventListener('abort', aborted);
                if (signal.aborted) await settlementGates.get(row.actor)?.promise;
                running.delete(row.id);
            }
        });
        const input = (runtime: TModelRuntime): StartRoleRun => {
            const model = { id: 'model-' + runtime, name: 'Controlled model', runtime, capability: 'chat', model: 'controlled', revision: 1,
                manifestSha256: 'a'.repeat(64), verificationSha256: 'a'.repeat(64), source: 'custom', description: '', dimension: null,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as IModel;
            models.set(model.id, model);
            return { projectId: null, instruction: 'Controlled queue check', diagnostics: [], targets: [], requestId: randomUUID(),
                modelId: model.id, expectedModelPin: projectEmbeddingPin(model), expectedDefinitionPin: roleDefinitionPin('agent-ai-admin'), consentDigest: 'b'.repeat(64) };
        };
        const idle = () => vi.waitFor(() => {
            const scheduler = service as unknown as { draining: boolean; active: Map<string, AbortController> };
            if (running.size || scheduler.active.size || scheduler.draining) throw new Error('Controlled runner did not settle.');
        }, { timeout: 2000, interval: 10 });
        return { pool, service, started, running, peaks, req, input, idle,
            hold(email: string, waitForSettlement = false) {
                const gate = barrier(), aborted = barrier(); gates.set(email, gate); abortGates.set(email, aborted);
                const settlement = barrier(); if (waitForSettlement) settlementGates.set(email, settlement);
                return { ...gate, aborted: aborted.promise, settle: settlement.resolve };
            },
            start(email: string, runtime: TModelRuntime = 'ollama') { return service!.start(req(email), 'agent-ai-admin', input(runtime)); },
            async cancel(view: RoleRunView) {
                const current = (await service!.repository.get(view.id))!;
                return service!.cancel(req(current.actor), current.agent_id, current.id, { expectedRevision: current.revision, requestId: randomUUID() });
            },
            async close() {
                for (const gate of gates.values()) gate.resolve();
                for (const gate of settlementGates.values()) gate.resolve();
                await service!.onApplicationShutdown();
                await idle();
                await pool.end();
                try { await admin.query('DROP DATABASE ' + database); } finally { await admin.end(); }
            },
        };
    } catch (cause) {
        service?.onApplicationShutdown(); await pool.end();
        try { await admin.query('DROP DATABASE ' + database); } finally { await admin.end(); }
        throw cause;
    }
}
