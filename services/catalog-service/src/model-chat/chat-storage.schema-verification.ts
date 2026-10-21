import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CHAT_SCHEMA_CONTRACT } from './chat.schema-contract';
import { CHAT_STORAGE_SCHEMA_CONTRACT } from './chat-storage.schema-contract';

const replaced = new Set(['model_chat_attachments.content', 'model_chat_attachments.model_chat_attachments_check1']);
export const CHAT_STORAGE_CURRENT_SCHEMA_CONTRACT = [...CHAT_SCHEMA_CONTRACT.filter(fact => !replaced.has(fact.id)), ...CHAT_STORAGE_SCHEMA_CONTRACT];
const issues = `WITH expected AS (
 SELECT * FROM jsonb_to_recordset($chat_storage_contract$${JSON.stringify(CHAT_STORAGE_CURRENT_SCHEMA_CONTRACT)}$chat_storage_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition
UNION ALL SELECT 'removed:model_chat_attachments.content' WHERE EXISTS(SELECT 1 FROM information_schema.columns
 WHERE table_schema=current_schema() AND table_name='model_chat_attachments' AND column_name='content')`;

export const CHAT_STORAGE_SCHEMA_ASSERT_SQL = `DO $verify_chat_storage$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Chat object storage schema is incomplete: %',missing; END IF;
END $verify_chat_storage$;`;

/** Current readiness preserves frozen migration 13 checks while replacing its removed blob facts. */
export async function assertChatStorageSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const result = await db.query<{ issue: string }>(issues);
    if (result.rows.length) throw new Error('Схема хранилища файлов чата не готова: ' + result.rows.map(row => row.issue).join(', '));
}
