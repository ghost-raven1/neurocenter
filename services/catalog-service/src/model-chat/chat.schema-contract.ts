/** Frozen structural facts for migration 13. */
export const CHAT_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'model_chat_attachments.bytes',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.content',
        definition: { type: 'bytea', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.conversation_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.deleted_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    { kind: 'column', id: 'model_chat_attachments.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_attachments.media_type',
        definition: { type: 'text', default: null, notNull: true },
    },
    { kind: 'column', id: 'model_chat_attachments.name', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_attachments.pages',
        definition: { type: 'integer', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.request_hash',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.request_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    { kind: 'column', id: 'model_chat_attachments.text', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_attachments.text_bytes',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.warning',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_conversations.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'model_chat_conversations.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_conversations.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_conversations.model_pin',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_conversations.owner_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_conversations.project_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_conversations.revision',
        definition: { type: 'integer', default: '1', notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_conversations.title',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_conversations.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'model_chat_turns.answer', definition: { type: 'jsonb', default: null, notNull: false } },
    {
        kind: 'column',
        id: 'model_chat_turns.attachment_ids',
        definition: { type: 'uuid[]', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_turns.conversation_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_turns.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'model_chat_turns.error', definition: { type: 'text', default: null, notNull: false } },
    { kind: 'column', id: 'model_chat_turns.id', definition: { type: 'uuid', default: null, notNull: true } },
    { kind: 'column', id: 'model_chat_turns.input_text', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_turns.lease_until',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    { kind: 'column', id: 'model_chat_turns.position', definition: { type: 'bigint', default: null, notNull: true } },
    { kind: 'column', id: 'model_chat_turns.prompt', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_turns.removed_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    { kind: 'column', id: 'model_chat_turns.request_hash', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'model_chat_turns.request_id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_turns.request_ids',
        definition: { type: 'uuid[]', default: null, notNull: true },
    },
    { kind: 'column', id: 'model_chat_turns.status', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_bytes_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (bytes >= 1 AND bytes <= 10485760)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (text_bytes = octet_length(text))' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_check1',
        definition: {
            type: 'c',
            validated: true,
            definition:
                'CHECK (deleted_at IS NULL AND content IS NOT NULL AND octet_length(content) = bytes OR deleted_at IS NOT NULL AND content IS NULL)',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_conversation_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (conversation_id) REFERENCES model_chat_conversations(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_conversation_id_request_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (conversation_id, request_id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_name_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (length(name) >= 1 AND length(name) <= 255)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_pages_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (pages > 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_request_hash_check',
        definition: { type: 'c', validated: true, definition: "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_text_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (octet_length(text) <= 102400)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_conversations.model_chat_conversations_model_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE RESTRICT',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_conversations.model_chat_conversations_model_pin_check',
        definition: { type: 'c', validated: true, definition: "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_conversations.model_chat_conversations_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_conversations.model_chat_conversations_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_conversations.model_chat_conversations_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_conversations.model_chat_conversations_title_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (length(title) >= 1 AND length(title) <= 128)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_attachment_ids_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (cardinality(attachment_ids) <= 5)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = 'done'::text AND answer IS NOT NULL AND jsonb_typeof(answer) = 'object'::text OR status <> 'done'::text AND answer IS NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_check1',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = 'pending'::text AND lease_until IS NOT NULL OR status <> 'pending'::text AND lease_until IS NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_conversation_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (conversation_id) REFERENCES model_chat_conversations(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_conversation_id_request_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (conversation_id, request_id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_input_text_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (octet_length(input_text) <= 131072)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_prompt_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (octet_length(prompt) <= 131072)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_request_hash_check',
        definition: { type: 'c', validated: true, definition: "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_request_ids_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (cardinality(request_ids) >= 1 AND cardinality(request_ids) <= 100)',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_turns.model_chat_turns_status_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text, 'cancelled'::text]))",
        },
    },
    {
        kind: 'index',
        id: 'model_chat_attachment_scope',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX model_chat_attachment_scope ON model_chat_attachments USING btree (conversation_id, created_at)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_attachments_conversation_id_request_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_attachments_conversation_id_request_id_key ON model_chat_attachments USING btree (conversation_id, request_id)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_attachments_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX model_chat_attachments_pkey ON model_chat_attachments USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_conversations_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_conversations_pkey ON model_chat_conversations USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_owner_scope',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX model_chat_owner_scope ON model_chat_conversations USING btree (owner_email, model_id, project_id, updated_at DESC)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_single_pending',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE UNIQUE INDEX model_chat_single_pending ON model_chat_turns USING btree (conversation_id) WHERE ((status = 'pending'::text) AND (removed_at IS NULL))",
        },
    },
    {
        kind: 'index',
        id: 'model_chat_turn_order',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX model_chat_turn_order ON model_chat_turns USING btree (conversation_id, "position")',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_turns_conversation_id_request_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_turns_conversation_id_request_id_key ON model_chat_turns USING btree (conversation_id, request_id)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_turns_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX model_chat_turns_pkey ON model_chat_turns USING btree (id)',
        },
    },
    { kind: 'table', id: 'model_chat_attachments', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'model_chat_conversations', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'model_chat_turns', definition: { kind: 'r', persistence: 'p' } },
];
