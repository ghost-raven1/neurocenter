/** Migration45 facts measured on the owned PostgreSQL16.15 fixture. */
export const METHOD_CHAT_WORKFLOWS_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'project_chat_method_workflows.created_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'now()',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_method_workflows.job_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_method_workflows.owner_email',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_method_workflows.owner_role',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_method_workflows.project_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_method_workflows.public_result',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_method_workflows.publication_state',
        definition: {
            type: 'text',
            default: "'pending'::text",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_method_workflows.room_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_method_workflows.source_message_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_method_workflows.method_chat_publication',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (publication_state = 'published'::text OR public_result IS NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_method_workflows.method_chat_source',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, room_id, source_message_id) REFERENCES project_chat_messages(project_id, room_id, id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_method_workflows.project_chat_method_workflows_job_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (job_id) REFERENCES bridge_jobs(id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_method_workflows.project_chat_method_workflows_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (job_id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_method_workflows.project_chat_method_workflows_public_result_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (public_result IS NULL OR jsonb_typeof(public_result) = 'object'::text AND octet_length(public_result::text) <= 524288)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_method_workflows.project_chat_method_workflows_publication_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (publication_state = ANY (ARRAY['pending'::text, 'published'::text, 'withheld'::text]))",
        },
    },
    {
        kind: 'function',
        id: 'neurocenter_method_chat_origin_immutable()',
        definition: {
            definitionMd5: '434a3892a7f17a83f1a252379bd3a5c3',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_method_source',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_chat_method_source ON project_chat_method_workflows USING btree (project_id, room_id, source_message_id, created_at, job_id)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_method_workflows_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_chat_method_workflows_pkey ON project_chat_method_workflows USING btree (job_id)',
        },
    },
    {
        kind: 'table',
        id: 'project_chat_method_workflows',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
    {
        kind: 'trigger',
        id: 'project_chat_method_workflows.method_chat_origin_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER method_chat_origin_immutable BEFORE UPDATE ON project_chat_method_workflows FOR EACH ROW EXECUTE FUNCTION neurocenter_method_chat_origin_immutable()',
        },
    },
];
