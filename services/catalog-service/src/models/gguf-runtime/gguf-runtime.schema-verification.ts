import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../../database/schema-catalog';

/** Durable provider intent facts are included in Catalog readiness and migration 50. */
export const GGUF_RUNTIME_SCHEMA_CONTRACT = [
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_bytes_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (bytes > 0 AND bytes <= '9007199254740991'::bigint)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (state <> 'CREATED'::text OR manifest_sha256 IS NOT NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_file_sha256_check',
        definition: { type: 'c', validated: true, definition: "CHECK (file_sha256 ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_limits_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(limits) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_manifest_sha256_check',
        definition: { type: 'c', validated: true, definition: "CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (state = ANY (ARRAY['RESERVED'::text, 'CREATE_SENT'::text, 'CREATED'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_upload_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (upload_id)' },
    },
    { kind: 'table', id: 'model_gguf_runtime_intents', definition: { kind: 'r', persistence: 'p' } },
    ...(
        [
            'model_id',
            'upload_id',
            'alias',
            'file_sha256',
            'bytes',
            'state',
            'manifest_sha256',
            'limits',
            'created_at',
            'updated_at',
        ] as const
    ).map((name, index) => ({
        kind: 'column',
        id: 'model_gguf_runtime_intents.' + name,
        definition: {
            type: [
                'text',
                'uuid',
                'text',
                'text',
                'bigint',
                'text',
                'text',
                'jsonb',
                'timestamp with time zone',
                'timestamp with time zone',
            ][index],
            notNull: name !== 'manifest_sha256',
            default: ['created_at', 'updated_at'].includes(name) ? 'now()' : null,
        },
    })),
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (model_id)' },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_model_id_fkey',
        definition: { type: 'f', validated: true, definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id)' },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_upload_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (upload_id) REFERENCES model_gguf_uploads(id)',
        },
    },
    {
        kind: 'constraint',
        id: 'model_gguf_runtime_intents.model_gguf_runtime_intents_alias_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (alias)' },
    },
];
const issues = `WITH expected AS (SELECT * FROM jsonb_to_recordset($gguf_runtime$${JSON.stringify(GGUF_RUNTIME_SCHEMA_CONTRACT)}$gguf_runtime$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS (${CATALOG_SCHEMA_FACTS_SQL}) SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition`;
export const GGUF_RUNTIME_SCHEMA_ASSERT_SQL = `DO $verify_gguf_runtime$ DECLARE missing text;BEGIN SELECT string_agg(issue,', ') INTO missing FROM (${issues}) issues; IF missing IS NOT NULL THEN RAISE EXCEPTION 'GGUF runtime schema is incomplete: %',missing;END IF;END $verify_gguf_runtime$;`;
export async function assertGgufRuntimeSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if ((await db.query(issues)).rows.length) throw new Error('Схема намерений GGUF runtime не готова.');
}
