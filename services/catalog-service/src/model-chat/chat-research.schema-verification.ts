import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CHAT_COMPACTION_SCHEMA_CONTRACT } from './chat-compaction.schema-contract';
import { CHAT_GROUP_SCHEMA_CONTRACT } from './chat-group.schema-contract';
import { MODEL_USAGE_SCHEMA_CONTRACT } from '../model-usage/model-usage.schema-contract';
import { CHAT_RESEARCH_SCHEMA_CONTRACT } from './chat-research.schema-contract';
const replaced = new Set([
    'model_chat_turns.model_chat_turns_processing_stage_check',
    'model_chat_agent_responses.model_chat_agent_responses_processing_stage_check',
    'model_usage_calls.model_usage_calls_purpose_check',
]);
export const CHAT_RESEARCH_CURRENT_SCHEMA_CONTRACT = [
    ...[...CHAT_COMPACTION_SCHEMA_CONTRACT, ...CHAT_GROUP_SCHEMA_CONTRACT, ...MODEL_USAGE_SCHEMA_CONTRACT].filter(
        (fact) => !replaced.has(fact.id),
    ),
    ...CHAT_RESEARCH_SCHEMA_CONTRACT,
];
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($research_contract$${JSON.stringify(CHAT_RESEARCH_CURRENT_SCHEMA_CONTRACT)}$research_contract$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const CHAT_RESEARCH_SCHEMA_ASSERT_SQL = `DO $verify_research$ DECLARE missing text;BEGIN SELECT string_agg(issue,', ') INTO missing FROM (${issues} LIMIT 10) issues;IF missing IS NOT NULL THEN RAISE EXCEPTION 'Research schema is incomplete: %',missing;END IF;END $verify_research$;`;
/** Frozen previous migrations retain their original facts; readiness verifies the current replacement constraints. */
export async function assertChatResearchSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(issues);
    if (rows.length) throw new Error('Схема исследования не готова: ' + rows.map((row) => row.issue).join(', '));
}
