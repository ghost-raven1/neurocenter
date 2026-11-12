import { CURRENT_PROJECT_CHAT_ISOLATION_SCHEMA_CONTRACT } from './project-chat-isolation.schema-contract';

/** Migration57 physical facts measured on the owned PostgreSQL16.14 QA instance. */
export const PROJECT_CHAT_SHARED_SCHEMA_CONTRACT = [
    {
        kind: 'table',
        id: 'project_chat_shared_items',
        definition: { kind: 'r', persistence: 'p' },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.room_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.item_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.kind',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.content',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.ref_message_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.source_room_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.source_agent_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.source_agent_name',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.source_generation',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.content_sha',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_chat_shared_items.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'constraint',
        id: 'project_chat_shared_items.project_chat_shared_items_content_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (octet_length(content) >= 1 AND octet_length(content) <= 8388608)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_shared_items.project_chat_shared_items_content_sha_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (content_sha ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_shared_items.project_chat_shared_items_kind_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (kind = ANY (ARRAY['state'::text, 'result'::text, 'decision'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_shared_items.project_chat_shared_items_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (project_id, room_id, item_id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_shared_items.project_chat_shared_items_project_id_room_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, room_id) REFERENCES project_chat_rooms(project_id, id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_shared_items.project_chat_shared_items_source_agent_id_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (length(source_agent_id) >= 1 AND length(source_agent_id) <= 200)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_shared_items_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_chat_shared_items_pkey ON project_chat_shared_items USING btree (project_id, room_id, item_id)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_shared_items_room',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_chat_shared_items_room ON project_chat_shared_items USING btree (project_id, room_id, created_at DESC)',
        },
    },
    {
        kind: 'function',
        id: 'neurocenter_project_chat_shared_item_immutable()',
        definition: { definitionMd5: '25b686f425a81ac780afc37f2d0557ac' },
    },
    {
        kind: 'trigger',
        id: 'project_chat_shared_items.project_chat_shared_item_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER project_chat_shared_item_immutable BEFORE UPDATE ON project_chat_shared_items FOR EACH ROW EXECUTE FUNCTION neurocenter_project_chat_shared_item_immutable()',
        },
    },
];

export const CURRENT_PROJECT_CHAT_SHARED_SCHEMA_CONTRACT = [
    ...CURRENT_PROJECT_CHAT_ISOLATION_SCHEMA_CONTRACT,
    ...PROJECT_CHAT_SHARED_SCHEMA_CONTRACT,
];
