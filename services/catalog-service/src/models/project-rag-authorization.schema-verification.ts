import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {PROJECT_RAG_AUTHORIZATION_SCHEMA_CONTRACT} from './project-rag-authorization.schema-contract';

const issues=`WITH expected AS(SELECT * FROM jsonb_to_recordset($rag_authorization_contract$${JSON.stringify(PROJECT_RAG_AUTHORIZATION_SCHEMA_CONTRACT)}$rag_authorization_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const PROJECT_RAG_AUTHORIZATION_SCHEMA_ASSERT_SQL=`DO $verify_rag_authorization$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'RAG authorization schema is incomplete: %',missing; END IF;
END $verify_rag_authorization$;`;

/** Readiness checks intent author pins without rewriting historical migration contracts. */
export async function assertProjectRagAuthorizationSchema(db:Pick<Pool,'query'>):Promise<void>{
    const result=await db.query<{issue:string}>(issues);
    if(result.rows.length)throw new Error('Схема авторизации записи RAG не готова: '+result.rows.map(row=>row.issue).join(', '));
}
