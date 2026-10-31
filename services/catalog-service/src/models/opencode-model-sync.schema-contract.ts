/** Frozen physical facts for migration 17. */
export const OPENCODE_MODEL_SYNC_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'opencode_managed_models.connection_revision',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_managed_models.descriptor_sha',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_managed_models.device_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'opencode_managed_models.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_managed_models.source_key',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_identities.identity_sha',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_identities.model_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_snapshots.checked_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_snapshots.device_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_snapshots.project_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'opencode_model_snapshots.scan_digest',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_snapshots.scan_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_snapshots.scope_key',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.binding_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.checked_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.config_key',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.context_window',
        definition: { type: 'integer', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.credential_status',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.device_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.instance_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.model_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.output_token_limit',
        definition: { type: 'integer', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.project_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.provider',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.scan_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.scope_key',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sources.source_key',
        definition: { type: 'text', default: null, notNull: true },
    },
    { kind: 'column', id: 'opencode_model_sources.state', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'opencode_model_sync_settings.device_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sync_settings.enabled',
        definition: { type: 'boolean', default: 'true', notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sync_settings.revision',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sync_settings.transfer_credentials',
        definition: { type: 'boolean', default: 'false', notNull: true },
    },
    {
        kind: 'column',
        id: 'opencode_model_sync_settings.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'constraint',
        id: 'opencode_managed_models.opencode_managed_models_connection_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (connection_revision >= 0)' },
    },
    {
        kind: 'constraint',
        id: 'opencode_managed_models.opencode_managed_models_descriptor_sha_check',
        definition: { type: 'c', validated: true, definition: "CHECK (descriptor_sha ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'opencode_managed_models.opencode_managed_models_device_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (device_id) REFERENCES bridge_devices(id) ON DELETE SET NULL',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_managed_models.opencode_managed_models_model_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE RESTRICT',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_managed_models.opencode_managed_models_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (model_id)' },
    },
    {
        kind: 'constraint',
        id: 'opencode_managed_models.opencode_managed_models_source_key_check',
        definition: { type: 'c', validated: true, definition: "CHECK (source_key ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_identities.opencode_model_identities_identity_sha_check',
        definition: { type: 'c', validated: true, definition: "CHECK (identity_sha ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_identities.opencode_model_identities_model_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE RESTRICT',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_identities.opencode_model_identities_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (identity_sha)' },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_snapshots.opencode_model_snapshots_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (scope_key = 'global'::text AND project_id IS NULL OR project_id IS NOT NULL AND scope_key = ('project:'::text || project_id))",
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_snapshots.opencode_model_snapshots_device_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (device_id) REFERENCES bridge_devices(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_snapshots.opencode_model_snapshots_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (device_id, scope_key)' },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_snapshots.opencode_model_snapshots_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_snapshots.opencode_model_snapshots_scan_digest_check',
        definition: { type: 'c', validated: true, definition: "CHECK (scan_digest ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (scope_key = 'global'::text AND project_id IS NULL AND binding_id IS NULL AND instance_id IS NULL OR project_id IS NOT NULL AND scope_key = ('project:'::text || project_id) AND binding_id IS NOT NULL AND binding_id ~ '^[a-f0-9]{64}$'::text AND instance_id IS NOT NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_context_window_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (context_window >= 128 AND context_window <= 2097152)',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_credential_status_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (credential_status = ANY (ARRAY['not-needed'::text, 'pending'::text, 'transferred'::text, 'unavailable'::text, 'manual'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_device_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (device_id) REFERENCES bridge_devices(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_model_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE RESTRICT',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_output_token_limit_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (output_token_limit >= 1 AND output_token_limit <= 2097152)',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (device_id, scope_key, source_key)' },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_source_key_check',
        definition: { type: 'c', validated: true, definition: "CHECK (source_key ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sources.opencode_model_sources_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (state = ANY (ARRAY['present'::text, 'disabled'::text, 'blocked'::text, 'missing'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sync_settings.opencode_model_sync_settings_device_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (device_id) REFERENCES bridge_devices(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sync_settings.opencode_model_sync_settings_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (device_id)' },
    },
    {
        kind: 'constraint',
        id: 'opencode_model_sync_settings.opencode_model_sync_settings_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'index',
        id: 'opencode_managed_models_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX opencode_managed_models_pkey ON opencode_managed_models USING btree (model_id)',
        },
    },
    {
        kind: 'index',
        id: 'opencode_model_identities_model',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX opencode_model_identities_model ON opencode_model_identities USING btree (model_id)',
        },
    },
    {
        kind: 'index',
        id: 'opencode_model_identities_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX opencode_model_identities_pkey ON opencode_model_identities USING btree (identity_sha)',
        },
    },
    {
        kind: 'index',
        id: 'opencode_model_snapshots_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX opencode_model_snapshots_pkey ON opencode_model_snapshots USING btree (device_id, scope_key)',
        },
    },
    {
        kind: 'index',
        id: 'opencode_model_sources_model',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE INDEX opencode_model_sources_model ON opencode_model_sources USING btree (model_id)',
        },
    },
    {
        kind: 'index',
        id: 'opencode_model_sources_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX opencode_model_sources_pkey ON opencode_model_sources USING btree (device_id, scope_key, source_key)',
        },
    },
    {
        kind: 'index',
        id: 'opencode_model_sync_settings_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX opencode_model_sync_settings_pkey ON opencode_model_sync_settings USING btree (device_id)',
        },
    },
    { kind: 'table', id: 'opencode_managed_models', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'opencode_model_identities', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'opencode_model_snapshots', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'opencode_model_sources', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'opencode_model_sync_settings', definition: { kind: 'r', persistence: 'p' } },
];
