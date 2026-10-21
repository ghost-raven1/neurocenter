import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { MODEL_USAGE_SCHEMA_CONTRACT } from './model-usage.schema-contract';
const issues = `WITH expected AS (SELECT * FROM jsonb_to_recordset($model_usage_contract$${JSON.stringify(MODEL_USAGE_SCHEMA_CONTRACT)}$model_usage_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const MODEL_USAGE_SCHEMA_ASSERT_SQL = `DO $verify_model_usage$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Model usage schema is incomplete: %',missing; END IF;
END $verify_model_usage$;`;
/** Readiness verifies ledger structure; provider availability never affects application startup. */
export async function assertModelUsageSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема использования моделей не готова: ' + rows.map(row => row.issue).join(', '));
}
