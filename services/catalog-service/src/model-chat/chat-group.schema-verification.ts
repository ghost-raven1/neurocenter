import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CHAT_GROUP_SCHEMA_CONTRACT } from './chat-group.schema-contract';
const issues = `WITH expected AS (SELECT * FROM jsonb_to_recordset($chat_group_contract$${JSON.stringify(CHAT_GROUP_SCHEMA_CONTRACT)}$chat_group_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const CHAT_GROUP_SCHEMA_ASSERT_SQL = `DO $verify_chat_group$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Group chat schema is incomplete: %',missing; END IF;
END $verify_chat_group$;`;
/** Verify pinned participants and response history without changing private conversations. */
export async function assertChatGroupSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема групповых диалогов не готова: ' + rows.map((row) => row.issue).join(', '));
}
