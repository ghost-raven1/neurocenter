import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {CHAT_SYSTEM_ROLE_SCHEMA_CONTRACT} from './chat-system-roles.schema-contract';
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($chat_role_origin$${JSON.stringify(CHAT_SYSTEM_ROLE_SCHEMA_CONTRACT)}$chat_role_origin$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const CHAT_SYSTEM_ROLE_SCHEMA_ASSERT_SQL = `DO $verify_chat_role_origin$ DECLARE missing text;BEGIN
 IF ${CHAT_SYSTEM_ROLE_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Chat system role origin physical contract is not measured'; END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Chat system role origin schema is incomplete: %',missing; END IF;END $verify_chat_role_origin$;`;
/** A mutable/missing binding cannot silently erase the original chat checkpoint. */
export async function assertChatSystemRoleSchema(db: Pick<Pool,'query'>): Promise<void> {
    if (!CHAT_SYSTEM_ROLE_SCHEMA_CONTRACT.length || (await db.query(issues)).rows.length) throw new Error('Схема привязки системных задач к чату не готова.');
}
