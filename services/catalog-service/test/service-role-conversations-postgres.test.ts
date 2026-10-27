import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {ownedTestPostgresAdmin} from '../../../scripts/test/owned-postgres.fixture.mjs';
import {migrateCatalog} from '../src/database/migrations';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {SERVICE_ROLE_CONVERSATIONS_SCHEMA_SQL} from '../src/system-role-chat/service-role-conversations.schema';
import {assertServiceRoleConversationsSchema} from '../src/system-role-chat/service-role-conversations.schema-verification';
import {SystemRoleChatRepository} from '../src/system-role-chat/system-role-chat.repository';

const connection = process.env.SERVICE_ROLE_CONVERSATIONS_TEST_ADMIN_URL;
describe.skipIf(!connection).sequential('role-pinned conversation SQL on an explicitly owned PostgreSQL', () => {
    let admin: Pool, pool: Pool, database: string;
    const owner = 'owner@role-conversation.test', project = 'prj-role-conversation', dialog = randomUUID();
    beforeAll(async () => {
        const url = ownedTestPostgresAdmin(connection); admin = new Pool({connectionString: url.href, max: 1});
        database = 'nc_role_chats_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; pool = new Pool({connectionString: url.href, max: 1});
        await migrateCatalog(pool, CATALOG_MIGRATIONS.filter(item => item.version < 43));
        await pool.query(SERVICE_ROLE_CONVERSATIONS_SCHEMA_SQL);
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$1)', [project]);
        await pool.query('INSERT INTO platform_users(email) VALUES($1)', [owner]);
        await pool.query("INSERT INTO system_role_dialogs(id,owner_email,project_id,title,agent_id) VALUES($1,$2,$3,'Coordinator','agent-coordinator')", [dialog, owner, project]);
    });
    afterAll(async () => {await pool?.end(); if (database) await admin.query('DROP DATABASE ' + database + ' WITH (FORCE)'); await admin?.end();});
    it('requires immutable role pins and rejects a different recipient before receipt acceptance', async () => {
        await assertServiceRoleConversationsSchema(pool);
        const checking = await pool.connect(); await checking.query('BEGIN');
        try {
            await checking.query('ALTER TABLE system_role_dialogs DISABLE TRIGGER service_role_conversation_pin_guard');
            await expect(assertServiceRoleConversationsSchema(checking as never)).rejects.toThrow('не готова');
        } finally {await checking.query('ROLLBACK'); checking.release();}
        await expect(pool.query("UPDATE system_role_dialogs SET agent_id='agent-indexer' WHERE id=$1", [dialog])).rejects.toThrow('immutable');
        const id = randomUUID();
        await expect(pool.query("INSERT INTO system_role_dialog_intents(id,dialog_id,owner_email,request_id,agent_id,request_hash,input) VALUES($1,$2,$3,$1,'agent-indexer',$4,'{}')", [id, dialog, owner, 'a'.repeat(64)])).rejects.toThrow('recipient mismatch');
        expect((await pool.query('SELECT count(*) FROM system_role_dialog_intents')).rows[0].count).toBe('0');
    });
    it('filters legacy role history before the 100-turn limit and retains the original IDs', async () => {
        const db = await pool.connect(); await db.query('BEGIN');
        try {
            await db.query('CREATE TEMP TABLE system_role_dialog_intents(id uuid,dialog_id uuid,owner_email text,agent_id text,created_at timestamptz) ON COMMIT DROP');
            const original = randomUUID();
            await db.query("INSERT INTO system_role_dialog_intents VALUES($1,$2,$3,'agent-indexer',now()-interval '1 day')", [original, dialog, owner]);
            for (let index = 0; index < 105; index++) await db.query("INSERT INTO system_role_dialog_intents VALUES($1,$2,$3,'agent-coordinator',now())", [randomUUID(), dialog, owner]);
            const repository = new SystemRoleChatRepository(db);
            expect((await repository.turns(dialog, owner, 'agent-indexer')).map(turn => turn.id)).toEqual([original]);
            expect(await repository.turns(dialog, 'other@test', 'agent-indexer')).toEqual([]);
            expect(await repository.turns(dialog, owner, 'agent-coordinator')).toHaveLength(100);
        } finally {await db.query('ROLLBACK'); db.release();}
    });
});
