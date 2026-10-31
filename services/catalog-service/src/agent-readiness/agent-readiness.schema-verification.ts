import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { AGENT_READINESS_SCHEMA_CONTRACT } from './agent-readiness.schema-contract';
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($trial_contract$${JSON.stringify(AGENT_READINESS_SCHEMA_CONTRACT)}$trial_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const AGENT_READINESS_SCHEMA_ASSERT_SQL = `DO $verify_trial$ DECLARE missing text;BEGIN SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;IF missing IS NOT NULL THEN RAISE EXCEPTION 'Agent trial schema is incomplete: %',missing;END IF;END $verify_trial$;`;
/** Runtime readiness rejects a changed owner index, transition guard or diagnostic bound. */
export async function assertAgentReadinessSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема испытаний агентов не готова: ' + rows.map((row) => row.issue).join(', '));
}
