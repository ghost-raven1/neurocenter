/** Frozen physical research facts for migration 19, verified against actual PostgreSQL. */
export const CHAT_RESEARCH_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'model_chat_research_steps.attempt',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.conversation_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.error',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.finished_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    { kind: 'column', id: 'model_chat_research_steps.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_research_steps.input',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.kind',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.output',
        definition: { type: 'text', default: "''::text", notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.request_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.response_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.sequence',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.sources',
        definition: { type: 'jsonb', default: "'[]'::jsonb", notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.status',
        definition: { type: 'text', default: "'pending'::text", notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.turn_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_research_steps.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_turns.research_request',
        definition: { type: 'jsonb', default: null, notNull: false },
    },
    {
        kind: 'constraint',
        id: 'model_chat_agent_responses.model_chat_agent_responses_processing_stage_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (processing_stage = ANY (ARRAY['compacting'::text, 'responding'::text, 'researching'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_attempt_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (attempt >= 1 AND attempt <= 100)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = 'pending'::text AND finished_at IS NULL OR status <> 'pending'::text AND finished_at IS NOT NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_check1',
        definition: { type: 'c', validated: true, definition: "CHECK (status <> 'done'::text OR error IS NULL)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_conversation_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (conversation_id) REFERENCES model_chat_conversations(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_error_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (octet_length(error) <= 2048)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_input_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(input) = 'object'::text AND octet_length(input::text) <= 8192 AND (input - ARRAY['query'::text, 'sourceId'::text, 'path'::text, 'startLine'::text, 'endLine'::text, 'tool'::text, 'arguments'::text, 'modelId'::text, 'modelPin'::text]) = '{}'::jsonb)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_kind_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (kind = ANY (ARRAY['planner'::text, 'project_search'::text, 'project_read'::text, 'external_search'::text, 'external_fetch'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_output_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (octet_length(output) <= 65536)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_response_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (response_id) REFERENCES model_chat_agent_responses(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_sequence_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (sequence >= 1 AND sequence <= 6)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_sources_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(sources) = 'array'::text AND jsonb_array_length(sources) <= 32 AND octet_length(sources::text) <= 65536)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_status_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text, 'cancelled'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_turn_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (turn_id) REFERENCES model_chat_turns(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_research_steps.model_chat_research_steps_turn_id_response_id_attempt_seque_key',
        definition: {
            type: 'u',
            validated: true,
            definition: 'UNIQUE NULLS NOT DISTINCT (turn_id, response_id, attempt, sequence)',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_research_request_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (research_request IS NULL OR COALESCE(jsonb_typeof(research_request) = 'object'::text AND (research_request - ARRAY['project'::text, 'external'::text]) = '{}'::jsonb AND jsonb_typeof(research_request -> 'project'::text) = 'boolean'::text AND ((research_request ->> 'project'::text) = 'true'::text OR research_request ? 'external'::text) AND (NOT research_request ? 'external'::text OR jsonb_typeof(research_request -> 'external'::text) = 'object'::text AND ((research_request -> 'external'::text) - ARRAY['assetId'::text, 'version'::text, 'manifest'::text]) = '{}'::jsonb AND jsonb_typeof((research_request -> 'external'::text) -> 'assetId'::text) = 'string'::text AND length((research_request -> 'external'::text) ->> 'assetId'::text) >= 1 AND length((research_request -> 'external'::text) ->> 'assetId'::text) <= 256 AND jsonb_typeof((research_request -> 'external'::text) -> 'version'::text) = 'number'::text AND ((research_request -> 'external'::text) ->> 'version'::text) ~ '^[1-9][0-9]{0,14}$'::text AND ((research_request -> 'external'::text) ->> 'manifest'::text) ~ '^[a-f0-9]{64}$'::text), false))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_processing_stage_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (processing_stage = ANY (ARRAY['compacting'::text, 'responding'::text, 'researching'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_usage_calls.model_usage_calls_purpose_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (purpose = ANY (ARRAY['chat'::text, 'agent'::text, 'compaction'::text, 'project-search'::text, 'device-embedding'::text, 'reindex'::text, 'learning'::text, 'direct'::text, 'verification'::text, 'research'::text]))",
        },
    },
    {
        kind: 'function',
        id: 'model_chat_research_request_immutable()',
        definition: { definitionMd5: 'e33a72e02a1297ed3657811fd37cbd6b' },
    },
    {
        kind: 'function',
        id: 'model_chat_research_step_binding()',
        definition: { definitionMd5: '01b37423fbffb61623731b465c37ee74' },
    },
    {
        kind: 'function',
        id: 'model_chat_research_stop_pending()',
        definition: { definitionMd5: '4be96f52eb9cd160fc50bf367f5fceb6' },
    },
    {
        kind: 'index',
        id: 'model_chat_research_history',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX model_chat_research_history ON model_chat_research_steps USING btree (conversation_id, turn_id, attempt, sequence)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_research_single_pending',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE UNIQUE INDEX model_chat_research_single_pending ON model_chat_research_steps USING btree (turn_id, response_id, attempt) NULLS NOT DISTINCT WHERE (status = 'pending'::text)",
        },
    },
    {
        kind: 'index',
        id: 'model_chat_research_steps_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_research_steps_pkey ON model_chat_research_steps USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_research_steps_turn_id_response_id_attempt_seque_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_research_steps_turn_id_response_id_attempt_seque_key ON model_chat_research_steps USING btree (turn_id, response_id, attempt, sequence) NULLS NOT DISTINCT',
        },
    },
    { kind: 'table', id: 'model_chat_research_steps', definition: { kind: 'r', persistence: 'p' } },
    {
        kind: 'trigger',
        id: 'model_chat_agent_responses.model_chat_research_stop_pending',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER model_chat_research_stop_pending AFTER UPDATE OF status, request_id ON model_chat_agent_responses FOR EACH ROW EXECUTE FUNCTION model_chat_research_stop_pending()',
        },
    },
    {
        kind: 'trigger',
        id: 'model_chat_research_steps.model_chat_research_step_binding',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER model_chat_research_step_binding BEFORE INSERT OR UPDATE ON model_chat_research_steps FOR EACH ROW EXECUTE FUNCTION model_chat_research_step_binding()',
        },
    },
    {
        kind: 'trigger',
        id: 'model_chat_turns.model_chat_research_request_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER model_chat_research_request_immutable BEFORE UPDATE OF research_request ON model_chat_turns FOR EACH ROW EXECUTE FUNCTION model_chat_research_request_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'model_chat_turns.model_chat_research_stop_pending',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER model_chat_research_stop_pending AFTER UPDATE OF status, request_id ON model_chat_turns FOR EACH ROW EXECUTE FUNCTION model_chat_research_stop_pending()',
        },
    },
] as const;
