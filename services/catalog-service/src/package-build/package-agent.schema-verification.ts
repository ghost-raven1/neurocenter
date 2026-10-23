import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {PACKAGE_AGENT_SCHEMA_CONTRACT,PACKAGE_BUILD_RUNTIME_SCHEMA_CONTRACT} from './package-agent.schema-contract';

export const PACKAGE_AGENT_CURRENT_SCHEMA_CONTRACT=[...PACKAGE_AGENT_SCHEMA_CONTRACT,...PACKAGE_BUILD_RUNTIME_SCHEMA_CONTRACT];
const issues=`WITH expected AS(SELECT * FROM jsonb_to_recordset($package_agent_contract$${JSON.stringify(PACKAGE_AGENT_CURRENT_SCHEMA_CONTRACT)}$package_agent_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const PACKAGE_AGENT_SCHEMA_ASSERT_SQL=`DO $verify_package_agent$ DECLARE missing text;BEGIN
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Packager agent and runtime schema is incomplete: %',missing;END IF;END $verify_package_agent$;`;
/** History and launch readiness include both agent decisions and the common runtime gate. */
export async function assertPackageAgentSchema(db:Pick<Pool,'query'>):Promise<void>{
    const {rows}=await db.query<{issue:string}>(issues);
    if(rows.length)throw new Error('Схема агента «Упаковщик» и проверки runtime не готова: '+rows.map(row=>row.issue).join(', '));
}
