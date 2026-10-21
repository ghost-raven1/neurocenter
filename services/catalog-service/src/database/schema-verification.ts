import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from './schema-catalog';
import {CATALOG_SCHEMA_CONTRACT} from './schema-contract';

/** Required objects are compared structurally; unrelated tables and extra indexes remain untouched. */
export const CATALOG_SCHEMA_ISSUES_SQL=`WITH expected AS (
    SELECT * FROM jsonb_to_recordset($schema_contract$${JSON.stringify(CATALOG_SCHEMA_CONTRACT)}$schema_contract$::jsonb)
    AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected
LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition
ORDER BY expected.kind,expected.id`;

export const CATALOG_SCHEMA_ASSERT_SQL=`DO $verify_catalog$ DECLARE missing text; BEGIN
    SELECT string_agg(issue,', ') INTO missing FROM (${CATALOG_SCHEMA_ISSUES_SQL} LIMIT 10) issues;
    IF missing IS NOT NULL THEN RAISE EXCEPTION 'Catalog schema is incomplete or incompatible: %',missing; END IF;
END $verify_catalog$;`;

export async function assertCatalogSchema(pool:Pick<Pool,'query'>):Promise<void>{
    const {rows}=await pool.query<{issue:string}>(CATALOG_SCHEMA_ISSUES_SQL);
    if(rows.length)throw new Error('Схема каталога не готова или несовместима: '+rows.slice(0,10).map(row=>row.issue).join(', '));
}
