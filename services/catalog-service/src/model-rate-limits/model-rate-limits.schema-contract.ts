/** Migration24 physical facts, measured on isolated PostgreSQL16.15. */
export const MODEL_RATE_LIMITS_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'model_api_dispatch_slots.dispatched_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: true },
    },
    { kind: 'column', id: 'model_api_dispatch_slots.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_api_dispatch_slots.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_api_rate_limits.enabled',
        definition: { type: 'boolean', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_api_rate_limits.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_api_rate_limits.requests',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_api_rate_limits.revision',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_api_rate_limits.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_api_rate_limits.updated_by',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_api_rate_limits.window_ms',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.dispatch_count',
        definition: { type: 'integer', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.dispatched_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.failure_code',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.provider_latency_ms',
        definition: { type: 'bigint', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_usage_calls.rate_wait_ms',
        definition: { type: 'bigint', default: null, notNull: false },
    },
    {
        kind: 'constraint',
        id: 'model_api_dispatch_slots.model_api_dispatch_slots_model_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_api_dispatch_slots.model_api_dispatch_slots_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'model_api_rate_limits.model_api_rate_limits_model_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_api_rate_limits.model_api_rate_limits_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (model_id)' },
    },
    {
        kind: 'constraint',
        id: 'model_api_rate_limits.model_api_rate_limits_requests_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (requests >= 1 AND requests <= 1000)' },
    },
    {
        kind: 'constraint',
        id: 'model_api_rate_limits.model_api_rate_limits_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_api_rate_limits.model_api_rate_limits_window_ms_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (window_ms >= 1000 AND window_ms <= 86400000)' },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_dispatch_count_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (dispatch_count >= 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_failure_code_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (failure_code = ANY (ARRAY['cancelled'::text, 'rate_wait_timeout'::text, 'rate_store_unavailable'::text, 'permission_denied'::text, 'feature_disabled'::text, 'provider_error'::text, 'internal_error'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_provider_latency_ms_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (provider_latency_ms >= 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_rate_wait_ms_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (rate_wait_ms >= 0)' },
    },
    {
        kind: 'index',
        id: 'model_api_dispatch_slots_model_time',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX model_api_dispatch_slots_model_time ON model_api_dispatch_slots USING btree (model_id, dispatched_at DESC)',
        },
    },
    {
        kind: 'index',
        id: 'model_api_dispatch_slots_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_api_dispatch_slots_pkey ON model_api_dispatch_slots USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'model_api_rate_limits_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_api_rate_limits_pkey ON model_api_rate_limits USING btree (model_id)',
        },
    },
    {
        kind: 'index',
        id: 'model_usage_calls_endpoint_time',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX model_usage_calls_endpoint_time ON model_usage_calls USING btree (endpoint, started_at DESC, id DESC)',
        },
    },
    { kind: 'table', id: 'model_api_dispatch_slots', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'model_api_rate_limits', definition: { kind: 'r', persistence: 'p' } },
];
