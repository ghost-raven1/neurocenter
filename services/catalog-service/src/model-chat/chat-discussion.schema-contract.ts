/** Migration34 physical facts measured on isolated PostgreSQL16.14; historical schema facts were unchanged. */
export const CHAT_DISCUSSION_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.error',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.finish_reason',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.finished_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.input_hash',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.model_pin',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.output',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.phase',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.request_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.sequence',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.snapshot',
        definition: { type: 'jsonb', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.status',
        definition: { type: 'text', default: "'pending'::text", notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.step_key',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussion_steps.turn_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussions.actor_role',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussions.calls_started',
        definition: { type: 'integer', default: '0', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussions.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussions.deadline_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: true },
    },
    { kind: 'column', id: 'model_chat_discussions.model', definition: { type: 'jsonb', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_discussions.request_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussions.roster',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_discussions.turn_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK ((phase = ANY (ARRAY['response'::text, 'critique'::text])) = (snapshot IS NOT NULL))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_check1',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK ((status = 'pending'::text) = (finished_at IS NULL))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_check2',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK ((status = 'done'::text AND phase <> 'context'::text) = (finish_reason IS NOT NULL))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_check3',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = 'done'::text AND (output IS NOT NULL OR phase = 'context'::text) OR status <> 'done'::text AND output IS NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_error_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (error IS NULL OR octet_length(error) <= 1024)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_finish_reason_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (finish_reason IS NULL OR (finish_reason = ANY (ARRAY['stop'::text, 'length'::text])))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_input_hash_check',
        definition: { type: 'c', validated: true, definition: "CHECK (input_hash ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_model_pin_check',
        definition: { type: 'c', validated: true, definition: "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_output_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (output IS NULL OR octet_length(output) <= 16384)',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_phase_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (phase = ANY (ARRAY['context'::text, 'planning'::text, 'response'::text, 'critique'::text, 'synthesis'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_sequence_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (sequence >= 1 AND sequence <= 5)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_snapshot_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'::text AND octet_length(snapshot::text) <= 262144)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_status_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text, 'cancelled'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_step_key_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (length(step_key) >= 1 AND length(step_key) <= 200)',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_turn_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (turn_id) REFERENCES model_chat_discussions(turn_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_turn_id_sequence_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (turn_id, sequence)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussion_steps.model_chat_discussion_steps_turn_id_step_key_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (turn_id, step_key)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussions.model_chat_discussions_calls_started_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (calls_started >= 0 AND calls_started <= 5)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussions.model_chat_discussions_model_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(model) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussions.model_chat_discussions_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (turn_id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussions.model_chat_discussions_roster_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(roster) = 'array'::text AND jsonb_array_length(roster) >= 1 AND jsonb_array_length(roster) <= 8 AND octet_length(roster::text) <= 2097152)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_discussions.model_chat_discussions_turn_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (turn_id) REFERENCES model_chat_turns(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'function',
        id: 'neurocenter_chat_discussion_immutable()',
        definition: { definitionMd5: '10cc38fe6915dd812243cbf480920770' },
    },
    {
        kind: 'function',
        id: 'neurocenter_chat_discussion_step_immutable()',
        definition: { definitionMd5: 'eedc0039699e25c1f354b35957ff4138' },
    },
    {
        kind: 'index',
        id: 'model_chat_discussion_steps_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_discussion_steps_pkey ON model_chat_discussion_steps USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_discussion_steps_turn_id_sequence_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_discussion_steps_turn_id_sequence_key ON model_chat_discussion_steps USING btree (turn_id, sequence)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_discussion_steps_turn_id_step_key_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_discussion_steps_turn_id_step_key_key ON model_chat_discussion_steps USING btree (turn_id, step_key)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_discussions_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_discussions_pkey ON model_chat_discussions USING btree (turn_id)',
        },
    },
    { kind: 'table', id: 'model_chat_discussion_steps', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'model_chat_discussions', definition: { kind: 'r', persistence: 'p' } },
    {
        kind: 'trigger',
        id: 'model_chat_discussion_steps.model_chat_discussion_step_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER model_chat_discussion_step_immutable BEFORE DELETE OR UPDATE ON model_chat_discussion_steps FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_discussion_step_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'model_chat_discussions.model_chat_discussion_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER model_chat_discussion_immutable BEFORE UPDATE ON model_chat_discussions FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_discussion_immutable()',
        },
    },
];
