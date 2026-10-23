import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {CHAT_ACTIVITY_SCHEMA_CONTRACT} from './chat-activity.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($chat_activity_contract$${JSON.stringify(CHAT_ACTIVITY_SCHEMA_CONTRACT)}$chat_activity_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const CHAT_ACTIVITY_SCHEMA_ASSERT_SQL = `DO $verify_chat_activity$ DECLARE missing text;BEGIN
IF ${CHAT_ACTIVITY_SCHEMA_CONTRACT.length} = 0 THEN RAISE EXCEPTION 'Chat activity schema contract has not been finalized'; END IF;
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Chat activity schema is incomplete: %',missing;END IF;END $verify_chat_activity$;`;
/** Presence leases, ordered session tombstones and message receipt references are part of readiness. */
export async function assertChatActivitySchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!CHAT_ACTIVITY_SCHEMA_CONTRACT.length) throw new Error('Chat activity schema contract has not been finalized.');
    const {rows} = await db.query<{issue: string}>(issues);
    if (rows.length) throw new Error('Схема активности чатов не готова: ' + rows.map(row => row.issue).join(', '));
}
