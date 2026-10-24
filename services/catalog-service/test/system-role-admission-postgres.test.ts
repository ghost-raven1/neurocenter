import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { projectRoleOperation } from '../src/system-roles/system-role.operations';
import { SystemRoleRepository } from '../src/system-roles/system-role.repository';
import type { RoleRunRow } from '../src/system-roles/system-role.types';

const connection = process.env.SYSTEM_ROLE_QUEUE_TEST_ADMIN_URL;
type Runtime = 'device-codex' | 'ollama' | 'remote-openai';
type Input = Parameters<SystemRoleRepository['create']>[0];
type Authorize = Parameters<SystemRoleRepository['create']>[1];
const allowed: Authorize = async () => undefined;

describe.skipIf(!connection)('System-role admission reserves both transports on caller-owned PostgreSQL', () => {
    let pool: Pool, admin: Pool, database: string, repository: SystemRoleRepository;
    beforeAll(async () => {
        const url = ownedTestPostgresAdmin(connection); admin = new Pool({ connectionString: url.href, max: 1 });
        database = 'nc_role_admission_' + randomUUID().replaceAll('-', '');
        await admin.query('CREATE DATABASE ' + database); url.pathname = '/' + database;
        pool = new Pool({ connectionString: url.href, max: 4 });
        await ensureCatalogSchema(pool); repository = new SystemRoleRepository(pool);
    });
    afterEach(async () => {
        if (!pool) return;
        await pool.query('DELETE FROM system_role_runs');
        await pool.query("DELETE FROM operations WHERE resource_type='system-role'");
    });
    afterAll(async () => {
        if (pool) await pool.end();
        if (admin) { try { if (database) await admin.query('DROP DATABASE IF EXISTS ' + database); } finally { await admin.end(); } }
    });
    const input = (runtime: Runtime, actor = randomUUID() + '@example.test'): Input => {
        const requestId = randomUUID();
        return { agent_id: 'agent-ai-admin', project_id: null, actor, actor_role: 'Главный админ', request_id: requestId,
            request_hash: 'a'.repeat(64), request: { requestId } as Input['request'],
            snapshot: { targets: [], selection: {} } as Input['snapshot'], model: { id: 'model-' + runtime, runtime } as Input['model'] };
    };
    const create = (runtime: Runtime, actor?: string) => repository.create(input(runtime, actor), allowed);
    const fill = async (count: number, runtime: Runtime) => {
        const rows: RoleRunRow[] = [];
        for (let index = 0; index < count; index++) rows.push(await create(runtime));
        return rows;
    };
    const journal = async () => ({
        runs: (await pool.query('SELECT * FROM system_role_runs ORDER BY id')).rows,
        operations: (await pool.query("SELECT * FROM operations WHERE resource_type='system-role' ORDER BY operation_id")).rows,
    });
    /** Both requests pass authorization before either competes for the real PostgreSQL admission lock. */
    const racingAdmissions = async (runtimes: readonly Runtime[]) => {
        let ready = 0, release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const authorize: Authorize = async () => { if (++ready === runtimes.length) release(); await gate; };
        return Promise.allSettled(runtimes.map(runtime => new SystemRoleRepository(pool).create(input(runtime), authorize)));
    };

    it.each([
        ['device-codex', 'ollama'], ['ollama', 'device-codex'],
    ] as const)('seven %s intents retain one slot for %s without increasing the total quota', async (blocked, independent) => {
        await fill(7, blocked);
        const before = await journal();
        await expect(create(blocked)).rejects.toThrow('заняты');
        expect(await journal()).toEqual(before);
        expect(await create(independent)).toMatchObject({ state: 'queued', model: { runtime: independent } });
        const full = await journal();
        await expect(create(blocked)).rejects.toThrow('заняты');
        await expect(create(independent)).rejects.toThrow('заняты');
        expect(await journal()).toEqual(full);
        expect(full.runs).toHaveLength(8); expect(full.operations).toHaveLength(8);
    });

    it('treats local Ollama and remote OpenAI as the same server lane', async () => {
        await fill(4, 'ollama'); await fill(3, 'remote-openai');
        await expect(create('remote-openai')).rejects.toThrow('заняты');
        await expect(create('ollama')).rejects.toThrow('заняты');
        await expect(create('device-codex')).resolves.toMatchObject({ state: 'queued' });
    });

    it('keeps legacy models without a runtime in the server lane used by the scheduler', async () => {
        await fill(6, 'ollama');
        await repository.create({ ...input('ollama'), model: {} as Input['model'] }, allowed);
        await expect(create('remote-openai')).rejects.toThrow('заняты');
        await expect(create('device-codex')).resolves.toMatchObject({ state: 'queued' });
    });

    it.each(['device-codex', 'ollama'] as const)('serializes concurrent requests for the seventh %s slot', async runtime => {
        await fill(6, runtime);
        const outcomes = await racingAdmissions([runtime, runtime]);
        expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
        const stored = await journal(); expect(stored.runs).toHaveLength(7); expect(stored.operations).toHaveLength(7);
        await expect(create(runtime === 'device-codex' ? 'ollama' : 'device-codex')).resolves.toMatchObject({ state: 'queued' });
    });

    it('serializes different transports competing for the last global slot', async () => {
        await fill(4, 'device-codex'); await fill(3, 'ollama');
        const outcomes = await racingAdmissions(['device-codex', 'remote-openai']);
        expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
        const stored = await journal(); expect(stored.runs).toHaveLength(8); expect(stored.operations).toHaveLength(8);
    });

    it('counts queued, running and applying work without evicting accepted rows', async () => {
        const rows = await fill(7, 'device-codex');
        await repository.transaction(async db => {
            const running = await repository.change(db, rows[0], 'running', 'collecting', 'Controlled running request.');
            expect(running.state).toBe('running');
            let applying = await repository.change(db, rows[1], 'running', 'collecting', 'Controlled running request.');
            applying = await repository.change(db, applying, 'awaiting_review', 'awaiting_review', 'Controlled proposal.');
            await repository.change(db, applying, 'applying', 'applying', 'Controlled application.');
        });
        const before = await journal();
        await expect(create('device-codex')).rejects.toThrow('заняты');
        expect(await journal()).toEqual(before);
        await expect(create('ollama')).resolves.toMatchObject({ state: 'queued' });
    });

    it('returns an identical accepted request at full capacity without changing its journal or deadline', async () => {
        const accepted = input('device-codex'), original = await repository.create(accepted, allowed);
        await fill(6, 'device-codex'); await create('ollama');
        const authorize = vi.fn(allowed), before = await journal();
        expect(await repository.create(accepted, authorize)).toEqual(original);
        expect(authorize).toHaveBeenCalledOnce();
        await expect(repository.create({ ...accepted, request_hash: 'b'.repeat(64) }, allowed)).rejects.toThrow('другому запуску');
        expect(await journal()).toEqual(before);
    });

    it('checks authority and same-actor role exclusivity before admission without writing a refusal', async () => {
        const actor = 'exclusive@example.test'; await create('device-codex', actor); await fill(6, 'device-codex');
        const before = await journal();
        await expect(create('ollama', actor)).rejects.toThrow('предыдущий запуск');
        await expect(repository.create(input('ollama'), async () => { throw new ForbiddenException('Controlled revoked access.'); }))
            .rejects.toThrow('Controlled revoked access.');
        expect(await journal()).toEqual(before);
    });

    it('preserves eight previously accepted same-lane rows and their idempotent receipts until explicit settlement', async () => {
        const rows = await fill(7, 'device-codex'), legacy = input('device-codex');
        // The old admission policy could accept an eighth same-lane intent. Upgrade must retain it as accepted.
        await repository.transaction(async db => {
            const row = (await db.query<RoleRunRow>(`INSERT INTO system_role_runs SELECT (jsonb_populate_record(NULL::system_role_runs,
                to_jsonb(source)||jsonb_build_object('id',$2::text,'actor',$3::text,'request_id',$4::text,'request',$5::jsonb))).*
                FROM system_role_runs source WHERE id=$1 RETURNING *`,
            [rows[0].id, randomUUID(), legacy.actor, legacy.request_id, JSON.stringify(legacy.request)])).rows[0];
            await projectRoleOperation(db, row);
        });
        const before = await journal();
        await expect(repository.create(legacy, allowed)).resolves.toMatchObject({ actor: legacy.actor, state: 'queued' });
        await expect(create('ollama')).rejects.toThrow('заняты');
        await expect(create('device-codex')).rejects.toThrow('заняты');
        expect(await journal()).toEqual(before);
        await repository.transaction(async db => {
            await repository.change(db, rows[0], 'cancelled', 'cancelled', 'Explicit test cancellation.');
        });
        await expect(create('ollama')).resolves.toMatchObject({ state: 'queued' });
        expect((await journal()).runs.filter(row => row.state === 'queued')).toHaveLength(8);
    });
});
