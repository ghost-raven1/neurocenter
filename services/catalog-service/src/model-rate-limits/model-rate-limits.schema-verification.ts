import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { MODEL_RATE_LIMITS_SCHEMA_CONTRACT } from './model-rate-limits.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($model_rate_contract$${JSON.stringify(MODEL_RATE_LIMITS_SCHEMA_CONTRACT)}$model_rate_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;

export const MODEL_RATE_LIMITS_SCHEMA_ASSERT_SQL = `DO $verify_model_rate$ DECLARE missing text;BEGIN
IF ${MODEL_RATE_LIMITS_SCHEMA_CONTRACT.length} = 0 THEN RAISE EXCEPTION 'Model rate schema contract has not been finalized'; END IF;
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Model rate and usage details schema is incomplete: %',missing;END IF;END $verify_model_rate$;`;

/** Verify exact rate-policy, admission and usage-metric objects before admitting traffic. */
export async function assertModelRateLimitsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!MODEL_RATE_LIMITS_SCHEMA_CONTRACT.length)
        throw new Error('Model rate schema contract has not been finalized.');
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length)
        throw new Error('Схема лимитов моделей и статистики не готова: ' + rows.map((row) => row.issue).join(', '));
}
