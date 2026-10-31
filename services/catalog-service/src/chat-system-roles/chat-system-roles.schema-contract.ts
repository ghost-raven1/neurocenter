/** Migration40 physical facts measured on owned PostgreSQL16. */
export const CHAT_SYSTEM_ROLE_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'chat_system_role_origins.created_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'now()',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'chat_system_role_origins.dialog_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'chat_system_role_origins.origin_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'chat_system_role_origins.origin_kind',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'chat_system_role_origins.owner_email',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'chat_system_role_origins.project_id',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'constraint',
        id: 'chat_system_role_origins.chat_system_role_origins_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (origin_kind <> 'project-chat'::text OR project_id IS NOT NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'chat_system_role_origins.chat_system_role_origins_dialog_id_owner_email_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (dialog_id, owner_email) REFERENCES system_role_dialogs(id, owner_email) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'chat_system_role_origins.chat_system_role_origins_origin_kind_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (origin_kind = ANY (ARRAY['model-chat'::text, 'project-chat'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'chat_system_role_origins.chat_system_role_origins_owner_email_origin_kind_origin_id__key',
        definition: {
            type: 'u',
            validated: true,
            definition: 'UNIQUE NULLS NOT DISTINCT (owner_email, origin_kind, origin_id, project_id)',
        },
    },
    {
        kind: 'constraint',
        id: 'chat_system_role_origins.chat_system_role_origins_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (dialog_id)',
        },
    },
    {
        kind: 'function',
        id: 'chat_system_role_origin_guard()',
        definition: {
            definitionMd5: '9ea01fbea0b66f3eff3e49658625005a',
        },
    },
    {
        kind: 'index',
        id: 'chat_system_role_origins_owner_email_origin_kind_origin_id__key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX chat_system_role_origins_owner_email_origin_kind_origin_id__key ON chat_system_role_origins USING btree (owner_email, origin_kind, origin_id, project_id) NULLS NOT DISTINCT',
        },
    },
    {
        kind: 'index',
        id: 'chat_system_role_origins_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX chat_system_role_origins_pkey ON chat_system_role_origins USING btree (dialog_id)',
        },
    },
    {
        kind: 'table',
        id: 'chat_system_role_origins',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
    {
        kind: 'trigger',
        id: 'chat_system_role_origins.chat_system_role_origin_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER chat_system_role_origin_guard BEFORE UPDATE ON chat_system_role_origins FOR EACH ROW EXECUTE FUNCTION chat_system_role_origin_guard()',
        },
    },
];
