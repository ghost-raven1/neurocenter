import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { REMOTE_OPTIONS_SCHEMA_CONTRACT } from './remote-options.schema-contract';

const issues = `WITH expected AS (
 SELECT * FROM jsonb_to_recordset($remote_options_contract$${JSON.stringify(REMOTE_OPTIONS_SCHEMA_CONTRACT)}$remote_options_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const REMOTE_OPTIONS_SCHEMA_ASSERT_SQL = `DO $verify_remote_options$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Remote model options schema is incomplete: %',missing; END IF;
END $verify_remote_options$;`;

/** Readiness detects drift without changing connection settings or encrypted credentials. */
export async function assertRemoteOptionsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема параметров удалённых моделей не готова: ' + rows.map(row => row.issue).join(', '));
}
