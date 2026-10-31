import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { OPENCODE_MODEL_SYNC_SCHEMA_CONTRACT } from './opencode-model-sync.schema-contract';
const issues = `WITH expected AS (SELECT * FROM jsonb_to_recordset($opencode_sync_contract$${JSON.stringify(OPENCODE_MODEL_SYNC_SCHEMA_CONTRACT)}$opencode_sync_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const OPENCODE_MODEL_SYNC_SCHEMA_ASSERT_SQL = `DO $verify_opencode_sync$ DECLARE missing text; BEGIN
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'OpenCode model sync schema is incomplete: %',missing; END IF; END $verify_opencode_sync$;`;
/** Readiness validates consent/source linkage without touching credentials. */
export async function assertOpenCodeModelSyncSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length)
        throw Error('Схема синхронизации моделей OpenCode не готова: ' + rows.map((row) => row.issue).join(', '));
}
