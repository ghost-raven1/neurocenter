import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { ERROR_EVENTS_SCHEMA_CONTRACT } from './error-events.schema-contract';

/**
 * AD-O5 invariant: колонки/ограничения/индексы error_events совпадают с
 * зафиксированными фактами (колонки, CHECK level, PK, индексы service/ts
 * и request_id).
 */
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($error_events_contract$${JSON.stringify(
    ERROR_EVENTS_SCHEMA_CONTRACT,
)}$error_events_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;

export const ERROR_EVENTS_SCHEMA_ASSERT_SQL = `DO $verify_error_events$ DECLARE missing text;BEGIN
 IF ${ERROR_EVENTS_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Error events schema contract has not been finalized';END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Error events schema is incomplete: %',missing;END IF;END $verify_error_events$;`;

/** ROOT registers this exact contract only after the owned fixture has finalized physical schema facts. */
export async function assertErrorEventsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!ERROR_EVENTS_SCHEMA_CONTRACT.length)
        throw new Error('Error events schema contract has not been finalized.');
    const result = await db.query<{ issue: string }>(issues);
    if (result.rows.length)
        throw new Error('Схема error-store не готова: ' + result.rows.map((row) => row.issue).join(', '));
}
