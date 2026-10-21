import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {SOURCE_ARCHIVE_SCHEMA_CONTRACT} from './source-archive.schema-contract';
const issues=`WITH expected AS (
 SELECT * FROM jsonb_to_recordset($archive_contract$${JSON.stringify(SOURCE_ARCHIVE_SCHEMA_CONTRACT)}$archive_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const SOURCE_ARCHIVE_SCHEMA_ASSERT_SQL=`DO $verify_source_archive$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Source archive schema is incomplete: %',missing; END IF;
END $verify_source_archive$;`;
/** Archive jobs must never lose their persisted cache-only intent. */
export async function assertSourceArchiveSchema(db:Pick<Pool,'query'>):Promise<void>{
 const {rows}=await db.query<{issue:string}>(issues);
 if(rows.length)throw new Error('Схема архивного источника не готова: '+rows.map(row=>row.issue).join(', '));
}
