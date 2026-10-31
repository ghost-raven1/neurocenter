import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { SERVICE_ROLE_CONVERSATIONS_SCHEMA_CONTRACT } from './service-role-conversations.schema-contract';

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($role_conversations$${JSON.stringify(SERVICE_ROLE_CONVERSATIONS_SCHEMA_CONTRACT)}$role_conversations$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const SERVICE_ROLE_CONVERSATIONS_SCHEMA_ASSERT_SQL = `DO $verify_role_conversations$ DECLARE missing text;BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Service role conversation schema is incomplete: %',missing; END IF;END $verify_role_conversations$;`;

/** Readiness checks the measured pin, recipient guards and history index without starting work. */
export async function assertServiceRoleConversationsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if ((await db.query(issues)).rows.length) throw new Error('Схема отдельных чатов системных ролей не готова.');
}
