import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CURRENT_PROJECT_CHAT_SYSTEM_CALL_SCHEMA_CONTRACT } from './project-chat-system-call.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($project_chat_system_call_contract$${JSON.stringify(
    CURRENT_PROJECT_CHAT_SYSTEM_CALL_SCHEMA_CONTRACT,
)}$project_chat_system_call_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const PROJECT_CHAT_SYSTEM_CALL_SCHEMA_ASSERT_SQL = `DO $verify_project_chat_system_call$ DECLARE missing text;BEGIN
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Project chat system call schema is incomplete: %',missing;END IF;END $verify_project_chat_system_call$;`;

/** Readiness fences the durable record of agent-initiated system-role calls. */
export async function assertProjectChatSystemCallSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length)
        throw new Error('Схема вызовов системных ролей агентом не готова: ' + rows.map((row) => row.issue).join(', '));
}
