import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { ensureCatalogSchema, checkCatalogSchema } from '../src/database/catalog-schema';
import { migrateCatalog } from '../src/database/migrations';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { SystemRoleRepository } from '../src/system-roles/system-role.repository';
import type { RoleRunRow } from '../src/system-roles/system-role.types';
import { OperationRepository } from '../src/operations/operation-repository';
import { assertSystemRoleSchema } from '../src/system-roles/system-role.schema-verification';
const connection = process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!connection)('System role durable owner on caller-owned PostgreSQL', () => {
    let pool: Pool, admin: Pool, database: string, repository: SystemRoleRepository;
    beforeAll(async () => {
        const url = ownedTestPostgresAdmin(connection); admin = new Pool({ connectionString: url.href, max: 1 });
        database = 'nc_system_role_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; pool = new Pool({ connectionString: url.href, max: 4 });
        await migrateCatalog(pool, CATALOG_MIGRATIONS.filter(migration => migration.version <= 27));
        const old = (await pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows;
        await ensureCatalogSchema(pool); expect((await pool.query('SELECT * FROM catalog_schema_migrations WHERE version<=27 ORDER BY version')).rows).toEqual(old);
        expect((await checkCatalogSchema(pool, true)).ready).toBe(true); repository = new SystemRoleRepository(pool);
    });
    afterEach(async () => { if (pool) { await pool.query('DELETE FROM system_role_runs'); await pool.query("DELETE FROM operations WHERE resource_type='system-role'"); } });
    afterAll(async () => { if (pool) await pool.end(); if (admin) { try { if (database) await admin.query('DROP DATABASE IF EXISTS ' + database); } finally { await admin.end(); } } });
    const create = async (owner = repository, requestId = randomUUID()) => owner.create({ agent_id: 'agent-ai-admin', project_id: null, actor: 'qa@example.test', actor_role: 'Главный админ',
        request_id: requestId, request_hash: 'a'.repeat(64), request: { privatePrompt: 'private source' } as never, snapshot: { targets: [], selection: {} } as never, model: {} as never }, async () => undefined);
    it('preserves pre-28 history and creates one row/operation for concurrent identical intent', async () => {
        const key = randomUUID(), [first, second] = await Promise.all([create(repository, key), create(repository, key)]);
        expect(first.id).toBe(second.id); expect((await pool.query('SELECT * FROM system_role_runs')).rows).toHaveLength(1);
        expect((await pool.query("SELECT * FROM operations WHERE resource_type='system-role'")).rows).toHaveLength(1);
    });
    it('claims only explicitly started work from the current process, never another process after restart', async () => {
        const old = new SystemRoleRepository(pool); await create(old);
        expect(await repository.claim()).toBeNull(); const row = await old.claim(); expect(row?.state).toBe('running');
        expect(await new SystemRoleRepository(pool).claim()).toBeNull();
    });
    it('fences wrong generation, cancellation and expired leases before reserving model work', async () => {
        const original = await create(), row = (await repository.claim())!;
        await expect(repository.reserveCall(row.id, randomUUID(), async () => undefined)).rejects.toThrow('lease');
        await repository.reserveCall(row.id, row.lease_token, async () => undefined);
        await repository.reserveCall(row.id, row.lease_token, async () => undefined);
        await expect(repository.reserveCall(row.id, row.lease_token, async () => undefined)).rejects.toThrow('lease');
        await repository.transaction(async db => { const current = (await repository.get(row.id, db, true))!; await repository.change(db, current, 'cancelled', 'cancelled', 'Отменено пользователем.'); });
        await expect(repository.reserveCall(row.id, row.lease_token, async () => undefined)).rejects.toThrow('lease');
        expect((await repository.get(original.id))?.calls_started).toBe(2);
    });
    it('expires interrupted work without replay and preserves safe operations independently of private proposal', async () => {
        const source = await create(); await pool.query("UPDATE system_role_runs SET state='running',phase='collecting',revision=revision+1,lease_until=now()-interval '1 second' WHERE id=$1", [source.id]);
        await repository.expire(); expect((await repository.get(source.id))?.state).toBe('interrupted'); expect(await repository.claim()).toBeNull();
        const operation = (await pool.query('SELECT * FROM operations WHERE resource_id=$1', [source.id])).rows[0];
        expect(operation.state).toBe('FAILED'); expect(JSON.stringify(operation)).not.toContain('private source');
    });
    it('enforces source/call/result immutability and atomically projects awaiting review', async () => {
        const original = await create(), row = (await repository.claim())!;
        await expect(pool.query("UPDATE system_role_runs SET actor='other@example.test',revision=revision+1 WHERE id=$1", [row.id])).rejects.toThrow('immutable');
        await expect(pool.query('UPDATE system_role_runs SET calls_started=3,revision=revision+1 WHERE id=$1', [row.id])).rejects.toThrow();
        const result = { kind: 'proposal', summary: 'private recommendation', findings: [], nextSteps: [], changes: [] } as const;
        await repository.fenced(row.id, row.lease_token, (db, current) => repository.change(db, current, 'awaiting_review', 'awaiting_review', 'Предложение ожидает проверки.', { result: result as unknown as RoleRunRow['result'] }));
        await expect(pool.query("UPDATE system_role_runs SET result='{}',revision=revision+1 WHERE id=$1", [row.id])).rejects.toThrow('immutable');
        const operation = (await pool.query('SELECT * FROM operations WHERE operation_id=$1', ['system-role-' + original.id])).rows[0];
        expect(operation).toMatchObject({ state: 'RUNNING', percent: 80, resource_type: 'system-role', resource_id: row.id });
        expect(JSON.stringify(operation)).not.toContain('private recommendation'); expect((await repository.get(row.id))?.lease_until).toBeNull();
    });
    it('adds only own global system-role summaries and never widens revoked-project or unrelated platform visibility', async () => {
        const row = await create(), operations = new OperationRepository(pool), scope = { actor: row.actor, projectIds: [] };
        expect(await operations.get('system-role-' + row.id, scope)).toMatchObject({ resourceType: 'system-role', systemRole: { agentId: 'agent-ai-admin', phase: 'queued' } });
        expect(await operations.get('system-role-' + row.id, { actor: 'other@example.test', projectIds: [] })).toBeNull();
        await pool.query("INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,log) VALUES('unrelated','MODEL',NULL,'model','model-one',$1,'SUCCEEDED',100,'[]'),('revoked-project','MODEL','prj-revoked','system-role',$2,$1,'SUCCEEDED',100,'[]')", [row.actor, row.id]);
        expect(await operations.get('unrelated', scope)).toBeNull(); expect(await operations.get('revoked-project', scope)).toBeNull();
        await pool.query("DELETE FROM operations WHERE operation_id IN ('unrelated','revoked-project')");
    });
    it.each([
        'ALTER TABLE system_role_runs DISABLE TRIGGER system_role_run_guard',
        'ALTER TABLE system_role_runs DROP CONSTRAINT system_role_runs_calls_started_check',
        'DROP INDEX system_role_pending_runner',
        'ALTER TABLE project_snapshot_verifiers DROP CONSTRAINT project_snapshot_verifiers_container_observation_check',
        'CREATE OR REPLACE FUNCTION system_role_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    ])('rejects physical role or container observation drift: %s', async sql => {
        const db = await pool.connect(); await db.query('BEGIN');
        try { await db.query(sql); await expect(assertSystemRoleSchema(db as never)).rejects.toThrow('не готова'); }
        finally { await db.query('ROLLBACK'); db.release(); }
        await expect(assertSystemRoleSchema(pool)).resolves.toBeUndefined();
    });
});
