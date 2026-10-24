import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { ModelApiAdmission } from '../src/model-api-admission/model-api-admission';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import { RemoteConnectionService } from '../src/models/remote-connection.service';
import { RemoteModelClient } from '../src/models/remote-model-client';
import type { IModel } from '../src/models/model.types';
import type { ModelsService } from '../src/models/models.service';
import type { IRemoteConnectionRow } from '../src/models/remote-connection.repository';

vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: vi.fn(async () => undefined) }));
const connection = process.env.MODEL_USAGE_TEST_PG_URL;
const model = { id: 'metadata-model', name: 'Metadata model', capability: 'chat', runtime: 'remote-openai', model: 'fixture', revision: 1,
    verificationSha256: 'a'.repeat(64) } as IModel;
const answer = { message: { content: 'completed answer never stored in metadata' } };
function barrier() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
/** The test timeout releases its explicitly held lock in finally; it does not cancel production work for the assertion. */
async function within<T>(pending: Promise<T>, ms = 2200): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Metadata failure still blocks the outcome')), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
}

describe.skipIf(!connection)('Inference metadata isolation on caller-owned PostgreSQL', () => {
    let admin: Pool, observer: Pool, remotePool: Pool, database: string, service: ModelUsageService, oldUrl: string | undefined;
    let locks: PoolClient[] = [];
    let releaseWaiters: (() => void)[] = [];
    let clearTrace: () => void = () => undefined;
    const pending: Promise<unknown>[] = [];
    const lock = async (sql: string, values?: unknown[]) => {
        const db = await observer.connect(); locks.push(db); await db.query('BEGIN'); await db.query(sql, values); return db;
    };
    const unlock = async () => {
        for (const db of locks.splice(0)) { try { await db.query('ROLLBACK'); } finally { db.release(); } }
    };
    const observe = (action: Parameters<ModelUsageService['observe']>[2]) => {
        const result = service.observe(model, 'chat', action); pending.push(result.catch(() => undefined)); return result;
    };
    const flush = () => (service as unknown as { flush(): Promise<void> }).flush();
    beforeAll(async () => {
        const url = ownedTestPostgresAdmin(connection); admin = new Pool({ connectionString: url.href, max: 1 });
        database = 'nc_metadata_isolation_' + randomUUID().replaceAll('-', '');
        await admin.query('CREATE DATABASE ' + database); url.pathname = '/' + database;
        observer = new Pool({ connectionString: url.href, max: 4 });
        remotePool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 1000 });
        await ensureCatalogSchema(observer);
        await observer.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)', [model.id, model.name, JSON.stringify({ runtime: model.runtime, capability: 'chat' })]);
        await observer.query(`INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,semantic_sha,options,timeout_ms,failure_message)
            VALUES($1,1,'http://127.0.0.1:1/v1',false,'none',$2,'{}',90000,'stale health error')`, [model.id, model.verificationSha256]);
        oldUrl = process.env.CATALOG_PG_URL; process.env.CATALOG_PG_URL = url.href;
        service = new ModelUsageService({ ready: async () => undefined } as unknown as ModelsService); await service.onModuleInit();
    });
    beforeEach(async () => {
        await observer.query("UPDATE model_remote_connections SET failure_message='stale health error' WHERE model_id=$1", [model.id]);
        const flags = defaultFeatureFlags(); flags.model_rate_limits = false;
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 })));
    });
    afterEach(async () => {
        clearTrace(); clearTrace = () => undefined;
        for (const release of releaseWaiters.splice(0)) release();
        await unlock(); await Promise.allSettled(pending.splice(0)); await flush();
        if (observer) await observer.query('TRUNCATE model_usage_calls');
        vi.restoreAllMocks(); vi.unstubAllGlobals();
    });
    afterAll(async () => {
        await unlock(); await service?.onApplicationShutdown(); await remotePool?.end(); await observer?.end();
        if (admin) { try { if (database) await admin.query('DROP DATABASE IF EXISTS ' + database); } finally { await admin.end(); } }
        if (oldUrl === undefined) delete process.env.CATALOG_PG_URL; else process.env.CATALOG_PG_URL = oldUrl;
    });

    it.each(['success', 'error'] as const)('returns the original %s outcome while its terminal row remains locked and retries only the receipt', async outcome => {
        const entered = barrier(), respond = barrier(), providerError = new Error('original provider failure');
        const action = vi.fn(async () => { entered.release(); await respond.promise; if (outcome === 'error') throw providerError; return answer; });
        const result = observe(action), captured = result.then(value => ({ value }), error => ({ error }));
        await entered.promise;
        const id = (await observer.query('SELECT id FROM model_usage_calls')).rows[0].id;
        await lock('SELECT id FROM model_usage_calls WHERE id=$1 FOR UPDATE', [id]); respond.release();
        const completed = await within(captured);
        if (outcome === 'success') expect(completed).toEqual({ value: answer }); else expect(completed).toEqual({ error: providerError });
        expect(action).toHaveBeenCalledOnce();
        expect((await observer.query('SELECT status FROM model_usage_calls WHERE id=$1', [id])).rows[0].status).toBe('pending');
        await unlock(); await flush();
        expect((await observer.query('SELECT status FROM model_usage_calls WHERE id=$1', [id])).rows[0].status).toBe(outcome);
        expect(action).toHaveBeenCalledOnce();
    });

    it('frees saturated activity clients so an unrelated reservation and answer finish before the old locks are released', async () => {
        expect((await service.pool.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('500ms');
        const started = performance.now(), timeline: { ms: number; event: string; code?: string; total: number; waiting: number }[] = [];
        const trace = (event: string, code?: string) => timeline.push({ ms: Math.round(performance.now() - started), event, ...(code ? { code } : {}), total: service.pool.totalCount, waiting: service.pool.waitingCount });
        const acquire = () => trace('acquire'), connect = () => trace('connect'), remove = () => trace('remove');
        const release = (error: Error | undefined) => trace('release', (error as { code?: string } | undefined)?.code ?? error?.message);
        service.pool.on('acquire', acquire).on('connect', connect).on('remove', remove).on('release', release);
        clearTrace = () => { service.pool.off('acquire', acquire).off('connect', connect).off('remove', remove).off('release', release); };
        const ready = barrier(); let entered = 0;
        const actions = Array.from({ length: 5 }, () => vi.fn(async () => answer));
        const dispatch = actions.map(() => barrier()); releaseWaiters = dispatch.map(gate => gate.release);
        const active = actions.map((action, index) => observe(async signal => {
            if (++entered === actions.length) ready.release(); await dispatch[index].promise;
            return new ModelApiAdmission({ acquire: vi.fn() } as never).run(model, signal, action);
        }));
        await ready.promise;
        await lock('SELECT id FROM model_usage_calls FOR UPDATE');
        for (let index = 0; index < dispatch.length; index++) {
            dispatch[index].release();
            await within((async () => {
                const deadline = performance.now() + 1400;
                while (performance.now() < deadline) {
                    const result = await observer.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='neurocenter:model-usage' AND wait_event_type='Lock'");
                    if (result.rows[0].count === index + 1) return;
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                throw new Error('Expected real PostgreSQL metadata lock waits');
            })(), 1500);
        }
        const independent = vi.fn(async () => answer);
        const begin = service.repository.begin.bind(service.repository), beginErrors: { code: string | null; message: string }[] = [];
        vi.spyOn(service.repository, 'begin').mockImplementation(async value => {
            try { await begin(value); } catch (error) { beginErrors.push({ code: (error as { code?: string }).code ?? null, message: (error as Error).message }); throw error; }
        });
        const independentCall = observe(independent); expect(service.pool.waitingCount).toBe(1);
        const independentOutcome = await within(independentCall).catch(error => ({ error: error.message, beginErrors, timeline }));
        expect(independentOutcome).toBe(answer);
        await expect(within(Promise.all(active))).resolves.toEqual(actions.map(() => answer));
        expect(independent).toHaveBeenCalledOnce(); for (const action of actions) expect(action).toHaveBeenCalledOnce();
        const independentId = vi.mocked(service.repository.begin).mock.calls[0][0].id;
        expect(['pending', 'success']).toContain((await observer.query('SELECT status FROM model_usage_calls WHERE id=$1', [independentId])).rows[0].status);
        await unlock(); await flush(); await flush();
        expect((await observer.query('SELECT count(*)::integer AS count FROM model_usage_calls WHERE status=\'success\'')).rows[0].count).toBe(6);
        expect(service.pool.waitingCount).toBe(0);
        clearTrace();
    });

    it('fails closed before paid work when the initial durable reservation cannot acquire its table lock', async () => {
        await lock('LOCK TABLE model_usage_calls IN ACCESS EXCLUSIVE MODE');
        const action = vi.fn(async () => answer);
        await expect(within(observe(action))).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(action).not.toHaveBeenCalled();
        expect((await service.pool.query('SELECT 1 AS available')).rows[0].available).toBe(1);
        await unlock(); expect((await observer.query('SELECT count(*)::integer AS count FROM model_usage_calls')).rows[0].count).toBe(0);
    });

    it('returns a remote answer while a health row is locked, destroys only its waiting client, and retains fresh pin checks', async () => {
        const remote = new RemoteConnectionService({ pool: remotePool } as ModelsService);
        const infer = vi.spyOn(RemoteModelClient.prototype, 'infer').mockResolvedValue(answer);
        const healthPid = (await remotePool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const keeper = await lock('SELECT model_id FROM model_remote_connections WHERE model_id=$1 FOR UPDATE', [model.id]);
        const keeperPid = (await keeper.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const result = remote.infer(model, 'chat', {}); pending.push(result.catch(() => undefined));
        await expect(within(result, 1400)).resolves.toBe(answer);
        expect(infer).toHaveBeenCalledOnce();
        const replacementPid = (await within(remotePool.query('SELECT pg_backend_pid() AS pid'), 1000)).rows[0].pid;
        expect(replacementPid).not.toBe(healthPid);
        expect((await keeper.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(keeperPid);
        expect((await observer.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid=$1 AND state='active'", [healthPid])).rows[0].count).toBe(0);
        expect((await observer.query('SELECT failure_message FROM model_remote_connections WHERE model_id=$1', [model.id])).rows[0].failure_message).toBe('stale health error');
    });

    it('returns an expired diagnostic checkout unused and never writes its stale health update later', async () => {
        const remote = new RemoteConnectionService({ pool: remotePool } as ModelsService);
        const row = (await observer.query<IRemoteConnectionRow>('SELECT * FROM model_remote_connections WHERE model_id=$1', [model.id])).rows[0];
        const keeper = await remotePool.connect();
        try {
            const result = remote.repository.failure(row, null); pending.push(result.catch(() => undefined));
            await expect(within(result, 850)).rejects.toThrow();
            expect((await keeper.query('SELECT 1 AS kept')).rows[0].kept).toBe(1);
        } finally { keeper.release(); }
        await within(remotePool.query('SELECT 1'), 1000);
        expect(remotePool.waitingCount).toBe(0);
        expect((await observer.query('SELECT failure_message FROM model_remote_connections WHERE model_id=$1', [model.id])).rows[0].failure_message).toBe('stale health error');
    });

    it.each(['renew', 'interrupt'] as const)('does not let a locked receipt prevent %s for healthy owned rows', async mode => {
        const blocked = randomUUID(), healthy = randomUUID(), foreign = randomUUID(), otherWorker = randomUUID();
        for (const [id, workerId] of [[blocked, service.workerId], [healthy, service.workerId], [foreign, otherWorker]])
            await service.repository.begin({ id, workerId, model, endpoint: 'chat', purpose: 'direct' });
        await observer.query("UPDATE model_usage_calls SET lease_until=now()+interval '20 seconds'");
        const before = (await observer.query('SELECT id,lease_until FROM model_usage_calls ORDER BY id')).rows;
        await lock('SELECT id FROM model_usage_calls WHERE id=$1 FOR UPDATE', [blocked]);
        await expect(within(service.repository[mode](service.workerId), 1200)).resolves.toBeUndefined();
        const after = (await observer.query('SELECT id,status,lease_until FROM model_usage_calls ORDER BY id')).rows;
        if (mode === 'renew') expect(after.find(row => row.id === healthy).lease_until.getTime()).toBeGreaterThan(Date.now() + 100000);
        else expect(after.find(row => row.id === healthy).status).toBe('interrupted');
        for (const id of [blocked, foreign]) {
            expect(after.find(row => row.id === id).lease_until).toEqual(before.find(row => row.id === id).lease_until);
            expect(after.find(row => row.id === id).status).toBe('pending');
        }
    });

    it('recovers unlocked expired receipts while a different expired receipt remains locked and preserves live leases', async () => {
        const blocked = randomUUID(), expired = randomUUID(), live = randomUUID();
        for (const id of [blocked, expired, live]) await service.repository.begin({ id, workerId: randomUUID(), model, endpoint: 'chat', purpose: 'direct' });
        await observer.query("UPDATE model_usage_calls SET lease_until=now()-interval '1 second' WHERE id=ANY($1::uuid[])", [[blocked, expired]]);
        await lock('SELECT id FROM model_usage_calls WHERE id=$1 FOR UPDATE', [blocked]);
        await expect(within(service.repository.recover(), 1200)).resolves.toBeUndefined();
        const rows = (await observer.query('SELECT id,status FROM model_usage_calls')).rows;
        expect(rows.find(row => row.id === expired).status).toBe('interrupted');
        expect(rows.find(row => row.id === blocked).status).toBe('pending'); expect(rows.find(row => row.id === live).status).toBe('pending');
        await unlock(); await service.repository.recover();
        expect((await observer.query('SELECT status FROM model_usage_calls WHERE id=$1', [blocked])).rows[0].status).toBe('interrupted');
    });

    it('commits a healthy diagnostic write and returns a client without leaking local timeout settings', async () => {
        const remote = new RemoteConnectionService({ pool: remotePool } as ModelsService);
        const row = (await observer.query<IRemoteConnectionRow>('SELECT * FROM model_remote_connections WHERE model_id=$1', [model.id])).rows[0];
        const pid = (await remotePool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await remote.repository.failure(row, null);
        const settings = (await remotePool.query("SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock")).rows[0];
        expect(settings).toEqual({ pid, statement: '0', lock: '0' });
        expect((await observer.query('SELECT failure_message FROM model_remote_connections WHERE model_id=$1', [model.id])).rows[0].failure_message).toBeNull();
    });

    it.each([0, 1, 5])('shutdown drains six known outcomes with %s early locked receipts and never replays providers', async blockedCount => {
        const second = new ModelUsageService({ ready: async () => undefined } as unknown as ModelsService);
        await second.onModuleInit();
        const action = vi.fn(async () => answer), finish = vi.spyOn(second.repository, 'finish').mockRejectedValue(new Error('Temporary receipt write failure'));
        let closed = false;
        try {
            for (let index = 0; index < 6; index++) await second.observe(model, 'chat', action);
            const ids = finish.mock.calls.map(args => args[0]); finish.mockRestore();
            const blocked = ids.slice(0, blockedCount);
            if (blocked.length) await lock('SELECT id FROM model_usage_calls WHERE id=ANY($1::uuid[]) FOR UPDATE', [blocked]);
            await within(second.onApplicationShutdown(), 8500); closed = true;
            const rows = (await observer.query('SELECT id,status FROM model_usage_calls WHERE worker_id=$1', [second.workerId])).rows;
            expect(rows).toHaveLength(6);
            for (const row of rows) expect(row.status).toBe(blocked.includes(row.id) ? 'pending' : 'success');
            expect(action).toHaveBeenCalledTimes(6);
        } finally { finish.mockRestore(); if (!closed) await second.onApplicationShutdown(); }
    }, 15000);
});
