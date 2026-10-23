import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { DISCUSSIONS_SCHEMA_CONTRACT } from './discussions.schema-contract';
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($discussion_contract$${JSON.stringify(DISCUSSIONS_SCHEMA_CONTRACT)}$discussion_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const DISCUSSIONS_SCHEMA_ASSERT_SQL = `DO $verify_discussion$ DECLARE missing text;BEGIN SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;IF missing IS NOT NULL THEN RAISE EXCEPTION 'Discussion schema is incomplete: %',missing;END IF;END $verify_discussion$;`;
/** Verify durable discussion bounds and ownership before accepting traffic. */
export async function assertDiscussionsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!DISCUSSIONS_SCHEMA_CONTRACT.length) throw new Error('Discussion schema contract has not been finalized.');
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема обсуждений не готова: ' + rows.map(row => row.issue).join(', '));
}
