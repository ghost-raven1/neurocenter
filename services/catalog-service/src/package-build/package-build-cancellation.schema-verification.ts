import type { Pool } from 'pg';
import { CATALOG_SCHEMA_CONTRACT } from '../database/schema-contract';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { PACKAGE_BUILD_CANCELLATION_SCHEMA_CONTRACT } from './package-build-cancellation.schema-contract';

const overridden = new Set(['constraint:tool_build_jobs.tool_build_jobs_state_check']);
export const CURRENT_BUILD_CATALOG_SCHEMA_CONTRACT = [
    ...CATALOG_SCHEMA_CONTRACT.filter((item) => !overridden.has(item.kind + ':' + item.id)),
    ...PACKAGE_BUILD_CANCELLATION_SCHEMA_CONTRACT,
];
const issues = (
    contract: unknown,
) => `WITH expected AS(SELECT * FROM jsonb_to_recordset($build_contract$${JSON.stringify(contract)}$build_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const PACKAGE_BUILD_CANCELLATION_SCHEMA_ASSERT_SQL = `DO $verify_build$ DECLARE missing text;BEGIN SELECT string_agg(issue,', ') INTO missing FROM (${issues(PACKAGE_BUILD_CANCELLATION_SCHEMA_CONTRACT)} LIMIT 10) issues;IF missing IS NOT NULL THEN RAISE EXCEPTION 'Build cancellation schema is incomplete: %',missing;END IF;END $verify_build$;`;

/** Every baseline fact is retained except the build state constraint superseded by migration 21. */
export async function assertCurrentBuildCatalogSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues(CURRENT_BUILD_CATALOG_SCHEMA_CONTRACT));
    if (rows.length)
        throw new Error(
            'Схема каталога не готова или несовместима: ' +
                rows
                    .slice(0, 10)
                    .map((row) => row.issue)
                    .join(', '),
        );
}
