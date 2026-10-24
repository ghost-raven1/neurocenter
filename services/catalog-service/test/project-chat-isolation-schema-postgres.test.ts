import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { checkCatalogSchema, ensureCatalogSchema } from '../src/database/catalog-schema';
import { migrateCatalog } from '../src/database/migrations';
import { ProjectChatRepository } from '../src/project-chat/project-chat.repository';
import { DEFAULT_PROJECT_CHAT_ROOM } from '../src/project-chat/project-chat.types';
import { adminUrl, assertOwnedChatLearningDatabase } from './project-chat-learning-receipt.fixture';

const databases: Array<{ pool: Pool; admin: Pool; name: string }> = [];
const projectId = 'prj-isolation-schema', agentId = 'agent-isolation-schema';
const history = async (pool: Pool) => (await pool.query('SELECT version,name,checksum,applied_at FROM catalog_schema_migrations ORDER BY version')).rows;
const index = async (pool: Pool) => (await pool.query("SELECT pg_get_indexdef('project_chat_single_running'::regclass) AS definition")).rows[0].definition;
async function fixture() {
    assertOwnedChatLearningDatabase();
    const url = new URL(adminUrl!), admin = new Pool({ connectionString: url.href, max: 1 }), name = 'nc_team_isolation_schema_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE DATABASE ' + name); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: url.href, max: 2 }); databases.push({ pool, admin, name });
    await migrateCatalog(pool, CATALOG_MIGRATIONS.filter(migration => migration.version <= 31));
    return pool;
}
afterEach(async () => {
    for (const { pool, admin, name } of databases.splice(0)) { await pool.end(); await admin.query('DROP DATABASE ' + name); await admin.end(); }
});
async function rooms(pool: Pool) {
    const other = randomUUID(); await pool.query('INSERT INTO projects(id,name) VALUES($1,\'Isolation schema\')', [projectId]);
    await pool.query('INSERT INTO project_chat_rooms(project_id) VALUES($1)', [projectId]);
    await pool.query('INSERT INTO project_chat_rooms(project_id,id,creator_email,create_request_key,create_request_hash) VALUES($1,$2,\'owner@fixture.test\',$3,$4)', [projectId, other, randomUUID(), 'a'.repeat(64)]);
    return [DEFAULT_PROJECT_CHAT_ROOM, other];
}
async function question(pool: Pool, roomId: string, status = 'queued') {
    const id = randomUUID(), generation = randomUUID();
    await pool.query(`INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,generation,target_agent_ids,lease_until)
        VALUES($1,$2,$3,'user','Preserve question','owner@fixture.test','Owner','Разработчик',$4,$5,$6,$7,$8,CASE WHEN $4='running' THEN now()+interval '15 minutes' END)`, [id, projectId, roomId, status, randomUUID(), 'a'.repeat(64), generation, [agentId]]);
    await pool.query(`INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,source_message_id,status,snapshot,generation,lease_until)
        VALUES($1,$2,$3,'agent','',$4,$5,$6,$7,CASE WHEN $5='running' THEN now()+interval '15 minutes' END)`, [randomUUID(), projectId, roomId, id, status, { agentId }, generation]);
    return id;
}

describe.skipIf(!adminUrl).sequential('Room isolation migration32 — owned PostgreSQL', () => {
    it('preserves running questions and frozen history while allowing one running question in each room', async () => {
        const pool = await fixture(), [left, right] = await rooms(pool);
        const running = await question(pool, left, 'running'), queued = await question(pool, right);
        const oldHistory = await history(pool), before = (await pool.query('SELECT to_jsonb(m) AS row FROM project_chat_messages m ORDER BY position')).rows;
        expect((await checkCatalogSchema(pool)).pending).toEqual([32]); await ensureCatalogSchema(pool);
        expect((await history(pool)).filter(row => row.version <= 31)).toEqual(oldHistory);
        expect((await pool.query('SELECT to_jsonb(m) AS row FROM project_chat_messages m ORDER BY position')).rows).toEqual(before);
        const repository = new ProjectChatRepository(pool);
        const claimed = await repository.claim(projectId, right);
        expect(claimed?.source.id).toBe(queued); expect(await repository.claim(projectId, right)).toBeNull();
        expect((await pool.query("SELECT id FROM project_chat_messages WHERE kind='user' AND status='running' ORDER BY id")).rows.map(row => row.id).sort()).toEqual([running, queued].sort());
        await expect(question(pool, right, 'running')).rejects.toMatchObject({ constraint: 'project_chat_single_running' });
        expect((await checkCatalogSchema(pool, true)).ready).toBe(true);
    });

    it('rolls back failed migration32 without changing the old index or ledger, then retries safely', async () => {
        const pool = await fixture(), [left] = await rooms(pool); await question(pool, left, 'running');
        const oldHistory = await history(pool), oldIndex = await index(pool), before = (await pool.query('SELECT * FROM project_chat_messages ORDER BY position')).rows;
        const broken = CATALOG_MIGRATIONS.map(migration => migration.version === 32 ? { ...migration, sql: migration.sql + '; SELECT deliberately_missing_isolation_function()' } : migration);
        await expect(migrateCatalog(pool, broken)).rejects.toThrow();
        expect(await history(pool)).toEqual(oldHistory); expect(await index(pool)).toBe(oldIndex);
        expect((await pool.query('SELECT * FROM project_chat_messages ORDER BY position')).rows).toEqual(before);
        await ensureCatalogSchema(pool); expect((await checkCatalogSchema(pool, true)).ready).toBe(true);
        const upgraded = await history(pool); await ensureCatalogSchema(pool); expect(await history(pool)).toEqual(upgraded);
    });

    it.each([
        "DROP INDEX project_chat_single_running; CREATE UNIQUE INDEX project_chat_single_running ON project_chat_messages(project_id) WHERE kind='user' AND status='running'",
        "DROP INDEX project_chat_single_running; CREATE INDEX project_chat_single_running ON project_chat_messages(project_id,room_id) WHERE kind='user' AND status='running'",
        'DROP INDEX project_chat_single_running',
    ])('readiness rejects weakened room isolation: %s', async sql => {
        const pool = await fixture(); await ensureCatalogSchema(pool); await pool.query(sql);
        await expect(checkCatalogSchema(pool, true)).rejects.toThrow();
    });
});
