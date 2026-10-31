import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { METHOD_CHAT_WORKFLOWS_SCHEMA_CONTRACT } from './chat-workflows.schema-contract';
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($method_chat_contract$${JSON.stringify(METHOD_CHAT_WORKFLOWS_SCHEMA_CONTRACT)}$method_chat_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const METHOD_CHAT_WORKFLOWS_SCHEMA_ASSERT_SQL = `DO $verify_method_chat$ DECLARE missing text;BEGIN
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Method chat workflow schema is incomplete: %',missing;END IF;END $verify_method_chat$;`;
/** Readiness covers durable source attribution and immutable public completion receipts. */
export async function assertMethodChatWorkflowsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length)
        throw new Error('Схема результатов методик в чате не готова: ' + rows.map((row) => row.issue).join(', '));
}
