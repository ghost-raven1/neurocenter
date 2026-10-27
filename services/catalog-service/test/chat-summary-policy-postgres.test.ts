import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAT_SUMMARY_POLICY_SCHEMA_SQL } from '../src/model-chat/chat-summary-policy.schema';
import { assertChatSummaryPolicySchema } from '../src/model-chat/chat-summary-policy.schema-verification';
import { ownedDeviceTestAdminUrl } from './device-completion-postgres.fixture';

const connection = process.env.CATALOG_TEST_PG_URL;

describe.skipIf(!connection).sequential('Summary policy upgrade — owned PostgreSQL schema', () => {
    let pool: Pool, db: PoolClient, schema: string;
    const legacy = 'Прежняя сохранённая сводка одного агента: не переписывать.';
    beforeAll(async () => {
        const url = ownedDeviceTestAdminUrl(connection!);
        pool = new Pool({ connectionString: url.href, max: 1 }); db = await pool.connect();
        schema = 'nc_summary_policy_' + randomUUID().replaceAll('-', '');
        await db.query('CREATE SCHEMA ' + schema);
        await db.query('SET search_path TO ' + schema);
        await db.query('CREATE TABLE model_chat_discussions(id integer PRIMARY KEY, result text)');
        await db.query('INSERT INTO model_chat_discussions VALUES(1,$1)', [legacy]);
        await db.query(CHAT_SUMMARY_POLICY_SCHEMA_SQL);
    });
    afterAll(async () => {
        if (db) { if (schema) await db.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); db.release(); }
        await pool?.end();
    });
    it('retains legacy content and marks only explicitly admitted new runs with the new policy', async () => {
        expect((await db.query('SELECT * FROM model_chat_discussions WHERE id=1')).rows[0]).toEqual({ id: 1, result: legacy, summary_policy: 'legacy' });
        await db.query("INSERT INTO model_chat_discussions(id,result,summary_policy) VALUES(2,'New single answer','unique-v1')");
        await assertChatSummaryPolicySchema(db);
        await expect(db.query("UPDATE model_chat_discussions SET summary_policy='unique-v1' WHERE id=1")).rejects.toThrow('immutable');
        await expect(db.query("UPDATE model_chat_discussions SET summary_policy='legacy' WHERE id=2")).rejects.toThrow('immutable');
        await expect(db.query("INSERT INTO model_chat_discussions(id,summary_policy) VALUES(3,'invented')")).rejects.toHaveProperty('code', '23514');
        expect((await db.query('SELECT result FROM model_chat_discussions WHERE id=1')).rows[0].result).toBe(legacy);
    });
    it('detects a removed policy constraint before readiness can accept the schema', async () => {
        await db.query('BEGIN');
        try {
            await db.query('ALTER TABLE model_chat_discussions DROP CONSTRAINT model_chat_discussions_summary_policy_check');
            await expect(assertChatSummaryPolicySchema(db)).rejects.toThrow('summary_policy_check');
        } finally { await db.query('ROLLBACK'); }
        await assertChatSummaryPolicySchema(db);
    });
    it('detects a disabled guard and a replaced policy function', async () => {
        await db.query('BEGIN');
        try {
            await db.query('ALTER TABLE model_chat_discussions DISABLE TRIGGER model_chat_summary_policy_immutable');
            await expect(assertChatSummaryPolicySchema(db)).rejects.toThrow('model_chat_summary_policy_immutable');
            await db.query('ALTER TABLE model_chat_discussions ENABLE TRIGGER model_chat_summary_policy_immutable');
            await db.query('CREATE OR REPLACE FUNCTION neurocenter_chat_summary_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$');
            await expect(assertChatSummaryPolicySchema(db)).rejects.toThrow('function:neurocenter_chat_summary_policy_immutable');
        } finally { await db.query('ROLLBACK'); }
        await assertChatSummaryPolicySchema(db);
    });
});
