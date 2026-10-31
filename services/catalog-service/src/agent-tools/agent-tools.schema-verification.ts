import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { AGENT_TOOLS_SCHEMA_CONTRACT } from './agent-tools.schema-contract';
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($agent_tools$${JSON.stringify(AGENT_TOOLS_SCHEMA_CONTRACT)}$agent_tools$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const AGENT_TOOLS_SCHEMA_ASSERT_SQL = `DO $verify_agent_tools$ DECLARE missing text;BEGIN
 IF ${AGENT_TOOLS_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Agent tools physical contract is not measured'; END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Agent tools schema is incomplete: %',missing; END IF;END $verify_agent_tools$;`;
/** Missing one-dispatch guards or grant columns keep readiness closed. */
export async function assertAgentToolsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!AGENT_TOOLS_SCHEMA_CONTRACT.length || (await db.query(issues)).rows.length)
        throw new Error('Схема инструментов агентов не готова.');
}
