import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {AGENT_SCHEMA_CONTRACT} from './agent-schema-contract';

export const AGENT_SCHEMA_ISSUES_SQL=`WITH expected AS (
 SELECT * FROM jsonb_to_recordset($agent_schema_contract$${JSON.stringify(AGENT_SCHEMA_CONTRACT)}$agent_schema_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const AGENT_SCHEMA_ASSERT_SQL=`DO $verify_agents$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${AGENT_SCHEMA_ISSUES_SQL} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Agent schema is incomplete or incompatible: %',missing; END IF;
END $verify_agents$;`;
/** Agent tables extend the frozen pre-agent contract without rewriting its migration checksum. */
export async function assertAgentSchema(db:Pick<Pool,'query'>):Promise<void>{
 const {rows}=await db.query<{issue:string}>(AGENT_SCHEMA_ISSUES_SQL);
 if(rows.length)throw new Error('Схема агентов не готова или несовместима: '+rows.slice(0,10).map(row=>row.issue).join(', '));
}
