import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { BACKGROUND_AGENT_SCHEMA_CONTRACT } from './background-agent.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($background_agent_contract$${JSON.stringify(BACKGROUND_AGENT_SCHEMA_CONTRACT)}$background_agent_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const BACKGROUND_AGENT_SCHEMA_ASSERT_SQL = `DO $verify_background_agent$ DECLARE missing text;BEGIN
 IF ${BACKGROUND_AGENT_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Background agent schema contract has not been finalized';END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Background agent schema is incomplete: %',missing;END IF;END $verify_background_agent$;`;
/** ROOT registers this exact contract only after the owned fixture has finalized physical schema facts. */
export async function assertBackgroundAgentSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!BACKGROUND_AGENT_SCHEMA_CONTRACT.length)
        throw new Error('Background agent schema contract has not been finalized.');
    const result = await db.query<{ issue: string }>(issues);
    if (result.rows.length)
        throw new Error('Схема фонового агента не готова: ' + result.rows.map((row) => row.issue).join(', '));
}
