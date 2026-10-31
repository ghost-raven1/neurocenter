/** Migration 27 physical facts measured on caller-owned PostgreSQL 16.15. */
export const PACKAGE_AGENT_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'tool_build_agent_steps.build_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.execution_nonce',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.attempt',
        definition: { type: 'smallint', default: null, notNull: true },
    },
    { kind: 'column', id: 'tool_build_agent_steps.stage', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'tool_build_agent_steps.state', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.model_pin',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.input_hash',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.recipe',
        definition: { type: 'jsonb', default: "'{}'::jsonb", notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.diagnostics',
        definition: { type: 'jsonb', default: "'{}'::jsonb", notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.error_code',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.started_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_agent_steps.finished_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_attempt_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (attempt >= 1 AND attempt <= 3)' },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_stage_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (stage = ANY (ARRAY['propose'::text, 'review'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (state = ANY (ARRAY['STARTED'::text, 'SUCCEEDED'::text, 'FAILED'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_model_pin_check',
        definition: { type: 'c', validated: true, definition: "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_input_hash_check',
        definition: { type: 'c', validated: true, definition: "CHECK (input_hash ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_recipe_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(recipe) = 'object'::text AND octet_length(recipe::text) <= 2048)",
        },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_diagnostics_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(diagnostics) = 'object'::text AND octet_length(diagnostics::text) <= 2048)",
        },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_error_code_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (error_code IS NULL OR (error_code = ANY (ARRAY['inference-failed'::text, 'invalid-response'::text])))",
        },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_build_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (build_id) REFERENCES tool_build_jobs(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'tool_build_agent_steps.tool_build_agent_steps_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (build_id, attempt, stage)' },
    },
    {
        kind: 'index',
        id: 'tool_build_agent_steps_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX tool_build_agent_steps_pkey ON tool_build_agent_steps USING btree (build_id, attempt, stage)',
        },
    },
    { kind: 'table', id: 'tool_build_agent_steps', definition: { kind: 'r', persistence: 'p' } },
] as const;

export const PACKAGE_BUILD_RUNTIME_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'tool_build_runtime_checks.build_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_runtime_checks.attempt',
        definition: { type: 'smallint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_runtime_checks.execution_nonce',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_runtime_checks.report',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'tool_build_runtime_checks.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'constraint',
        id: 'tool_build_runtime_checks.tool_build_runtime_checks_build_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (build_id) REFERENCES tool_build_jobs(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'tool_build_runtime_checks.tool_build_runtime_checks_attempt_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (attempt >= 1 AND attempt <= 3)' },
    },
    {
        kind: 'constraint',
        id: 'tool_build_runtime_checks.tool_build_runtime_checks_report_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(report) = 'object'::text AND report @> '{\"schemaVersion\": 1}'::jsonb AND octet_length(report::text) <= 65536)",
        },
    },
    {
        kind: 'constraint',
        id: 'tool_build_runtime_checks.tool_build_runtime_checks_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (build_id, attempt)' },
    },
    {
        kind: 'index',
        id: 'tool_build_runtime_checks_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX tool_build_runtime_checks_pkey ON tool_build_runtime_checks USING btree (build_id, attempt)',
        },
    },
    { kind: 'table', id: 'tool_build_runtime_checks', definition: { kind: 'r', persistence: 'p' } },
] as const;
