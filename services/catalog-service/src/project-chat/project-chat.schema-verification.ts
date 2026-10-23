import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { PROJECT_CHAT_SCHEMA_CONTRACT } from './project-chat.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($project_chat_contract$${JSON.stringify(PROJECT_CHAT_SCHEMA_CONTRACT)}$project_chat_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;

export const PROJECT_CHAT_SCHEMA_ASSERT_SQL = `DO $verify_project_chat$ DECLARE missing text;BEGIN
IF ${PROJECT_CHAT_SCHEMA_CONTRACT.length} = 0 THEN RAISE EXCEPTION 'Project chat schema contract has not been finalized'; END IF;
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Project chat schema is incomplete: %',missing;END IF;END $verify_project_chat$;`;

/** Check every measured column, constraint, index and trigger before project room traffic is admitted. */
export async function assertProjectChatSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!PROJECT_CHAT_SCHEMA_CONTRACT.length) throw new Error('Project chat schema contract has not been finalized.');
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема проектного чата не готова: ' + rows.map(row => row.issue).join(', '));
}
