import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {CATALOG_REQUEST_SCHEMA_CONTRACT} from './request.schema-contract';
export const CATALOG_REQUEST_SCHEMA_ISSUES_SQL=`WITH expected AS (
 SELECT * FROM jsonb_to_recordset($request_schema_contract$${JSON.stringify(CATALOG_REQUEST_SCHEMA_CONTRACT)}$request_schema_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const CATALOG_REQUEST_SCHEMA_ASSERT_SQL=`DO $verify_requests$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${CATALOG_REQUEST_SCHEMA_ISSUES_SQL} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Catalog request schema is incomplete or incompatible: %',missing; END IF;
END $verify_requests$;`;
/** Readiness validates the current extension without changing historical migration checksums. */
export async function assertCatalogRequestSchema(db:Pick<Pool,'query'>):Promise<void>{
 const {rows}=await db.query<{issue:string}>(CATALOG_REQUEST_SCHEMA_ISSUES_SQL);
 if(rows.length)throw new Error('Схема заявок не готова: '+rows.slice(0,10).map(row=>row.issue).join(', '));
}
