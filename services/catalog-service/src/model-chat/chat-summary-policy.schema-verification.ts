import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CHAT_SUMMARY_POLICY_GUARD_BODY } from './chat-summary-policy.schema';

export const CHAT_SUMMARY_POLICY_SCHEMA_CONTRACT = [
    { kind: 'column', id: 'model_chat_discussions.summary_policy', definition: { type: 'text', default: "'legacy'::text", notNull: true } },
    { kind: 'constraint', id: 'model_chat_discussions.model_chat_discussions_summary_policy_check', definition: {
        type: 'c', validated: true, definition: "CHECK (summary_policy = ANY (ARRAY['legacy'::text, 'unique-v1'::text]))" } },
    { kind: 'trigger', id: 'model_chat_discussions.model_chat_summary_policy_immutable', definition: { enabled: 'O',
        definition: 'CREATE TRIGGER model_chat_summary_policy_immutable BEFORE UPDATE OF summary_policy ON model_chat_discussions FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_summary_policy_immutable()' } },
];

const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($summary_policy_contract$${JSON.stringify(CHAT_SUMMARY_POLICY_SCHEMA_CONTRACT)}$summary_policy_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition
UNION ALL SELECT 'function:neurocenter_chat_summary_policy_immutable()' WHERE NOT EXISTS(
 SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
 WHERE n.nspname=current_schema() AND p.proname='neurocenter_chat_summary_policy_immutable' AND p.pronargs=0
 AND p.prorettype='trigger'::regtype AND l.lanname='plpgsql' AND NOT p.prosecdef AND p.prosrc=$summary_policy_body$${CHAT_SUMMARY_POLICY_GUARD_BODY}$summary_policy_body$)`;

export const CHAT_SUMMARY_POLICY_SCHEMA_ASSERT_SQL = `DO $verify_summary_policy$ DECLARE missing text;BEGIN
SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Discussion summary policy schema is incomplete: %',missing;END IF;END $verify_summary_policy$;`;

/** Readiness checks the new policy without replacing any frozen earlier receipt contract. */
export async function assertChatSummaryPolicySchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема политики сводок не готова: ' + rows.map(row => row.issue).join(', '));
}
