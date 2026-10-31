/** Frozen structural facts introduced by migration 8. */
export const CATALOG_REQUEST_SCHEMA_CONTRACT = [
    { kind: 'column', id: 'catalog_request_events.action', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'catalog_request_events.actor', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'catalog_request_events.comment',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_events.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_events.from_status',
        definition: { type: 'text', default: null, notNull: false },
    },
    { kind: 'column', id: 'catalog_request_events.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'catalog_request_events.request_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_events.revision',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_events.to_status',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_mutations.actor',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_mutations.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_mutations.request_hash',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_mutations.request_key',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'catalog_request_mutations.result',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    { kind: 'column', id: 'catalog_requests.asset_type', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'catalog_requests.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'catalog_requests.created_by', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'catalog_requests.description', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'catalog_requests.id', definition: { type: 'uuid', default: null, notNull: true } },
    { kind: 'column', id: 'catalog_requests.kind', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'catalog_requests.project_id', definition: { type: 'text', default: null, notNull: false } },
    {
        kind: 'column',
        id: 'catalog_requests.project_name',
        definition: { type: 'text', default: null, notNull: false },
    },
    { kind: 'column', id: 'catalog_requests.revision', definition: { type: 'integer', default: null, notNull: true } },
    { kind: 'column', id: 'catalog_requests.source_url', definition: { type: 'text', default: null, notNull: false } },
    { kind: 'column', id: 'catalog_requests.status', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'catalog_requests.target', definition: { type: 'jsonb', default: null, notNull: false } },
    { kind: 'column', id: 'catalog_requests.title', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'catalog_requests.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'constraint',
        id: 'catalog_request_events.catalog_request_events_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'catalog_request_events.catalog_request_events_request_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (request_id) REFERENCES catalog_requests(id)',
        },
    },
    {
        kind: 'constraint',
        id: 'catalog_request_events.catalog_request_events_request_id_revision_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (request_id, revision)' },
    },
    {
        kind: 'constraint',
        id: 'catalog_request_events.catalog_request_events_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'catalog_request_mutations.catalog_request_mutations_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (actor, request_key)' },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_asset_type_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (asset_type = ANY (ARRAY['plugin'::text, 'mcp'::text, 'skill'::text, 'model'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_check',
        definition: { type: 'c', validated: true, definition: 'CHECK ((project_id IS NULL) = (project_name IS NULL))' },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_description_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (length(description) >= 1 AND length(description) <= 10000)',
        },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_kind_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (kind = ANY (ARRAY['add'::text, 'update'::text, 'issue'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_status_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = ANY (ARRAY['submitted'::text, 'in_progress'::text, 'needs_info'::text, 'rejected'::text, 'completed'::text, 'cancelled'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_target_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (target IS NULL OR jsonb_typeof(target) = 'object'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'catalog_requests.catalog_requests_title_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (length(title) >= 1 AND length(title) <= 160)' },
    },
    {
        kind: 'index',
        id: 'catalog_request_events_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX catalog_request_events_pkey ON catalog_request_events USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'catalog_request_events_request_id_revision_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX catalog_request_events_request_id_revision_key ON catalog_request_events USING btree (request_id, revision)',
        },
    },
    {
        kind: 'index',
        id: 'catalog_request_mutations_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX catalog_request_mutations_pkey ON catalog_request_mutations USING btree (actor, request_key)',
        },
    },
    {
        kind: 'index',
        id: 'catalog_requests_author',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX catalog_requests_author ON catalog_requests USING btree (created_by, updated_at DESC, id)',
        },
    },
    {
        kind: 'index',
        id: 'catalog_requests_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX catalog_requests_pkey ON catalog_requests USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'catalog_requests_project',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX catalog_requests_project ON catalog_requests USING btree (project_id, status, updated_at DESC, id)',
        },
    },
    { kind: 'table', id: 'catalog_request_events', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'catalog_request_mutations', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'catalog_requests', definition: { kind: 'r', persistence: 'p' } },
] as const;
