import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
/** Measured on the owned PostgreSQL fixture, including CHECK/FK/index definitions. */
export const REMOTE_PROVIDER_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'model_remote_connections.auth_mode',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_credentials.credential',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_credentials.model_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_credentials.owner_email',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_credentials.provider_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_credentials.revision',
        definition: {
            type: 'integer',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_credentials.updated_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'clock_timestamp()',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_requests.model_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_requests.owner_email',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_requests.request_hash',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_requests.request_key',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'remote_provider_user_requests.result',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'constraint',
        id: 'model_remote_connections.model_remote_connections_auth_mode_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (auth_mode = ANY (ARRAY['none'::text, 'optional'::text, 'required'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_credentials.remote_provider_user_credentials_credential_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (credential IS NULL OR jsonb_typeof(credential) = 'object'::text AND octet_length(credential::text) <= 16384)",
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_credentials.remote_provider_user_credentials_model_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE RESTRICT',
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_credentials.remote_provider_user_credentials_owner_email_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (owner_email = lower(owner_email))',
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_credentials.remote_provider_user_credentials_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (model_id, provider_id, owner_email)',
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_credentials.remote_provider_user_credentials_provider_id_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (provider_id ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_credentials.remote_provider_user_credentials_revision_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (revision > 0)',
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_requests.remote_provider_user_requests_model_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE RESTRICT',
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_requests.remote_provider_user_requests_owner_email_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (owner_email = lower(owner_email))',
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_requests.remote_provider_user_requests_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (owner_email, request_key)',
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_requests.remote_provider_user_requests_request_hash_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'remote_provider_user_requests.remote_provider_user_requests_result_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(result) = 'object'::text AND octet_length(result::text) <= 8192)",
        },
    },
    {
        kind: 'index',
        id: 'remote_provider_user_credentials_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX remote_provider_user_credentials_pkey ON remote_provider_user_credentials USING btree (model_id, provider_id, owner_email)',
        },
    },
    {
        kind: 'index',
        id: 'remote_provider_user_requests_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX remote_provider_user_requests_pkey ON remote_provider_user_requests USING btree (owner_email, request_key)',
        },
    },
    {
        kind: 'table',
        id: 'remote_provider_user_credentials',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
    {
        kind: 'table',
        id: 'remote_provider_user_requests',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
];
const issues = `WITH expected AS(SELECT * FROM jsonb_to_recordset($personal_provider$${JSON.stringify(REMOTE_PROVIDER_SCHEMA_CONTRACT)}$personal_provider$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition`;
export const REMOTE_PROVIDER_SCHEMA_ASSERT_SQL = `DO $verify_personal_provider$ DECLARE missing text;BEGIN SELECT string_agg(issue,', ') INTO missing FROM (${issues}) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Personal provider schema is incomplete: %',missing;END IF;END $verify_personal_provider$;`;
export async function assertRemoteProviderSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if ((await db.query(issues)).rows.length) throw Error('Схема личного доступа к провайдерам не готова.');
}
