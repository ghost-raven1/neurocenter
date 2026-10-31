/** Frozen structural facts for migration 12. */
export const REMOTE_OPTIONS_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'model_remote_connections.options',
        definition: { type: 'jsonb', default: "'{}'::jsonb", notNull: true },
    },
    {
        kind: 'column',
        id: 'model_remote_connections.timeout_ms',
        definition: { type: 'integer', default: '90000', notNull: true },
    },
    {
        kind: 'constraint',
        id: 'model_remote_connections.model_remote_connections_options_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(options) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_remote_connections.model_remote_connections_timeout_ms_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (timeout_ms >= 1000 AND timeout_ms <= 300000)' },
    },
];
