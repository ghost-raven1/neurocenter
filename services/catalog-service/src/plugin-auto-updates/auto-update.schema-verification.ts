import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { PLUGIN_AUTO_UPDATE_SCHEMA_CONTRACT } from './auto-update.schema-contract';
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($plugin_updates$${JSON.stringify(PLUGIN_AUTO_UPDATE_SCHEMA_CONTRACT)}$plugin_updates$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const PLUGIN_AUTO_UPDATE_SCHEMA_ASSERT_SQL = `DO $verify_plugin_updates$ DECLARE missing text;BEGIN
 IF ${PLUGIN_AUTO_UPDATE_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Plugin update physical contract is not measured'; END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Plugin update schema is incomplete: %',missing; END IF;END $verify_plugin_updates$;`;
/** A missing policy index or identity guard cannot silently become ready. */
export async function assertPluginAutoUpdateSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!PLUGIN_AUTO_UPDATE_SCHEMA_CONTRACT.length || (await db.query(issues)).rows.length)
        throw new Error('Схема автообновления плагинов не готова.');
}
