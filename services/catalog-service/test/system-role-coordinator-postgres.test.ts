import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { catalogMigrationHistory, migrateCatalog } from '../src/database/migrations';
import { checkCatalogSchema, ensureCatalogSchema } from '../src/database/catalog-schema';
import { SystemRoleRepository } from '../src/system-roles/system-role.repository';
import { assertSystemRoleSchema } from '../src/system-roles/system-role.schema-verification';
import type { SystemRoleId } from '../src/system-roles/system-role.types';
import { OperationRepository } from '../src/operations/operation-repository';

const connection = process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!connection)('Coordinator migration and durable budget on caller-owned PostgreSQL', () => {
    let admin: Pool, pool: Pool, database: string, repository: SystemRoleRepository;
    beforeAll(async () => {
        const url = ownedTestPostgresAdmin(connection); admin = new Pool({ connectionString: url.href, max: 1 });
        database = 'nc_coordinator_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; pool = new Pool({ connectionString: url.href, max: 2 });
        await migrateCatalog(pool, CATALOG_MIGRATIONS.filter(item => item.version <= 32));
        const history = (await pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows;
        const oldRepository = new SystemRoleRepository(pool), old = await oldRepository.create({ agent_id: 'agent-ai-admin', actor: 'legacy@example.test', actor_role: 'Главный админ', project_id: null,
            request_id: randomUUID(), request_hash: 'b'.repeat(64), request: {} as never, snapshot: { selection: {}, targets: [] } as never, model: {} as never }, async () => undefined);
        await oldRepository.claim();
        await oldRepository.reserveCall(old.id, old.lease_token, async () => undefined); await oldRepository.reserveCall(old.id, old.lease_token, async () => undefined);
        await oldRepository.fenced(old.id, old.lease_token, (db, current) => oldRepository.change(db, current, 'cancelled', 'cancelled', 'Предыдущий запуск сохранён.'));
        const oldRuns = (await pool.query('SELECT * FROM system_role_runs ORDER BY id')).rows;
        await ensureCatalogSchema(pool);
        expect((await pool.query('SELECT * FROM catalog_schema_migrations WHERE version<=32 ORDER BY version')).rows).toEqual(history);
        expect((await pool.query('SELECT * FROM system_role_runs ORDER BY id')).rows).toEqual(oldRuns);
        repository = new SystemRoleRepository(pool);
    });
    afterAll(async () => { if (pool) await pool.end(); if (admin) { try { if (database) await admin.query('DROP DATABASE IF EXISTS ' + database); } finally { await admin.end(); } } });
    const create = (id: SystemRoleId) => repository.create({ agent_id: id, actor: 'qa@example.test', actor_role: 'Главный админ', project_id: null,
        request_id: randomUUID(), request_hash: 'a'.repeat(64), request: {} as never, snapshot: { selection: {}, targets: [] } as never, model: {} as never }, async () => undefined);
    it('upgrades schema32 without changing historical checksums and validates current physical constraints', async () => {
        expect(await checkCatalogSchema(pool, true)).toMatchObject({ ready: true, pending: [] });
        expect((await pool.query('SELECT name FROM catalog_schema_migrations WHERE version=33')).rows[0].name).toBe('bounded-system-role-coordinator');
        await expect(catalogMigrationHistory(pool, CATALOG_MIGRATIONS.filter(item => item.version <= 32))).rejects.toThrow('История миграций');
    });
    it.each([['agent-coordinator', 5], ['agent-ai-admin', 2]] as const)('reserves only the persisted %s budget of %i calls', async (id, budget) => {
        const source = await create(id), row = (await repository.claim())!; expect(row.id).toBe(source.id);
        expect(await new OperationRepository(pool).get('system-role-' + row.id, { actor: row.actor, projectIds: [] })).toMatchObject({ systemRole: { agentId: id, runId: row.id } });
        for (let count = 0; count < budget; count++) await repository.reserveCall(row.id, row.lease_token, async () => undefined);
        await expect(repository.reserveCall(row.id, row.lease_token, async () => undefined)).rejects.toThrow('lease');
        expect((await repository.get(row.id))?.calls_started).toBe(budget);
        await expect(pool.query("UPDATE system_role_runs SET calls_started=calls_started+1,phase='model_step',revision=revision+1 WHERE id=$1", [row.id])).rejects.toThrow();
        if (id === 'agent-coordinator') {
            const result = { kind: 'diagnosis', summary: 'Сохранён независимый ответ.', findings: [], changes: [], nextSteps: [],
                delegations: [{ roleId: 'agent-indexer', state: 'failed', message: 'Недоступен.' }, { roleId: 'agent-ai-admin', state: 'succeeded', result: { kind: 'diagnosis', summary: 'Ответ администратора.', findings: [], nextSteps: [], changes: [] } }] } as const;
            await repository.fenced(row.id, row.lease_token, (db, current) => repository.change(db, current, 'succeeded', 'completed', 'Ответы сохранены.', { result: result as never }));
            expect((await repository.get(row.id))?.result).toEqual(result);
        } else await repository.fenced(row.id, row.lease_token, (db, current) => repository.change(db, current, 'cancelled', 'cancelled', 'Отменено.'));
    });
    it('rejects a drifted coordinator allowance without accepting relaxed constraints as readiness', async () => {
        const db = await pool.connect(); await db.query('BEGIN');
        try {
            await db.query('ALTER TABLE system_role_runs DROP CONSTRAINT system_role_runs_calls_started_check');
            await db.query('ALTER TABLE system_role_runs ADD CONSTRAINT system_role_runs_calls_started_check CHECK(calls_started BETWEEN 0 AND 50)');
            await expect(assertSystemRoleSchema(db)).rejects.toThrow('не готова');
        } finally { await db.query('ROLLBACK'); db.release(); }
        await expect(assertSystemRoleSchema(pool)).resolves.toBeUndefined();
    });
});
