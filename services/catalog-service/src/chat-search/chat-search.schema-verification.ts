import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {CHAT_SEARCH_SCHEMA_CONTRACT} from './chat-search.schema-contract';
const issues=`WITH expected AS(SELECT * FROM jsonb_to_recordset($chat_search_contract$${JSON.stringify(CHAT_SEARCH_SCHEMA_CONTRACT)}$chat_search_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const CHAT_SEARCH_SCHEMA_ASSERT_SQL=`DO $verify_chat_search$ DECLARE missing text;BEGIN
 IF ${CHAT_SEARCH_SCHEMA_CONTRACT.length}=0 THEN RAISE EXCEPTION 'Chat search physical contract is not measured'; END IF;
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Chat search schema is incomplete: %',missing; END IF;END $verify_chat_search$;`;
/** Missing revision/tombstone protection fails readiness instead of returning stale/private results. */
export async function assertChatSearchSchema(db:Pick<Pool,'query'>):Promise<void>{
    if(!CHAT_SEARCH_SCHEMA_CONTRACT.length)throw new Error('Chat search physical contract is not measured.');
    if((await db.query(issues)).rows.length)throw new Error('Схема семантического поиска не готова.');
}
