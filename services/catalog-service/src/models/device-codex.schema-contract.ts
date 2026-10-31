/** Migration29 physical facts measured on owned isolated PostgreSQL16.15. */
export const DEVICE_CODEX_SCHEMA_CONTRACT = [
    { kind: 'column', id: 'device_model_calls.actor_role', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'device_model_calls.cancelled_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'device_model_calls.completed_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'device_model_calls.connection_revision',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'device_model_calls.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'device_model_calls.deadline_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: true },
    },
    { kind: 'column', id: 'device_model_calls.device_id', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'device_model_calls.dispatched_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    { kind: 'column', id: 'device_model_calls.id', definition: { type: 'uuid', default: null, notNull: true } },
    { kind: 'column', id: 'device_model_calls.job_id', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'device_model_calls.model_id', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'device_model_calls.model_pin', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'device_model_calls.owner_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'device_model_calls.project_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    { kind: 'column', id: 'device_model_calls.request', definition: { type: 'jsonb', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'device_model_calls.required_features',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'device_model_calls.response_digest',
        definition: { type: 'text', default: null, notNull: false },
    },
    { kind: 'column', id: 'device_model_calls.result', definition: { type: 'jsonb', default: null, notNull: false } },
    {
        kind: 'column',
        id: 'device_model_calls.runtime_model',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.connector_package',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.device_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.expected_candidate',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.options',
        definition: { type: 'jsonb', default: "'{}'::jsonb", notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.owner_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.revision',
        definition: { type: 'integer', default: '1', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.revoked_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_device_connections.semantic_sha',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_device_connections.source',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'constraint',
        id: 'device_model_calls.device_model_calls_connection_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (connection_revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'device_model_calls.device_model_calls_device_id_fkey',
        definition: { type: 'f', validated: true, definition: 'FOREIGN KEY (device_id) REFERENCES bridge_devices(id)' },
    },
    {
        kind: 'constraint',
        id: 'device_model_calls.device_model_calls_job_id_fkey',
        definition: { type: 'f', validated: true, definition: 'FOREIGN KEY (job_id) REFERENCES bridge_jobs(id)' },
    },
    {
        kind: 'constraint',
        id: 'device_model_calls.device_model_calls_job_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (job_id)' },
    },
    {
        kind: 'constraint',
        id: 'device_model_calls.device_model_calls_model_id_fkey',
        definition: { type: 'f', validated: true, definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id)' },
    },
    {
        kind: 'constraint',
        id: 'device_model_calls.device_model_calls_model_pin_check',
        definition: { type: 'c', validated: true, definition: "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'device_model_calls.device_model_calls_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'device_model_calls.device_model_calls_response_digest_check',
        definition: { type: 'c', validated: true, definition: "CHECK (response_digest ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_device_connections.model_device_connections_device_id_fkey',
        definition: { type: 'f', validated: true, definition: 'FOREIGN KEY (device_id) REFERENCES bridge_devices(id)' },
    },
    {
        kind: 'constraint',
        id: 'model_device_connections.model_device_connections_model_id_fkey',
        definition: { type: 'f', validated: true, definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id)' },
    },
    {
        kind: 'constraint',
        id: 'model_device_connections.model_device_connections_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (model_id)' },
    },
    {
        kind: 'constraint',
        id: 'model_device_connections.model_device_connections_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_device_connections.model_device_connections_semantic_sha_check',
        definition: { type: 'c', validated: true, definition: "CHECK (semantic_sha ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'index',
        id: 'device_model_calls_device',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX device_model_calls_device ON device_model_calls USING btree (device_id, created_at)',
        },
    },
    {
        kind: 'index',
        id: 'device_model_calls_job_id_key',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX device_model_calls_job_id_key ON device_model_calls USING btree (job_id)',
        },
    },
    {
        kind: 'index',
        id: 'device_model_calls_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX device_model_calls_pkey ON device_model_calls USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'model_device_connections_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_device_connections_pkey ON model_device_connections USING btree (model_id)',
        },
    },
    { kind: 'table', id: 'device_model_calls', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'model_device_connections', definition: { kind: 'r', persistence: 'p' } },
];
