import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { checkCatalogSchema, ensureCatalogSchema } from '../src/database/catalog-schema';
import { migrateCatalog } from '../src/database/migrations';
import { adminUrl, assertOwnedChatLearningDatabase } from './project-chat-learning-receipt.fixture';

const databases: Array<{ pool: Pool; admin: Pool; name: string }> = [];
const projectId = 'prj-learning-schema', agentId = 'agent-receipt';
const receipt = { status: 'disabled', projectId, agentId, entries: [] };

/** Each upgrade/drift case owns one disposable database on the explicitly selected QA instance. */
async function fixture() {
    assertOwnedChatLearningDatabase();
    const url = new URL(adminUrl!), admin = new Pool({ connectionString: url.href, max: 1 });
    const name = 'nc_team_learning_schema_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE DATABASE ' + name); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: url.href, max: 2 }); databases.push({ pool, admin, name });
    await migrateCatalog(pool, CATALOG_MIGRATIONS.filter(migration => migration.version <= 30));
    return pool;
}
afterEach(async () => {
    for (const { pool, admin, name } of databases.splice(0)) {
        await pool.end(); await admin.query('DROP DATABASE ' + name); await admin.end();
    }
});
const history = async (pool: Pool) => (await pool.query('SELECT version,name,checksum,applied_at FROM catalog_schema_migrations ORDER BY version')).rows;
async function source(pool: Pool) {
    await pool.query('INSERT INTO projects(id,name) VALUES($1,\'Learning schema\')', [projectId]);
    await pool.query('INSERT INTO project_chat_rooms(project_id) VALUES($1)', [projectId]);
    const id = randomUUID();
    await pool.query(`INSERT INTO project_chat_messages(id,project_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,generation)
        VALUES($1,$2,'user','Question','owner@fixture.test','Owner','Разработчик','done',$3,$4,$5)`, [id, projectId, randomUUID(), 'a'.repeat(64), randomUUID()]);
    return id;
}
const answer = (pool: Pool, sourceId: string, learning?: unknown, status = 'done') => pool.query(`INSERT INTO project_chat_messages(id,project_id,kind,content,source_message_id,status,snapshot,generation${learning === undefined ? '' : ',learning'})
    VALUES($1,$2,'agent','Historical answer',$3,$4,$5,$6${learning === undefined ? '' : ',$7'}) RETURNING *`,
    [randomUUID(), projectId, sourceId, status, { agentId }, randomUUID(), ...(learning === undefined ? [] : [learning])]);

describe.skipIf(!adminUrl).sequential('Project chat learning migration31 — owned PostgreSQL', () => {
    it('preserves released history and old completed rows without fabricating learning provenance', async () => {
        const pool = await fixture(), sourceId = await source(pool), done = (await answer(pool, sourceId)).rows[0];
        const beforeHistory = await history(pool), beforeRows = (await pool.query('SELECT to_jsonb(m) AS row FROM project_chat_messages m ORDER BY position')).rows;
        expect((await checkCatalogSchema(pool)).pending).toEqual([31, 32]);
        await ensureCatalogSchema(pool);
        expect((await history(pool)).filter(row => row.version <= 30)).toEqual(beforeHistory);
        expect((await pool.query("SELECT to_jsonb(m)-'learning' AS row FROM project_chat_messages m ORDER BY position")).rows).toEqual(beforeRows);
        expect((await pool.query('SELECT learning FROM project_chat_messages')).rows).toEqual([{ learning: null }, { learning: null }]);
        await expect(pool.query('UPDATE project_chat_messages SET learning=$2 WHERE id=$1', [done.id, receipt])).rejects.toThrow('Project chat message attribution is immutable');
        expect((await checkCatalogSchema(pool, true)).ready).toBe(true);
        const upgradedHistory = await history(pool); await ensureCatalogSchema(pool); expect(await history(pool)).toEqual(upgradedHistory);
    });

    it('rejects receipts outside a completed answer and a matching project/agent identity', async () => {
        const pool = await fixture(), sourceId = await source(pool); await ensureCatalogSchema(pool);
        for (const invalid of [[], {}, { ...receipt, projectId: 'foreign' }, { ...receipt, agentId: 'other' },
            { ...receipt, status: 'invented' }, { ...receipt, entries: {} }, { status: 'disabled', projectId, agentId },
            { ...receipt, padding: 'x'.repeat(262144) }]) {
            await expect(answer(pool, sourceId, invalid)).rejects.toMatchObject({ constraint: 'project_chat_message_learning_check' });
        }
        await expect(answer(pool, sourceId, receipt, 'failed')).rejects.toMatchObject({ constraint: 'project_chat_message_learning_check' });
        await expect(pool.query('UPDATE project_chat_messages SET learning=$2 WHERE id=$1', [sourceId, receipt])).rejects.toMatchObject({ constraint: 'project_chat_message_learning_check' });
        const stored = (await answer(pool, sourceId, receipt)).rows[0]; expect(stored.learning).toEqual(receipt);
        await expect(pool.query('UPDATE project_chat_messages SET learning=NULL WHERE id=$1', [stored.id])).rejects.toThrow('Project chat message attribution is immutable');
    });

    it.each([
        'ALTER TABLE project_chat_messages ALTER COLUMN learning SET NOT NULL',
        'ALTER TABLE project_chat_messages ALTER COLUMN learning SET DEFAULT \'{}\'::jsonb',
        'ALTER TABLE project_chat_messages DROP CONSTRAINT project_chat_message_learning_check',
        'CREATE OR REPLACE FUNCTION neurocenter_project_chat_message_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    ])('read-only readiness rejects learning drift: %s', async sql => {
        const pool = await fixture(); await ensureCatalogSchema(pool); await pool.query(sql);
        await expect(checkCatalogSchema(pool, true)).rejects.toThrow();
    });
});
