import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { PROJECT_QUOTA_USAGE_SCHEMA_CONTRACT } from './project-quota-usage.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($project_quota_contract$${JSON.stringify(PROJECT_QUOTA_USAGE_SCHEMA_CONTRACT)}$project_quota_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const PROJECT_QUOTA_USAGE_SCHEMA_ASSERT_SQL = `DO $verify_project_quota$ DECLARE missing text;BEGIN
 IF ${PROJECT_QUOTA_USAGE_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Project quota usage schema contract has not been finalized';END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Project quota usage schema is incomplete: %',missing;END IF;END $verify_project_quota$;`;
/** ROOT registers this exact contract only after the owned fixture has finalized physical schema facts. */
export async function assertProjectQuotaUsageSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!PROJECT_QUOTA_USAGE_SCHEMA_CONTRACT.length)
        throw new Error('Project quota usage schema contract has not been finalized.');
    const result = await db.query<{ issue: string }>(issues);
    if (result.rows.length)
        throw new Error('Схема учёта квот проектов не готова: ' + result.rows.map((row) => row.issue).join(', '));
}
