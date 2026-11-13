import { CURRENT_PROJECT_CHAT_SHARED_SCHEMA_CONTRACT } from './project-chat-shared.schema-contract';

/** Migration58 physical facts measured on the owned PostgreSQL 16 QA instance. */
export const PROJECT_CHAT_SYSTEM_CALL_SCHEMA_CONTRACT = [
    {
        kind: 'table',
        id: 'project_chat_system_calls',
        definition: { kind: 'r', persistence: 'p' },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.room_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.call_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.actor_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.actor_role',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.source_message_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.response_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.response_generation',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.agent_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.agent_name',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.snapshot',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.role_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.reason',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.question',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.run_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.request_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.state',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.run_state',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.error',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_system_calls.delivered_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'constraint',
        id: 'project_chat_system_calls.project_chat_system_calls_agent_id_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (length(agent_id) >= 1 AND length(agent_id) <= 200)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_system_calls.project_chat_system_calls_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (project_id, room_id, call_id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_system_calls.project_chat_system_calls_project_id_room_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, room_id) REFERENCES project_chat_rooms(project_id, id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_system_calls.project_chat_system_calls_question_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (octet_length(question) >= 1 AND octet_length(question) <= 2048)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_system_calls.project_chat_system_calls_reason_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (reason = ANY (ARRAY['problem'::text, 'clarification'::text, 'recovery'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_system_calls.project_chat_system_calls_role_id_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (length(role_id) >= 1 AND length(role_id) <= 200)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_system_calls.project_chat_system_calls_snapshot_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(snapshot) = 'object'::text AND octet_length(snapshot::text) <= 262144)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_system_calls.project_chat_system_calls_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (state = ANY (ARRAY['invoked'::text, 'rejected'::text, 'delivered'::text, 'failed'::text]))",
        },
    },
    {
        kind: 'index',
        id: 'project_chat_system_calls_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_chat_system_calls_pkey ON project_chat_system_calls USING btree (project_id, room_id, call_id)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_system_calls_room',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_chat_system_calls_room ON project_chat_system_calls USING btree (project_id, room_id, created_at DESC)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_system_calls_run',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE INDEX project_chat_system_calls_run ON project_chat_system_calls USING btree (run_id)',
        },
    },
    {
        kind: 'function',
        id: 'neurocenter_project_chat_system_call_immutable()',
        definition: { definitionMd5: '73c065fad76addc0ae59e3637a5b7099' },
    },
    {
        kind: 'trigger',
        id: 'project_chat_system_calls.project_chat_system_call_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER project_chat_system_call_immutable BEFORE UPDATE ON project_chat_system_calls FOR EACH ROW EXECUTE FUNCTION neurocenter_project_chat_system_call_immutable()',
        },
    },
];

export const CURRENT_PROJECT_CHAT_SYSTEM_CALL_SCHEMA_CONTRACT = [
    ...CURRENT_PROJECT_CHAT_SHARED_SCHEMA_CONTRACT,
    ...PROJECT_CHAT_SYSTEM_CALL_SCHEMA_CONTRACT,
];
