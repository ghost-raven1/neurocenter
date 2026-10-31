/** Migration42 physical facts measured on owned PostgreSQL16. */
export const AGENT_TOOLS_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'agent_tool_steps.action',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.actor_role',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.agent_id',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.created_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'clock_timestamp()',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.deadline_at',
        definition: {
            type: 'timestamp with time zone',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.dispatched_at',
        definition: {
            type: 'timestamp with time zone',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.error',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.finished_at',
        definition: {
            type: 'timestamp with time zone',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.generation',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.grant_snapshot',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.input',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.input_hash',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.model_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.model_pin',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.origin_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.output',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.owner_email',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.owner_kind',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.project_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.recipient_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.reference',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.sequence',
        definition: {
            type: 'integer',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.state',
        definition: {
            type: 'text',
            default: "'queued'::text",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.turn_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'agent_tool_steps.updated_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'clock_timestamp()',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'model_chat_turns.agent_tools_request',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.agent_tools_request',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_action_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (action = ANY (ARRAY['planner'::text, 'rag_search'::text, 'rag_read'::text, 'public_chat_search'::text, 'request_system_role'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_actor_role_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (length(actor_role) >= 1 AND length(actor_role) <= 128)',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (deadline_at > created_at AND deadline_at <= (created_at + '00:02:00'::interval))",
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_check1',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (state = 'queued'::text AND dispatched_at IS NULL AND finished_at IS NULL AND output IS NULL OR state = 'dispatched'::text AND dispatched_at IS NOT NULL AND finished_at IS NULL AND output IS NULL OR state = 'succeeded'::text AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL AND output IS NOT NULL OR (state = ANY (ARRAY['failed'::text, 'unknown'::text, 'cancelled'::text])) AND finished_at IS NOT NULL AND output IS NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_error_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (octet_length(error) <= 1000)',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_grant_snapshot_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (agent_tool_grant_valid(grant_snapshot))',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_input_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(input) = 'object'::text AND octet_length(input::text) <= 16384)",
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_input_hash_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (input_hash ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_model_pin_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_output_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (output IS NULL OR octet_length(output::text) <= 32768)',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_owner_email_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (length(owner_email) >= 1 AND length(owner_email) <= 320)',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_owner_kind_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (owner_kind = ANY (ARRAY['model-chat'::text, 'project-chat'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_owner_kind_turn_id_recipient_id_generation_key',
        definition: {
            type: 'u',
            validated: true,
            definition: 'UNIQUE (owner_kind, turn_id, recipient_id, generation, sequence)',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (id)',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_reference_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (reference IS NULL OR jsonb_typeof(reference) = 'object'::text AND octet_length(reference::text) <= 4096)",
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_sequence_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (sequence >= 1 AND sequence <= 6)',
        },
    },
    {
        kind: 'constraint',
        id: 'agent_tool_steps.agent_tool_steps_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (state = ANY (ARRAY['queued'::text, 'dispatched'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text, 'cancelled'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.agent_tool_model_grant_shape',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (agent_tools_request IS NULL OR agent_tool_grant_valid(agent_tools_request))',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.agent_tool_project_grant_shape',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (agent_tools_request IS NULL OR agent_tool_grant_valid(agent_tools_request))',
        },
    },
    {
        kind: 'function',
        id: 'agent_tool_grant_immutable()',
        definition: {
            definitionMd5: '9bd5a082c69f27505c18d56b8604f7e7',
        },
    },
    {
        kind: 'function',
        id: 'agent_tool_grant_valid(v jsonb)',
        definition: {
            definitionMd5: 'aa52a75d358228ed351c0ed711ae647e',
        },
    },
    {
        kind: 'function',
        id: 'agent_tool_step_guard()',
        definition: {
            definitionMd5: 'b43873e50eb961872a98d8e8a54e5a3c',
        },
    },
    {
        kind: 'index',
        id: 'agent_tool_expiry',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE INDEX agent_tool_expiry ON agent_tool_steps USING btree (deadline_at) WHERE (state = ANY (ARRAY['queued'::text, 'dispatched'::text]))",
        },
    },
    {
        kind: 'index',
        id: 'agent_tool_owner_history',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX agent_tool_owner_history ON agent_tool_steps USING btree (owner_email, project_id, turn_id, created_at DESC, id)',
        },
    },
    {
        kind: 'index',
        id: 'agent_tool_steps_owner_kind_turn_id_recipient_id_generation_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX agent_tool_steps_owner_kind_turn_id_recipient_id_generation_key ON agent_tool_steps USING btree (owner_kind, turn_id, recipient_id, generation, sequence)',
        },
    },
    {
        kind: 'index',
        id: 'agent_tool_steps_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX agent_tool_steps_pkey ON agent_tool_steps USING btree (id)',
        },
    },
    {
        kind: 'table',
        id: 'agent_tool_steps',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
    {
        kind: 'trigger',
        id: 'agent_tool_steps.agent_tool_step_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER agent_tool_step_guard BEFORE INSERT OR UPDATE ON agent_tool_steps FOR EACH ROW EXECUTE FUNCTION agent_tool_step_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'model_chat_turns.agent_tool_model_grant',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER agent_tool_model_grant BEFORE UPDATE OF agent_tools_request ON model_chat_turns FOR EACH ROW EXECUTE FUNCTION agent_tool_grant_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_chat_messages.agent_tool_project_grant',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER agent_tool_project_grant BEFORE UPDATE OF agent_tools_request ON project_chat_messages FOR EACH ROW EXECUTE FUNCTION agent_tool_grant_immutable()',
        },
    },
];
