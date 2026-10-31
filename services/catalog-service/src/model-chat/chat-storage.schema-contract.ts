/** Frozen S3 attachment storage facts for migration 15. */
export const CHAT_STORAGE_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'model_chat_attachment_transfers.attachment_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachment_transfers.bytes',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachment_transfers.content',
        definition: { type: 'bytea', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachment_transfers.sha256',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.object_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_attachments.storage_state',
        definition: { type: 'text', default: "'S3'::text", notNull: true },
    },
    { kind: 'column', id: 'model_chat_objects.attempts', definition: { type: 'integer', default: '0', notNull: true } },
    { kind: 'column', id: 'model_chat_objects.bucket', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'model_chat_objects.bytes', definition: { type: 'integer', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_objects.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'model_chat_objects.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_objects.last_error',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_objects.lease_until',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'model_chat_objects.next_attempt_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'model_chat_objects.object_key', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'model_chat_objects.sha256', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'model_chat_objects.state', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'model_chat_objects.storage_id', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'model_chat_objects.version_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachment_transfers.model_chat_attachment_transfers_attachment_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (attachment_id) REFERENCES model_chat_attachments(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachment_transfers.model_chat_attachment_transfers_bytes_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (bytes >= 1 AND bytes <= 10485760)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachment_transfers.model_chat_attachment_transfers_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (octet_length(content) = bytes)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachment_transfers.model_chat_attachment_transfers_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (attachment_id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachment_transfers.model_chat_attachment_transfers_sha256_check',
        definition: { type: 'c', validated: true, definition: "CHECK (sha256 ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachment_storage_state',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (deleted_at IS NULL AND storage_state = 'S3'::text AND object_id IS NOT NULL OR deleted_at IS NULL AND storage_state = 'TRANSFER'::text AND object_id IS NULL OR deleted_at IS NOT NULL AND storage_state = 'DELETED'::text AND object_id IS NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_attachments.model_chat_attachments_object_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (object_id) REFERENCES model_chat_objects(id) ON DELETE RESTRICT',
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_objects.model_chat_objects_attempts_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (attempts >= 0)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_objects.model_chat_objects_bytes_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (bytes >= 1 AND bytes <= 10485760)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_objects.model_chat_objects_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (state = 'STAGING'::text AND lease_until IS NOT NULL OR state <> 'STAGING'::text AND lease_until IS NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_objects.model_chat_objects_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_objects.model_chat_objects_sha256_check',
        definition: { type: 'c', validated: true, definition: "CHECK (sha256 ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'model_chat_objects.model_chat_objects_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (state = ANY (ARRAY['STAGING'::text, 'LIVE'::text, 'DELETE'::text, 'DELETED'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'model_chat_objects.model_chat_objects_storage_id_bucket_object_key_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (storage_id, bucket, object_key)' },
    },
    {
        kind: 'constraint',
        id: 'model_chat_objects.model_chat_objects_storage_id_check',
        definition: { type: 'c', validated: true, definition: "CHECK (storage_id ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'function',
        id: 'model_chat_queue_object_delete()',
        definition: { definitionMd5: '501a8e7295a5478d439399d3c56ff3dd' },
    },
    {
        kind: 'index',
        id: 'model_chat_attachment_object',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_attachment_object ON model_chat_attachments USING btree (object_id) WHERE (object_id IS NOT NULL)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_attachment_transfers_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_attachment_transfers_pkey ON model_chat_attachment_transfers USING btree (attachment_id)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_object_cleanup',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX model_chat_object_cleanup ON model_chat_objects USING btree (state, next_attempt_at)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_objects_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX model_chat_objects_pkey ON model_chat_objects USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'model_chat_objects_storage_id_bucket_object_key_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX model_chat_objects_storage_id_bucket_object_key_key ON model_chat_objects USING btree (storage_id, bucket, object_key)',
        },
    },
    { kind: 'table', id: 'model_chat_attachment_transfers', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'model_chat_objects', definition: { kind: 'r', persistence: 'p' } },
    {
        kind: 'trigger',
        id: 'model_chat_attachments.model_chat_attachment_delete_object',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER model_chat_attachment_delete_object BEFORE DELETE OR UPDATE OF object_id ON model_chat_attachments FOR EACH ROW EXECUTE FUNCTION model_chat_queue_object_delete()',
        },
    },
];
