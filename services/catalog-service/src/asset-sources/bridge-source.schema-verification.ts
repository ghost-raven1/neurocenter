import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {BRIDGE_SOURCE_SCHEMA_CONTRACT} from './bridge-source.schema-contract';
export const BRIDGE_SOURCE_SCHEMA_ISSUES_SQL=`WITH expected AS (
 SELECT * FROM jsonb_to_recordset($bridge_source_schema_contract$${JSON.stringify(BRIDGE_SOURCE_SCHEMA_CONTRACT)}$bridge_source_schema_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const BRIDGE_SOURCE_SCHEMA_ASSERT_SQL=`DO $verify_bridge_source$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${BRIDGE_SOURCE_SCHEMA_ISSUES_SQL} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Bridge source schema is incomplete or incompatible: %',missing; END IF;
END $verify_bridge_source$;`;
/** Readiness rejects drift without repairing tables or changing historical migrations. */
export async function assertBridgeSourceSchema(db:Pick<Pool,'query'>):Promise<void>{
 const {rows}=await db.query<{issue:string}>(BRIDGE_SOURCE_SCHEMA_ISSUES_SQL);
 if(rows.length)throw new Error('Схема источника моста не готова: '+rows.slice(0,10).map(row=>row.issue).join(', '));
}
