import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { RATE_LIMIT_WINDOWS_SCHEMA_CONTRACT } from './rate-limit-windows.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($rate_limit_contract$${JSON.stringify(RATE_LIMIT_WINDOWS_SCHEMA_CONTRACT)}$rate_limit_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const RATE_LIMIT_WINDOWS_SCHEMA_ASSERT_SQL = `DO $verify_rate_limit$ DECLARE missing text;BEGIN
 IF ${RATE_LIMIT_WINDOWS_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Rate limit windows schema contract has not been finalized';END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Rate limit windows schema is incomplete: %',missing;END IF;END $verify_rate_limit$;`;
/** ROOT registers this exact contract only after the owned fixture has finalized physical schema facts. */
export async function assertRateLimitWindowsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!RATE_LIMIT_WINDOWS_SCHEMA_CONTRACT.length)
        throw new Error('Rate limit windows schema contract has not been finalized.');
    const result = await db.query<{ issue: string }>(issues);
    if (result.rows.length)
        throw new Error('Схема rate-limit-окон не готова: ' + result.rows.map((row) => row.issue).join(', '));
}
