/** Frozen structural facts introduced by migration 7. */
export const AGENT_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'agent_catalog_versions.agent_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'agent_catalog_versions.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'agent_catalog_versions.definition',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'agent_catalog_versions.manifest',
        definition: { type: 'text', default: null, notNull: true },
    },
    { kind: 'column', id: 'agent_catalog_versions.name', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'agent_catalog_versions.slug', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'agent_catalog_versions.version',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'agent_catalog.archived_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'agent_catalog.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'agent_catalog.definition', definition: { type: 'jsonb', default: null, notNull: true } },
    { kind: 'column', id: 'agent_catalog.id', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'agent_catalog.manifest', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'agent_catalog.name', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'agent_catalog.slug', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'agent_catalog.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'agent_catalog.version', definition: { type: 'integer', default: null, notNull: true } },
    { kind: 'column', id: 'agent_mutation_requests.actor', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'agent_mutation_requests.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'agent_mutation_requests.request_hash',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'agent_mutation_requests.request_key',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'agent_mutation_requests.result',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    { kind: 'column', id: 'project_agent_sets.project_id', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'project_agent_sets.revision', definition: { type: 'integer', default: '0', notNull: true } },
    {
        kind: 'column',
        id: 'project_agent_sets.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_agents.added_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'project_agents.added_by', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'project_agents.agent_id', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'project_agents.enabled', definition: { type: 'boolean', default: 'false', notNull: true } },
    { kind: 'column', id: 'project_agents.manifest', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'project_agents.overrides',
        definition: { type: 'jsonb', default: "'{}'::jsonb", notNull: true },
    },
    { kind: 'column', id: 'project_agents.project_id', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'project_agents.removed', definition: { type: 'boolean', default: 'false', notNull: true } },
    {
        kind: 'column',
        id: 'project_agents.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'project_agents.updated_by', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'project_agents.version', definition: { type: 'integer', default: null, notNull: true } },
    {
        kind: 'constraint',
        id: 'agent_catalog_versions.agent_catalog_versions_agent_id_fkey',
        definition: { type: 'f', validated: true, definition: 'FOREIGN KEY (agent_id) REFERENCES agent_catalog(id)' },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog_versions.agent_catalog_versions_agent_id_version_manifest_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (agent_id, version, manifest)' },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog_versions.agent_catalog_versions_definition_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(definition) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog_versions.agent_catalog_versions_manifest_check',
        definition: { type: 'c', validated: true, definition: "CHECK (manifest ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog_versions.agent_catalog_versions_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (agent_id, version)' },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog_versions.agent_catalog_versions_version_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (version > 0)' },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog.agent_catalog_definition_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(definition) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog.agent_catalog_manifest_check',
        definition: { type: 'c', validated: true, definition: "CHECK (manifest ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog.agent_catalog_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog.agent_catalog_slug_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (slug)' },
    },
    {
        kind: 'constraint',
        id: 'agent_catalog.agent_catalog_version_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (version > 0)' },
    },
    {
        kind: 'constraint',
        id: 'agent_mutation_requests.agent_mutation_requests_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (actor, request_key)' },
    },
    {
        kind: 'constraint',
        id: 'project_agent_sets.project_agent_sets_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (project_id)' },
    },
    {
        kind: 'constraint',
        id: 'project_agent_sets.project_agent_sets_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_agent_sets.project_agent_sets_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision >= 0)' },
    },
    {
        kind: 'constraint',
        id: 'project_agents.project_agents_agent_id_version_manifest_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (agent_id, version, manifest) REFERENCES agent_catalog_versions(agent_id, version, manifest)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_agents.project_agents_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (NOT removed OR NOT enabled)' },
    },
    {
        kind: 'constraint',
        id: 'project_agents.project_agents_overrides_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(overrides) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_agents.project_agents_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (project_id, agent_id)' },
    },
    {
        kind: 'constraint',
        id: 'project_agents.project_agents_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_agent_sets(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'function',
        id: 'neurocenter_agent_version_immutable()',
        definition: { definitionMd5: 'b0c5b56efd6bfbb5800b69b50f556ff0' },
    },
    {
        kind: 'index',
        id: 'agent_catalog_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX agent_catalog_pkey ON agent_catalog USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'agent_catalog_slug_key',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX agent_catalog_slug_key ON agent_catalog USING btree (slug)',
        },
    },
    {
        kind: 'index',
        id: 'agent_catalog_versions_agent_id_version_manifest_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX agent_catalog_versions_agent_id_version_manifest_key ON agent_catalog_versions USING btree (agent_id, version, manifest)',
        },
    },
    {
        kind: 'index',
        id: 'agent_catalog_versions_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX agent_catalog_versions_pkey ON agent_catalog_versions USING btree (agent_id, version)',
        },
    },
    {
        kind: 'index',
        id: 'agent_mutation_requests_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX agent_mutation_requests_pkey ON agent_mutation_requests USING btree (actor, request_key)',
        },
    },
    {
        kind: 'index',
        id: 'project_agent_sets_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX project_agent_sets_pkey ON project_agent_sets USING btree (project_id)',
        },
    },
    {
        kind: 'index',
        id: 'project_agents_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX project_agents_pkey ON project_agents USING btree (project_id, agent_id)',
        },
    },
    { kind: 'table', id: 'agent_catalog', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'agent_catalog_versions', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'agent_mutation_requests', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_agent_sets', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_agents', definition: { kind: 'r', persistence: 'p' } },
    {
        kind: 'trigger',
        id: 'agent_catalog_versions.neurocenter_agent_version_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_agent_version_immutable BEFORE DELETE OR UPDATE ON agent_catalog_versions FOR EACH ROW EXECUTE FUNCTION neurocenter_agent_version_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_agent_sets.neurocenter_retired_reference_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON project_agent_sets FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_agents.neurocenter_retired_reference_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON project_agents FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard()',
        },
    },
] as const;
