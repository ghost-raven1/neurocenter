import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';

/** Declared structural facts; the release gate confirms these on the owned PostgreSQL fixture. */
export const PROJECT_TEXT_CONTEXT_SCHEMA_CONTRACT = [
    { kind: 'table', id: 'model_chat_text_contexts', definition: { kind: 'r', persistence: 'p' } },
    ...(['turn_id', 'project_id', 'selection', 'evidence', 'created_at'] as const).map((name, index) => ({
        kind: 'column',
        id: 'model_chat_text_contexts.' + name,
        definition: {
            type: ['uuid', 'text', 'jsonb', 'jsonb', 'timestamp with time zone'][index],
            default: name === 'created_at' ? 'now()' : null,
            notNull: true,
        },
    })),
    {
        kind: 'constraint',
        id: 'model_chat_text_contexts.model_chat_text_contexts_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (turn_id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_text_contexts.model_chat_text_contexts_turn_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (turn_id) REFERENCES model_chat_turns(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_text_contexts.model_chat_text_contexts_selection_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(selection) = 'object'::text AND octet_length(selection::text) <= 16384)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_text_contexts.model_chat_text_contexts_evidence_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(evidence) = 'object'::text AND octet_length(evidence::text) <= 65536)",
        },
    },
    {
        kind: 'index',
        id: 'model_chat_text_contexts_pkey',
        definition: {
            definition:
                'CREATE UNIQUE INDEX model_chat_text_contexts_pkey ON model_chat_text_contexts USING btree (turn_id)',
            valid: true,
            ready: true,
        },
    },
];
const issues = `WITH expected AS (SELECT * FROM jsonb_to_recordset($text_context$${JSON.stringify(PROJECT_TEXT_CONTEXT_SCHEMA_CONTRACT)}$text_context$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition`;
export const PROJECT_TEXT_CONTEXT_SCHEMA_ASSERT_SQL = `DO $verify_text_context$ DECLARE missing text;BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${issues}) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Project text context schema is incomplete: %',missing;END IF;END $verify_text_context$;`;
export async function assertProjectTextContextSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if ((await db.query(issues)).rows.length) throw new Error('Схема принятого текстового контекста не готова.');
}
