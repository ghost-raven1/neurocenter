/** Per-computer consent, source lineage and auto-owned connections; provider secrets stay in the encrypted connection table. */
export const OPENCODE_MODEL_SYNC_SCHEMA_SQL = `
CREATE TABLE opencode_model_sync_settings (
 device_id TEXT PRIMARY KEY REFERENCES bridge_devices(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>0), enabled BOOLEAN NOT NULL DEFAULT true,
 transfer_credentials BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE opencode_model_sources (
 device_id TEXT NOT NULL REFERENCES bridge_devices(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL CHECK(source_key ~ '^[a-f0-9]{64}$'),
 provider TEXT NOT NULL, config_key TEXT NOT NULL, output_token_limit INTEGER CHECK(output_token_limit BETWEEN 1 AND 2097152), context_window INTEGER CHECK(context_window BETWEEN 128 AND 2097152), model_id TEXT REFERENCES model_catalog(id) ON DELETE RESTRICT,
 binding_id TEXT, instance_id UUID, scan_id UUID NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('present','disabled','blocked','missing')),
 credential_status TEXT NOT NULL CHECK(credential_status IN ('not-needed','pending','transferred','unavailable','manual')),
 checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((scope_key='global' AND project_id IS NULL AND binding_id IS NULL AND instance_id IS NULL) OR (project_id IS NOT NULL AND scope_key='project:'||project_id AND binding_id IS NOT NULL AND binding_id ~ '^[a-f0-9]{64}$' AND instance_id IS NOT NULL)), PRIMARY KEY(device_id,scope_key,source_key)
);
CREATE INDEX opencode_model_sources_model ON opencode_model_sources(model_id);
CREATE TABLE opencode_model_snapshots (
 device_id TEXT NOT NULL REFERENCES bridge_devices(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
 scan_id UUID NOT NULL, scan_digest TEXT NOT NULL CHECK(scan_digest ~ '^[a-f0-9]{64}$'),
 checked_at TIMESTAMPTZ NOT NULL,
 CHECK((scope_key='global' AND project_id IS NULL) OR (project_id IS NOT NULL AND scope_key='project:'||project_id)), PRIMARY KEY(device_id,scope_key)
);
CREATE TABLE opencode_managed_models (
 model_id TEXT PRIMARY KEY REFERENCES model_catalog(id) ON DELETE RESTRICT,
 device_id TEXT REFERENCES bridge_devices(id) ON DELETE SET NULL,
 source_key TEXT NOT NULL CHECK(source_key ~ '^[a-f0-9]{64}$'),
 descriptor_sha TEXT NOT NULL CHECK(descriptor_sha ~ '^[a-f0-9]{64}$'),
 connection_revision BIGINT NOT NULL CHECK(connection_revision>=0)
);
CREATE TABLE opencode_model_identities (
 identity_sha TEXT PRIMARY KEY CHECK(identity_sha ~ '^[a-f0-9]{64}$'),
 model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT
);
CREATE INDEX opencode_model_identities_model ON opencode_model_identities(model_id);
`;
