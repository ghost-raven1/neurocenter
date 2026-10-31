/** Physical facts captured from the owned PostgreSQL16.15 fixture; no historical receipts are rewritten. */
export const MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT: Array<{
    kind: string;
    id: string;
    definition: Record<string, unknown>;
}> = [
    {
        kind: 'column',
        id: 'model_usage_calls.quota_admitted_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.quota_debit_tokens',
        definition: { type: 'bigint', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.quota_metadata',
        definition: { type: 'jsonb', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.quota_reserved_tokens',
        definition: { type: 'bigint', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.quota_settlement_digest',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.quota_state',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_user_token_quota_requests.created_at',
        definition: { type: 'timestamp with time zone', default: 'clock_timestamp()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quota_requests.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quota_requests.receipt',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quota_requests.request_fingerprint',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quota_requests.request_key',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quota_requests.user_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quota_requests.writer_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.accounting_started_at',
        definition: { type: 'timestamp with time zone', default: 'clock_timestamp()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.enabled',
        definition: { type: 'boolean', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.period_ms',
        definition: { type: 'bigint', default: '86400000', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.revision',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.token_limit',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.updated_at',
        definition: { type: 'timestamp with time zone', default: 'clock_timestamp()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.updated_by',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_user_token_quotas.user_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_quota_debit_tokens_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (quota_debit_tokens >= 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_quota_reserved_tokens_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (quota_reserved_tokens >= 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_quota_settlement_digest_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (quota_settlement_digest ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_quota_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (quota_state = ANY (ARRAY['reserved'::text, 'dispatched'::text, 'settled'::text, 'unknown'::text, 'released'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_quota_shape',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (quota_state IS NULL AND quota_reserved_tokens IS NULL AND quota_debit_tokens IS NULL AND quota_admitted_at IS NULL AND quota_metadata IS NULL AND quota_settlement_digest IS NULL OR quota_state IS NOT NULL AND quota_reserved_tokens IS NOT NULL AND quota_debit_tokens IS NOT NULL AND quota_admitted_at IS NOT NULL AND quota_metadata IS NOT NULL AND jsonb_typeof(quota_metadata) = 'object'::text AND ((quota_state = ANY (ARRAY['reserved'::text, 'dispatched'::text])) AND quota_debit_tokens = 0 AND quota_settlement_digest IS NULL OR (quota_state = ANY (ARRAY['settled'::text, 'unknown'::text, 'released'::text])) AND quota_reserved_tokens = 0))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_user_token_quota_requests.model_user_token_quota_requests_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (writer_email, request_key)' },
    },
    {
        kind: 'constraint',
        id: 'model_user_token_quota_requests.model_user_token_quota_requests_request_fingerprint_check',
        definition: { type: 'c', validated: true, definition: "CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_user_token_quotas.model_user_token_quotas_period_ms_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (period_ms > 0 AND period_ms <= '31536000000'::bigint)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_user_token_quotas.model_user_token_quotas_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (model_id, user_email)' },
    },
    {
        kind: 'constraint',
        id: 'model_user_token_quotas.model_user_token_quotas_revision_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (revision > 0 AND revision <= '9007199254740991'::bigint)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_user_token_quotas.model_user_token_quotas_token_limit_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (token_limit > 0 AND token_limit <= '9007199254740991'::bigint)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_user_token_quotas.model_user_token_quotas_user_email_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (user_email = lower(user_email))' },
    },
    {
        kind: 'index',
        id: 'model_usage_calls_quota_pair',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX model_usage_calls_quota_pair ON model_usage_calls USING btree (actor_email, model_id, quota_admitted_at DESC)',
        },
    },
    {
        kind: 'index',
        id: 'model_usage_calls_quota_unsettled',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE INDEX model_usage_calls_quota_unsettled ON model_usage_calls USING btree (actor_email, model_id) WHERE (quota_state = ANY (ARRAY['reserved'::text, 'dispatched'::text, 'unknown'::text]))",
        },
    },
    {
        kind: 'index',
        id: 'model_user_token_quota_requests_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_user_token_quota_requests_pkey ON model_user_token_quota_requests USING btree (writer_email, request_key)',
        },
    },
    {
        kind: 'index',
        id: 'model_user_token_quotas_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_user_token_quotas_pkey ON model_user_token_quotas USING btree (model_id, user_email)',
        },
    },
    { kind: 'table', id: 'model_user_token_quota_requests', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'model_user_token_quotas', definition: { kind: 'r', persistence: 'p' } },
];
