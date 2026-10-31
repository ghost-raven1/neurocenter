import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { PROJECT_TEXT_CONTEXT_SCHEMA_CONTRACT } from '../project-text/project-text.schema-verification';

/** Current physical facts extend migration47; its historical SQL assertion remains frozen. */
export const CURRENT_TEXT_CONTEXT_SCHEMA_CONTRACT = PROJECT_TEXT_CONTEXT_SCHEMA_CONTRACT.map((fact) => {
    if (fact.id === 'model_chat_text_contexts.model_chat_text_contexts_selection_check')
        return {
            ...fact,
            definition: {
                type: 'c',
                validated: true,
                definition:
                    "CHECK (jsonb_typeof(selection) = 'object'::text AND octet_length(selection::text) <= 131072)",
            },
        };
    if (fact.id === 'model_chat_text_contexts.model_chat_text_contexts_evidence_check')
        return {
            ...fact,
            definition: {
                type: 'c',
                validated: true,
                definition:
                    "CHECK (jsonb_typeof(evidence) = 'object'::text AND octet_length(evidence::text) <= 2097152)",
            },
        };
    return fact;
});
const table = (id: string) => ({ kind: 'table', id, definition: { kind: 'r', persistence: 'p' } });
const column = (table: string, name: string, type: string, defaultValue: string | null = null) => ({
    kind: 'column',
    id: table + '.' + name,
    definition: { type, default: defaultValue, notNull: true },
});
const constraint = (table: string, name: string, type: string, definition: string) => ({
    kind: 'constraint',
    id: table + '.' + name,
    definition: { type, validated: true, definition },
});
export const RUNTIME_LIMITS_SCHEMA_CONTRACT = [
    table('runtime_limit_settings'),
    table('runtime_limit_requests'),
    column('runtime_limit_settings', 'singleton', 'boolean', 'true'),
    column('runtime_limit_settings', 'revision', 'integer'),
    column('runtime_limit_settings', 'policy', 'jsonb'),
    column('runtime_limit_settings', 'updated_at', 'timestamp with time zone', 'clock_timestamp()'),
    column('runtime_limit_requests', 'actor', 'text'),
    column('runtime_limit_requests', 'request_key', 'uuid'),
    column('runtime_limit_requests', 'request_hash', 'text'),
    column('runtime_limit_requests', 'result', 'jsonb'),
    constraint('runtime_limit_settings', 'runtime_limit_settings_pkey', 'p', 'PRIMARY KEY (singleton)'),
    constraint('runtime_limit_settings', 'runtime_limit_settings_singleton_check', 'c', 'CHECK (singleton)'),
    constraint('runtime_limit_settings', 'runtime_limit_settings_revision_check', 'c', 'CHECK (revision > 0)'),
    constraint(
        'runtime_limit_settings',
        'runtime_limit_settings_policy_check',
        'c',
        "CHECK (jsonb_typeof(policy) = 'object'::text AND octet_length(policy::text) <= 32768)",
    ),
    constraint('runtime_limit_requests', 'runtime_limit_requests_pkey', 'p', 'PRIMARY KEY (actor, request_key)'),
    constraint(
        'runtime_limit_requests',
        'runtime_limit_requests_request_hash_check',
        'c',
        "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)",
    ),
    constraint(
        'runtime_limit_requests',
        'runtime_limit_requests_result_check',
        'c',
        "CHECK (jsonb_typeof(result) = 'object'::text AND octet_length(result::text) <= 65536)",
    ),
    {
        kind: 'index',
        id: 'runtime_limit_settings_pkey',
        definition: {
            definition:
                'CREATE UNIQUE INDEX runtime_limit_settings_pkey ON runtime_limit_settings USING btree (singleton)',
            valid: true,
            ready: true,
        },
    },
    {
        kind: 'index',
        id: 'runtime_limit_requests_pkey',
        definition: {
            definition:
                'CREATE UNIQUE INDEX runtime_limit_requests_pkey ON runtime_limit_requests USING btree (actor, request_key)',
            valid: true,
            ready: true,
        },
    },
];
const issues = (
    facts: unknown,
) => `WITH expected AS (SELECT * FROM jsonb_to_recordset($runtime_limits$${JSON.stringify(facts)}$runtime_limits$::jsonb)
 AS objects(kind text,id text,definition jsonb)),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition`;
const currentIssues = issues([...RUNTIME_LIMITS_SCHEMA_CONTRACT, ...CURRENT_TEXT_CONTEXT_SCHEMA_CONTRACT]);
export const RUNTIME_LIMITS_SCHEMA_ASSERT_SQL = `DO $verify_runtime_limits$ DECLARE missing text;BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${currentIssues}) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Runtime limit schema is incomplete: %',missing;END IF;END $verify_runtime_limits$;`;
export async function assertRuntimeLimitsSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if ((await db.query(currentIssues)).rows.length) throw new Error('Схема действующих лимитов не готова.');
}
export async function assertCurrentTextContextSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if ((await db.query(issues(CURRENT_TEXT_CONTEXT_SCHEMA_CONTRACT))).rows.length)
        throw new Error('Схема принятого текстового контекста не готова.');
}
