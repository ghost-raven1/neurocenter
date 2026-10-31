/** Migration26 physical facts, measured on isolated PostgreSQL16.15. */
export const CHAT_ACTIVITY_SCHEMA_CONTRACT = [
    { kind: 'column', id: 'chat_presence_sessions.email', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'chat_presence_sessions.online_until',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'chat_presence_sessions.retain_until',
        definition: { type: 'timestamp with time zone', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'chat_presence_sessions.sequence',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'chat_presence_sessions.session_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_read_receipts.message_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_read_receipts.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_read_receipts.reader_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_read_receipts.room_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_read_receipts.viewed_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_typing_sessions.email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_typing_sessions.project_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_typing_sessions.retain_until',
        definition: { type: 'timestamp with time zone', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_typing_sessions.room_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_typing_sessions.sequence',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_typing_sessions.session_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_typing_sessions.typing_until',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'constraint',
        id: 'chat_presence_sessions.chat_presence_sessions_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (online_until IS NULL OR online_until <= retain_until)',
        },
    },
    {
        kind: 'constraint',
        id: 'chat_presence_sessions.chat_presence_sessions_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (email, session_id)' },
    },
    {
        kind: 'constraint',
        id: 'chat_presence_sessions.chat_presence_sessions_sequence_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (sequence > 0)' },
    },
    {
        kind: 'constraint',
        id: 'project_chat_read_receipts.project_chat_read_receipts_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (project_id, room_id, message_id, reader_email)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_read_receipts.project_chat_read_receipts_project_id_room_id_message_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, room_id, message_id) REFERENCES project_chat_messages(project_id, room_id, id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_typing_sessions.project_chat_typing_sessions_check',
        definition: { type: 'c', validated: true, definition: 'CHECK ((project_id IS NULL) = (room_id IS NULL))' },
    },
    {
        kind: 'constraint',
        id: 'project_chat_typing_sessions.project_chat_typing_sessions_check1',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (typing_until IS NULL OR project_id IS NOT NULL AND typing_until <= retain_until)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_typing_sessions.project_chat_typing_sessions_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (email, session_id)' },
    },
    {
        kind: 'constraint',
        id: 'project_chat_typing_sessions.project_chat_typing_sessions_project_id_room_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, room_id) REFERENCES project_chat_rooms(project_id, id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_typing_sessions.project_chat_typing_sessions_sequence_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (sequence > 0)' },
    },
    {
        kind: 'index',
        id: 'chat_presence_expiry',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE INDEX chat_presence_expiry ON chat_presence_sessions USING btree (retain_until)',
        },
    },
    {
        kind: 'index',
        id: 'chat_presence_sessions_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX chat_presence_sessions_pkey ON chat_presence_sessions USING btree (email, session_id)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_read_receipts_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_chat_read_receipts_pkey ON project_chat_read_receipts USING btree (project_id, room_id, message_id, reader_email)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_typing_expiry',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_chat_typing_expiry ON project_chat_typing_sessions USING btree (retain_until)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_typing_room',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_chat_typing_room ON project_chat_typing_sessions USING btree (project_id, room_id, typing_until)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_typing_sessions_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_chat_typing_sessions_pkey ON project_chat_typing_sessions USING btree (email, session_id)',
        },
    },
    { kind: 'table', id: 'chat_presence_sessions', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_chat_read_receipts', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_chat_typing_sessions', definition: { kind: 'r', persistence: 'p' } },
];
