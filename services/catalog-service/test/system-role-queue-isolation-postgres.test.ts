import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SystemRoleRepository } from '../src/system-roles/system-role.repository';
import type { RoleRunRow } from '../src/system-roles/system-role.types';
import { barrier, systemRoleQueueFixture } from './system-role-queue-isolation.fixture';

vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: vi.fn(async () => undefined) }));
vi.mock('../src/system-roles/system-role.operations', async original => ({ ...await original<object>(), notifyRoleOperations: vi.fn(async () => undefined) }));
const connection = process.env.SYSTEM_ROLE_QUEUE_TEST_ADMIN_URL;

describe.skipIf(!connection)('System-role transport queues on caller-owned PostgreSQL', () => {
    let f: Awaited<ReturnType<typeof systemRoleQueueFixture>>;
    beforeAll(async () => { f = await systemRoleQueueFixture(connection!); });
    afterAll(async () => { await f?.close(); });
    afterEach(async () => {
        if (!f) return;
        await f.idle();
        await f.pool.query('DELETE FROM system_role_runs'); await f.pool.query("DELETE FROM operations WHERE resource_type='system-role'");
        f.started.length = 0; f.peaks.server = 0; f.peaks.device = 0; f.peaks.total = 0;
    });
    const started = async (id: string) => vi.waitFor(() => expect(f.started.some(row => row.id === id)).toBe(true), { timeout: 1000, interval: 10 });
    const state = async (id: string, expected: string) => vi.waitFor(async () => expect((await f.service.repository.get(id))?.state).toBe(expected), { timeout: 1000, interval: 10 });
    const queued = async (actor: string, runtime: 'ollama' | 'device-codex' = 'ollama', owner = f.service.repository) => {
        const request = f.input(runtime);
        return owner.create({ agent_id: 'agent-ai-admin', project_id: null, actor, actor_role: 'Главный админ', request_id: request.requestId,
            request_hash: 'a'.repeat(64), request, snapshot: { selection: request, definitionPin: request.expectedDefinitionPin,
                consentDigest: request.consentDigest, preview: 'Controlled context', targets: [] },
            model: { id: request.modelId, runtime } as RoleRunRow['model'] }, async () => undefined);
    };

    it('finishes a server role behind two device jobs while the first device request is held', async () => {
        const held = f.hold('held-device@example.test');
        try {
            const device = await f.start('held-device@example.test', 'device-codex'); await started(device.id);
            const secondDevice = await f.start('second-device@example.test', 'device-codex');
            const server = await f.start('server@example.test');
            await state(server.id, 'succeeded');
            expect((await f.service.repository.get(device.id))?.state).toBe('running');
            expect((await f.service.repository.get(secondDevice.id))?.state).toBe('queued');
            expect(f.peaks).toEqual({ server: 1, device: 1, total: 2 });
            held.resolve(); await state(secondDevice.id, 'succeeded');
            expect(f.peaks.device).toBe(1);
        } finally { held.resolve(); }
    });

    it('keeps server requests serialized while a device role runs independently', async () => {
        const held = f.hold('held-server@example.test');
        try {
            const server = await f.start('held-server@example.test'); await started(server.id);
            const secondServer = await f.start('second-server@example.test', 'remote-openai');
            const device = await f.start('independent-device@example.test', 'device-codex');
            await state(device.id, 'succeeded');
            expect((await f.service.repository.get(secondServer.id))?.state).toBe('queued');
            expect(f.peaks).toEqual({ server: 1, device: 1, total: 2 });
            held.resolve(); await state(secondServer.id, 'succeeded');
            expect(f.peaks.server).toBe(1);
        } finally { held.resolve(); }
    });

    it('cancelling one device job releases its lane without cancelling or overbooking the server lane', async () => {
        const deviceHeld = f.hold('cancel-device@example.test'), serverHeld = f.hold('keep-server@example.test');
        try {
            const device = await f.start('cancel-device@example.test', 'device-codex'); await started(device.id);
            const server = await f.start('keep-server@example.test'); await started(server.id);
            const nextDevice = await f.start('next-device@example.test', 'device-codex');
            const nextServer = await f.start('next-server@example.test');
            expect(await f.cancel(device)).toMatchObject({ state: 'cancelled' });
            await state(nextDevice.id, 'succeeded');
            expect((await f.service.repository.get(server.id))?.state).toBe('running');
            expect((await f.service.repository.get(nextServer.id))?.state).toBe('queued');
            expect(f.peaks).toEqual({ server: 1, device: 1, total: 2 });
            serverHeld.resolve(); await state(nextServer.id, 'succeeded');
        } finally { deviceHeld.resolve(); serverHeld.resolve(); }
    });

    it('a failed device request wakes its next queued request without repeating the failed work', async () => {
        const held = f.hold('failed-device@example.test');
        try {
            const failed = await f.start('failed-device@example.test', 'device-codex'); await started(failed.id);
            const next = await f.start('after-failure@example.test', 'device-codex');
            held.reject(new Error('Controlled device unavailable.'));
            await state(failed.id, 'failed'); await state(next.id, 'succeeded');
            expect(f.started.filter(row => row.id === failed.id)).toHaveLength(1);
            expect(f.peaks.device).toBe(1);
        } finally { held.resolve(); }
    });

    it('retains start and completion wakes while the other lane’s empty SQL result is pending', async () => {
        const held = f.hold('wake-device@example.test'), blocked = barrier(), release = barrier();
        const claim = f.service.repository.claim.bind(f.service.repository);
        let block = true;
        const spy = vi.spyOn(f.service.repository, 'claim').mockImplementation(async lanes => {
            const selected = await claim(lanes);
            if (block && !selected && lanes?.length === 1 && lanes[0] === 'server') { block = false; blocked.resolve(); await release.promise; }
            return selected;
        });
        try {
            const first = await f.start('wake-device@example.test', 'device-codex'); await started(first.id);
            await blocked.promise;
            const next = await f.start('wake-next@example.test', 'device-codex');
            held.resolve(); await state(first.id, 'succeeded');
            await new Promise<void>(resolve => setImmediate(resolve));
            release.resolve(); await state(next.id, 'succeeded');
            expect(f.started.map(row => row.id)).toEqual([first.id, next.id]);
            expect(f.peaks.device).toBe(1);
        } finally { held.resolve(); release.resolve(); spy.mockRestore(); }
    });

    it('filters the free lane before LIMIT and never claims expired or another instance’s accepted work', async () => {
        const foreign = await queued('foreign@example.test', 'ollama', new SystemRoleRepository(f.pool));
        const accepted = await queued('expired@example.test'), expiredId = randomUUID();
        // A previously accepted queued intent may already be expired before this scheduler starts.
        await f.pool.query(`INSERT INTO system_role_runs SELECT (jsonb_populate_record(NULL::system_role_runs,
            to_jsonb(source)||jsonb_build_object('id',$2::text,'request_id',$2::text,'lease_until',now()-interval '1 second'))).*
            FROM system_role_runs source WHERE id=$1`, [accepted.id, expiredId]);
        await f.pool.query('DELETE FROM system_role_runs WHERE id=$1', [accepted.id]);
        const device = await queued('claim-device@example.test', 'device-codex'), server = await queued('claim-server@example.test');
        const claim = f.service.repository.claim.bind(f.service.repository) as (lanes: string[]) => Promise<RoleRunRow | null>;
        expect((await claim(['server']))?.id).toBe(server.id);
        expect((await claim(['device-codex']))?.id).toBe(device.id);
        expect(await claim(['server', 'device-codex'])).toBeNull();
        await f.service.repository.expire();
        expect((await f.service.repository.get(foreign.id))?.state).toBe('queued');
        expect((await f.service.repository.get(expiredId))?.state).toBe('interrupted');
        expect(f.started).toHaveLength(0);
    });

    it('retains the global eight-pending-intent quota across both transports', async () => {
        for (let index = 0; index < 8; index++) await queued('quota-' + index + '@example.test', index % 2 ? 'device-codex' : 'ollama');
        await expect(queued('over-quota@example.test')).rejects.toThrow('заняты');
        expect((await f.pool.query('SELECT count(*) FROM system_role_runs')).rows[0].count).toBe('8');
    });

    it('shutdown waits for an in-flight SQL claim and interrupts it before model execution', async () => {
        const isolated = await systemRoleQueueFixture(connection!), selected = barrier(), release = barrier();
        const claim = isolated.service.repository.claim.bind(isolated.service.repository);
        vi.spyOn(isolated.service.repository, 'claim').mockImplementation(async lanes => {
            const row = await claim(lanes); selected.resolve(); await release.promise; return row;
        });
        try {
            const accepted = await isolated.start('shutdown-claim@example.test'); await selected.promise;
            let settled = false;
            const shutdown = isolated.service.onApplicationShutdown().then(() => { settled = true; });
            await Promise.resolve(); expect(settled).toBe(false); expect(isolated.started).toHaveLength(0);
            release.resolve(); await shutdown;
            expect((await isolated.service.repository.get(accepted.id))?.state).toBe('interrupted');
            expect(isolated.started).toHaveLength(0);
        } finally { release.resolve(); await isolated.close(); }
    });

    it('shutdown aborts and awaits both tracked runners without starting queued work', async () => {
        const deviceHeld = f.hold('shutdown-device@example.test', true), serverHeld = f.hold('shutdown-server@example.test', true);
        try {
            const device = await f.start('shutdown-device@example.test', 'device-codex'); await started(device.id);
            const server = await f.start('shutdown-server@example.test'); await started(server.id);
            const queuedDevice = await f.start('shutdown-queued@example.test', 'device-codex');
            let settled = false;
            const shutdown = Promise.resolve(f.service.onApplicationShutdown()).then(() => { settled = true; });
            await Promise.all([deviceHeld.aborted, serverHeld.aborted]);
            await Promise.resolve(); expect(settled).toBe(false);
            deviceHeld.settle(); serverHeld.settle(); await shutdown;
            expect(f.running.size).toBe(0);
            expect(f.started.map(row => row.id)).toEqual([device.id, server.id]);
            expect((await f.service.repository.get(queuedDevice.id))?.state).toBe('queued');
        } finally { deviceHeld.resolve(); serverHeld.resolve(); deviceHeld.settle(); serverHeld.settle(); }
    });
});
