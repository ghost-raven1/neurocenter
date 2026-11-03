import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { PACKAGE_BUILD_SLOTS_SCHEMA_CONTRACT } from './package-build-slots.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($build_slots_contract$${JSON.stringify(PACKAGE_BUILD_SLOTS_SCHEMA_CONTRACT)}$build_slots_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const PACKAGE_BUILD_SLOTS_SCHEMA_ASSERT_SQL = `DO $verify_build_slots$ DECLARE missing text;BEGIN
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Build run-slot schema is incomplete: %',missing;END IF;END $verify_build_slots$;`;
/** The slot column and index exist before the queue may claim a run slot. */
export async function assertPackageBuildSlotsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема слотов сборки не готова: ' + rows.map((row) => row.issue).join(', '));
}
