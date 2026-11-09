import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { VERSION_RETIREMENT_SCHEMA_CONTRACT } from './version-retirement.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($version_retirement_contract$${JSON.stringify(
    VERSION_RETIREMENT_SCHEMA_CONTRACT,
)}$version_retirement_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const VERSION_RETIREMENT_SCHEMA_ASSERT_SQL = `DO $verify_version_retirement$ DECLARE missing text;BEGIN
  IF ${VERSION_RETIREMENT_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Version retirement schema contract has not been finalized';END IF;
  SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Version retirement schema is incomplete: %',missing;END IF;END $verify_version_retirement$;`;
/** ROOT registers this exact contract only after the owned fixture has finalized physical schema facts. */
export async function assertVersionRetirementSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!VERSION_RETIREMENT_SCHEMA_CONTRACT.length)
        throw new Error('Version retirement schema contract has not been finalized.');
    const result = await db.query<{ issue: string }>(issues);
    if (result.rows.length)
        throw new Error(
            'Схема отзыва версий каталога не готова: ' + result.rows.map((row) => row.issue).join(', '),
        );
}
