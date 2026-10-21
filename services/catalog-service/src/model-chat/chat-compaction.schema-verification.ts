import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CHAT_COMPACTION_SCHEMA_CONTRACT } from './chat-compaction.schema-contract';

const issues = `WITH expected AS (
 SELECT * FROM jsonb_to_recordset($chat_compaction_contract$${JSON.stringify(CHAT_COMPACTION_SCHEMA_CONTRACT)}$chat_compaction_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const CHAT_COMPACTION_SCHEMA_ASSERT_SQL = `DO $verify_chat_compaction$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Chat compaction schema is incomplete: %',missing; END IF;
END $verify_chat_compaction$;`;

/** Verify immutable summary receipts without changing any original chat history. */
export async function assertChatCompactionSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема сжатия диалогов не готова: ' + rows.map(row => row.issue).join(', '));
}
