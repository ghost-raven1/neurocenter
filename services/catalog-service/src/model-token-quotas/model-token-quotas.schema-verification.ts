import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT } from './model-token-quotas.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($model_token_contract$${JSON.stringify(MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT)}$model_token_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const MODEL_TOKEN_QUOTAS_SCHEMA_ASSERT_SQL = `DO $verify_model_tokens$ DECLARE missing text;BEGIN
 IF ${MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Model token quota schema contract has not been finalized';END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Model token quota schema is incomplete: %',missing;END IF;END $verify_model_tokens$;`;
/** ROOT registers this exact contract only after the owned fixture has finalized physical schema facts. */
export async function assertModelTokenQuotasSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT.length)
        throw new Error('Model token quota schema contract has not been finalized.');
    const result = await db.query<{ issue: string }>(issues);
    if (result.rows.length)
        throw new Error('Схема персональных квот моделей не готова: ' + result.rows.map((row) => row.issue).join(', '));
}
