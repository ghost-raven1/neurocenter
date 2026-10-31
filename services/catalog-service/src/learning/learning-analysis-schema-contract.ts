/** Frozen structural facts for durable project analysis jobs, migration 10. */
export const LEARNING_ANALYSIS_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'project_learning_analyses.actor_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.actor_role',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.error_code',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.error_message',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.experiences',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.finished_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.hypothesis_ids',
        definition: { type: 'jsonb', default: "'[]'::jsonb", notNull: true },
    },
    { kind: 'column', id: 'project_learning_analyses.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'project_learning_analyses.input',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.lease_until',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.model_epoch',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.model_pin',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.mutation_key',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.request_hash',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.request_key',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.source_revision',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.started_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.state',
        definition: { type: 'text', default: "'queued'::text", notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_analyses.worker_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_actor_email_request_key_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (actor_email, request_key)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK ((state = 'running'::text) = (worker_id IS NOT NULL AND lease_until IS NOT NULL))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_check1',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK ((state <> ALL (ARRAY['completed'::text, 'failed'::text, 'unknown'::text])) OR finished_at IS NOT NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_check2',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK ((state = 'completed'::text) = (jsonb_array_length(hypothesis_ids) > 0))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_experiences_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(experiences) = 'array'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_hypothesis_ids_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(hypothesis_ids) = 'array'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_input_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(input) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_model_pin_check',
        definition: { type: 'c', validated: true, definition: "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_mutation_key_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (mutation_key)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_learning_state(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_request_hash_check',
        definition: { type: 'c', validated: true, definition: "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_source_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (source_revision >= 0)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_analyses.project_learning_analyses_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (state = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'unknown'::text]))",
        },
    },
    {
        kind: 'function',
        id: 'neurocenter_learning_analysis_immutable()',
        definition: { definitionMd5: '33d4a4fdcf6152aee2b21306e2aa41fa' },
    },
    {
        kind: 'index',
        id: 'project_learning_analyses_actor_email_request_key_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_analyses_actor_email_request_key_key ON project_learning_analyses USING btree (actor_email, request_key)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_analyses_mutation_key_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_analyses_mutation_key_key ON project_learning_analyses USING btree (mutation_key)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_analyses_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_analyses_pkey ON project_learning_analyses USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_analysis_queue',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE INDEX project_learning_analysis_queue ON project_learning_analyses USING btree (created_at, id) WHERE (state = 'queued'::text)",
        },
    },
    {
        kind: 'index',
        id: 'project_learning_one_analysis',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE UNIQUE INDEX project_learning_one_analysis ON project_learning_analyses USING btree (project_id) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text]))",
        },
    },
    { kind: 'table', id: 'project_learning_analyses', definition: { kind: 'r', persistence: 'p' } },
    {
        kind: 'trigger',
        id: 'project_learning_analyses.neurocenter_learning_analysis_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_learning_analysis_immutable BEFORE DELETE OR UPDATE ON project_learning_analyses FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_analysis_immutable()',
        },
    },
] as const;
