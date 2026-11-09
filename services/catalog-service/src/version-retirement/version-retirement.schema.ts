/**
 * Entry 2.7 (AD-16, FR-204): version-level retirement of catalog versions.
 *
 * `status TEXT NOT NULL DEFAULT 'active'` is added to `ai_plugin_versions` (one column
 * covers every kind published through `ai_plugins`) and `model_catalog_versions`
 * (kind=model keeps its own table). Retirement is irreversible: the CHECK constraint
 * admits only `active`/`retired`, the retire endpoint rejects repeat retirement, and
 * the version row plus artifact bytes are preserved (provenance, FR-204).
 * Additive version-neutral SQL; ROOT owns contiguous migration registration.
 */
export const VERSION_RETIREMENT_SCHEMA_SQL = `
ALTER TABLE ai_plugin_versions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE ai_plugin_versions ADD CONSTRAINT ai_plugin_versions_status_check CHECK (status IN ('active','retired'));
ALTER TABLE model_catalog_versions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE model_catalog_versions ADD CONSTRAINT model_catalog_versions_status_check CHECK (status IN ('active','retired'));
`;
