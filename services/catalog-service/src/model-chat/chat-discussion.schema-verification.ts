import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CHAT_DISCUSSION_SCHEMA_CONTRACT } from './chat-discussion.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($discussion_contract$${JSON.stringify(CHAT_DISCUSSION_SCHEMA_CONTRACT)}$discussion_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition`;
export const CHAT_DISCUSSION_SCHEMA_ASSERT_SQL = `DO $verify_discussion$ DECLARE missing text;BEGIN
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Discussion schema is incomplete: %',missing;END IF;END $verify_discussion$;`;
/** Readiness is read-only and retains the frozen schema checks of every preceding migration. */
export async function assertChatDiscussionSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема обсуждения не готова: ' + rows.map((row) => row.issue).join(', '));
}
