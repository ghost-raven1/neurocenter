import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CURRENT_PROJECT_CHAT_LEARNING_SCHEMA_CONTRACT } from './project-chat-learning.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($project_chat_learning_contract$${JSON.stringify(CURRENT_PROJECT_CHAT_LEARNING_SCHEMA_CONTRACT)}$project_chat_learning_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;

export const PROJECT_CHAT_LEARNING_SCHEMA_ASSERT_SQL = `DO $verify_project_chat_learning$ DECLARE missing text;BEGIN
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Project chat learning schema is incomplete: %',missing;END IF;END $verify_project_chat_learning$;`;

/** Current readiness includes immutable answer provenance without changing historical migration assertions. */
export async function assertProjectChatLearningSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема знаний ответов проектного чата не готова: ' + rows.map(row => row.issue).join(', '));
}
